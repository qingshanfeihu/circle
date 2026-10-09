import { QuestionCard } from '../ink/components/question_card.js';
import { ApprovalCard } from '../ink/components/approval_card.js';
import { SecretCard } from '../ink/components/secret_card.js';
import type { Card } from '../ink/components/dialog_card.js';
import { approvalRequest } from './approval_preview.js';
import type { Question } from '../questions.js';
import {
  submitAnswer,
  cancelRequest,
  listPending,
  type SecretRequest,
} from '../secret_prompt.js';
import { execFile, spawn } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AgentRuntime, type RuntimeOptions } from '../runtime.js';
import type { CircleSettings } from '../settings.js';
import {
  applyProjectSettings,
  saveCredentials,
  saveSettings,
  saveSettingsChange,
  loadCredentials,
  trustFolder,
  isFolderTrusted,
  withConnection,
} from '../settings.js';
import { resolveEndpoint } from '../probe.js';
import { SetupCard, SetupFlow } from './setup_flow.js';
import { InputParser, type InputEvent } from '../ink/parse_keypress.js';
import { ThemeWatch } from '../ink/theme_watch.js';
import { palette } from '../ink/theme.js';
import {
  Picker,
  type PickerItem,
  type PickerOptions,
} from '../ink/components/picker.js';
import { welcomeRows } from '../ink/components/welcome.js';
import { renderScreen, transcriptRows, type ScreenState } from './render.js';
import { InputHistory } from './input_history.js';
import { Composer } from './composer.js';
import { TranscriptFind } from './transcript_find.js';
import { InteractionQueue, ParkedDraft } from './interaction_queue.js';
import { installExitGuard } from '../exit_guard.js';
import {
  CompactionProgress,
  compactionDone,
  type CompactionEvent,
} from '../compaction.js';
import { formatCosts } from '../pricing.js';
import { SubagentNavigation } from './subagents.js';
import { TurnStatus } from './turn_status.js';
import { WelcomeState } from './welcome_state.js';
import { windowTitle } from './status_rows.js';
import { loadRemap } from '../keybindings.js';
import { emptyUsage, type ToolCall } from '../types.js';
import { ScreenRenderer } from '../ink/screen.js';
import { Clipboard } from '../ink/clipboard.js';
import { MouseSelection } from './mouse_selection.js';
import { type ApprovalDecision } from '../harness.js';
import {
  BUILTIN_SLASH,
  closeMatch,
  commandWord,
  knownSlashNames,
  parseSlash,
} from './slash_commands.js';
import {
  cycleThinking,
  endpointName,
  runCommand,
  type CommandHost,
} from './slash_handlers.js';
import { UndoHistory, type ScreenSnapshot } from './undo_history.js';
import { editorCommand } from './external_editor.js';
import { GatewayModel } from '../model.js';
import { discoverCustomCommands } from '../commands.js';
import { complete } from '../mentions.js';
import { VERSION } from '../version.js';
import {
  availableUpdate,
  updateCheckEnabled,
  updateNotice,
} from '../update.js';
import { PlanPanel } from '../ink/components/plan_panel.js';
import { stripAnsi } from '../ink/string_width.js';
import { modelScope } from '../model_scope.js';
import { resumeHint, runningJobs, stoppedJobsLine } from './exit_lines.js';
export { VERSION } from '../version.js';
interface DialogPending {
  complete: (answer: unknown) => void;
  abort?: () => void;
}
export class SessionApp {
  private plan = new PlanPanel();
  private knownModels?: string[];
  private knownModelsEndpoint = '';
  private runScopeOnly?: boolean;
  runtime?: AgentRuntime;
  readonly state: ScreenState;
  private input = new InputParser((event) => this.handle(event));
  private screen = new ScreenRenderer((text) => process.stdout.write(text));
  private theme: ThemeWatch;
  private remap: Record<string, string>;
  private pending?: DialogPending;
  private card?: Card<unknown>;
  private parked = new ParkedDraft();
  private secretReady?: SecretRequest;
  private ended = false;
  private closing?: Promise<void>;
  private externalEditor = false;
  private animation?: NodeJS.Timeout;
  private flashTimer?: NodeJS.Timeout;
  private keyProblems: string[];
  private done!: (code: number) => void;
  private completion: Promise<number>;
  private previousSession = '';
  private lastEscape = 0;
  private lastCtrlC = 0;
  // /login while its lists are open: the answers so far.
  private loginFlow?: SetupFlow;
  // The /jobs list while it is open, with its rows: it follows the jobs as they change.
  private jobsList?: { list: Picker; rows: () => PickerItem[] };
  // After /undo or /redo, the answer whose request the footer's ctx no longer describes.
  private meterCleared?: string;
  private history: InputHistory;
  private composer: Composer;
  private commandList?: Map<string, string>;
  private off?: () => void;
  private offSignals?: () => void;
  private jobWakeAt = 0;
  private jobWakeCount = 0;
  private jobWakeSnoozed = false;
  // As in 0.5.0, a background agent's card shows whether a turn runs or not: after the
  // turn's own cards (the queue takes those first) and once typing pauses.
  private interactions = new InteractionQueue(
    () => !this.externalEditor && !this.state.dialog,
    () => Boolean(this.state.draft || this.state.picker),
  );
  private backgroundCard = false;
  private agents = new SubagentNavigation();
  private agentActivity = new Map<
    string,
    {
      state: 'running' | 'waiting' | 'done' | 'error';
      name: string;
      background?: boolean;
    }
  >();
  private frameRows: string[] = [];
  // The terminal's and the system's clipboard; tests put their own in its place.
  clipboard = new Clipboard();
  private selection = new MouseSelection({
    scroll: (delta) => this.scrollTranscript(delta),
    copy: (text) => this.copySelection(text),
    repaint: () => this.repaint(),
  });
  private shared?: string;
  private turns = new TurnStatus();
  private welcomeState: WelcomeState;
  // The runtime is loading the folder's things (attach): the welcome's lamps blink.
  private connecting = false;
  // Setup asks before a session: the welcome shows no model until one is saved.
  private settingUp = false;
  private started = false;
  private title = '';
  private titleAt = 0;
  private undo = new UndoHistory();
  private dataListener = (data: string): void => {
    if (this.externalEditor) return;
    for (const event of this.input.feed(data)) this.handle(event);
  };
  private resizeListener = (): void => this.repaint();
  // The terminal and the process as lending the screen out uses them (ctrl+z to the shell,
  // /editor to $EDITOR). Tests put their own in place.
  terminal = {
    platform: process.platform as NodeJS.Platform,
    write: (text: string): void => {
      process.stdout.write(text);
    },
    // on: Circle reads the keys, raw; off: the shell or the editor has them, in line mode.
    input: (on: boolean): void => {
      if (on) {
        process.stdin.setRawMode(true);
        process.stdin.resume();
        process.stdin.on('data', this.dataListener);
      } else {
        process.stdin.off('data', this.dataListener);
        process.stdin.pause();
        process.stdin.setRawMode(false);
      }
    },
    kill: (signal: NodeJS.Signals): void => {
      process.kill(process.pid, signal);
    },
  };
  private signalListener = (): void => {
    if (this.externalEditor) return;
    if (this.backgroundCard) return;
    this.jobWakeSnoozed = true;
    if (this.runtime?.busy) void this.runtime.cancel();
    else this.exit(0);
  };
  constructor(
    readonly workspace: string,
    readonly home: string,
    public settings: CircleSettings,
  ) {
    const keys = loadRemap(home);
    this.remap = keys.remap;
    this.keyProblems = keys.problems;
    this.state = {
      messages: [],
      notices: [],
      welcome: [],
      draft: '',
      draftCursor: 0,
      model: settings.auth.model || '',
      workspace,
      version: VERSION,
      busy: false,
      waiting: false,
      planMode: false,
      autoMode: false,
      todos: [],
      showThinking: !settings.hide_thinking,
      showTools: false,
      streaming: '',
      thinking: '',
      usage: emptyUsage(),
      flash: '',
      started: Date.now(),
      scroll: 0,
      hiddenTurns: 0,
    };
    this.theme = new ThemeWatch(
      settings.theme,
      (text) => {
        if (!this.externalEditor) process.stdout.write(text);
      },
      (flip) => (flip ? this.flash(`Theme → ${flip}`) : this.repaint()),
    );
    this.completion = new Promise((resolve) => {
      this.done = resolve;
    });
    this.history = InputHistory.forHome(home);
    this.composer = new Composer(this.state, {
      history: this.history,
      columns: () => process.stdout.columns || 80,
      viewRows: () =>
        this.state.view?.rows ?? Math.max(1, (process.stdout.rows || 24) - 8),
      scroll: (rows) => {
        const top = this.state.view?.maxScroll ?? Number.MAX_SAFE_INTEGER;
        this.state.scroll =
          rows === 'top'
            ? top
            : rows === 'bottom'
              ? 0
              : Math.max(0, Math.min(top, this.state.scroll + rows));
      },
      send: (kind) => this.send(kind),
      command: (name) =>
        void this.command(name, '').catch((error) => this.fail(error)),
      flash: (text) => this.flash(text),
      commands: () => this.completionCommands(),
      files: (partial, limit) => complete(partial, this.workspace, limit),
    });
    this.welcomeState = new WelcomeState(workspace);
  }
  start(): void {
    process.stdin.setRawMode(true);
    process.stdin.setEncoding('utf8');
    process.stdin.resume();
    process.stdin.on('data', this.dataListener);
    process.stdout.on('resize', this.resizeListener);
    process.on('SIGINT', this.signalListener);
    // The terminal keeps the title it had, to give back on close (xterm's title stack).
    process.stdout.write(
      '\x1b[22;0t\x1b[?1049h\x1b[?25l\x1b[?2004h\x1b[?1000h\x1b[?1002h\x1b[?1006h',
    );
    this.started = true;
    this.theme.start();
    this.animation = setInterval(() => {
      if (
        this.state.busy ||
        this.state.waiting ||
        this.runtime?.jobs.list().some((job) => job.status === 'running') ||
        this.state.jobDetail ||
        this.state.agentDetail ||
        this.connecting
      )
        this.repaint();
      this.wakeJobs();
    }, 160);
    this.repaint();
  }
  private repaint(): void {
    // A repaint can come from work that settles after leaving (a stopped job, a late reply):
    // the session store may be closed by then.
    if (this.ended || this.externalEditor || this.runtime?.isClosing) return;
    if (this.runtime) {
      this.state.messages = this.undo.visible(this.runtime.harness.messages);
      this.state.userShells = this.runtime.userShells.views.filter(
        (shell) => shell.sessionId === this.runtime!.session.id,
      );
      this.state.todos = this.runtime.todos;
      this.plan.update(this.state.todos);
      this.state.planStart = this.plan.start;
      this.state.queue = this.runtime.harness.queuedMessages;
      this.state.model = this.runtime.harness.model.model;
      this.state.planMode = this.runtime.harness.planMode;
      this.state.autoMode = this.runtime.policy.yoloEnabled(
        this.runtime.session.id,
      );
      this.state.busy = this.runtime.busy;
      const stats = this.runtime.stats();
      this.state.usage = stats.usage;
      const facts =
        this.runtime.harness.model.modelFacts ??
        this.runtime.catalog.facts(
          this.runtime.harness.model.model,
          this.runtime.options.settings,
          this.runtime.harness.model.contextWindow,
        );
      this.state.contextWindow = facts.windowKnown
        ? facts.contextWindow
        : undefined;
      const lastAnswer = this.runtime.harness.messages
        .filter((message) => message.role === 'assistant' && message.usage)
        .at(-1);
      this.state.contextInput =
        !lastAnswer?.request_model ||
        lastAnswer.request_model === this.runtime.harness.model.model
          ? lastAnswer?.usage?.input_tokens
          : undefined;
      // After /undo or /redo the meter is unknown until the next answer, as in 0.5.0.
      if (this.meterCleared !== undefined) {
        if ((lastAnswer?.id ?? '') === this.meterCleared)
          this.state.contextInput = undefined;
        else this.meterCleared = undefined;
      }
      this.state.costText = formatCosts(
        [stats.costs],
        facts.rates?.input !== undefined && facts.rates.output !== undefined,
      );
      this.state.jobs = this.runtime.jobs.list();
      const collect = (
        parent: string,
      ): import('../checkpoint_store.js').Session[] =>
        this.runtime!.store.children(parent).flatMap((child) => [
          child,
          ...collect(child.id),
        ]);
      this.state.subagents = collect(this.runtime.session.id).map((session) => {
        const activity = this.agentActivity.get(session.id);
        const messages = this.runtime!.store.messages(session.id);
        const last = messages.at(-1);
        return {
          id: session.id,
          name: activity?.name || session.title.split(':')[0] || 'subagent',
          description: session.title,
          background: activity?.background,
          messages,
          state:
            activity?.state ??
            (last?.role === 'assistant' && !last.tool_calls?.length
              ? 'done'
              : 'interrupted'),
          started: session.created,
          updated: session.updated,
          tokens: messages.reduce(
            (sum, message) =>
              sum +
              (message.usage?.input_tokens ?? 0) +
              (message.usage?.output_tokens ?? 0),
            0,
          ),
        };
      });
      this.state.selectedAgent = this.agents.selected;
      this.state.agentDetail = this.state.subagents.find(
        (agent) => agent.id === this.agents.detail,
      );
      if (this.state.jobDetail)
        this.state.jobDetail = this.runtime.jobs.get(this.state.jobDetail.id);
      this.state.renderToolResult = (message) => {
        const renderer = this.runtime!.extensions.renderer(message.name || '');
        if (!renderer) return undefined;
        try {
          const rows = renderer({
            tool_name: message.name,
            tool_call_id: message.tool_call_id,
            status: message.status,
            output: message.content,
            content: message.content,
          });
          if (
            !Array.isArray(rows) ||
            !rows.every((row) => typeof row === 'string')
          )
            throw new Error('renderer must return text lines');
          return rows;
        } catch (error) {
          const note =
            '✖ Extension renderer failed: ' +
            (error instanceof Error ? error.message : String(error));
          if (!this.state.notices.includes(note)) this.state.notices.push(note);
          return undefined;
        }
      };
    }
    this.syncStatus();
    const rows = renderScreen(
      this.state,
      process.stdout.columns || 80,
      process.stdout.rows || 24,
    );
    this.frameRows = rows;
    this.screen.render(this.selection.frame(rows, this.state));
  }
  // The header, the welcome and the window title follow the session.
  private syncStatus(): void {
    const trusted = isFolderTrusted(this.settings, this.workspace);
    this.state.gate = !this.runtime && Boolean(this.state.dialog);
    this.state.connected = Boolean(this.runtime) && !this.connecting;
    this.state.branch = this.welcomeState.branch();
    this.state.thinkingDepth = this.runtime?.thinkingLevel;
    this.turns.fill(this.state);
    this.state.welcome = welcomeRows(
      process.stdout.columns || 80,
      this.welcomeState.info({
        version: VERSION,
        settings: this.settings,
        runtime: this.runtime,
        connected: this.state.connected,
        trusted,
        settingUp: this.settingUp,
      }),
    );
    if (!this.started || Date.now() - this.titleAt < 1000) return;
    this.titleAt = Date.now();
    const runtime = this.runtime;
    const title = windowTitle(
      (runtime && runtime.store.get(runtime.session.id)?.title) || '',
      this.workspace,
    );
    if (title !== this.title) {
      this.title = title;
      process.stdout.write(`\x1b]0;${title}\x07`);
    }
  }
  private flash(text: string, ttl = 1800): void {
    this.state.flash = text;
    if (this.flashTimer) clearTimeout(this.flashTimer);
    this.flashTimer = setTimeout(() => {
      this.state.flash = '';
      this.repaint();
    }, ttl);
    this.repaint();
  }
  private notice(text: string): void {
    this.state.notices.push(text);
    this.repaint();
  }
  private fail(error: unknown): void {
    this.notice(
      '✖ ' + (error instanceof Error ? error.message : String(error)),
    );
  }
  private setDraft(text: string): void {
    this.composer.set(text);
    this.state.completion = undefined;
  }
  async initialize(force = false): Promise<boolean> {
    if (force || !this.settings.initialized) {
      this.settingUp = !this.runtime;
      // One card, a step at a time; it says what Circle is doing while the endpoint lists
      // its models, and is drawn again when it has answered.
      const flow = new SetupFlow(this.home);
      const card = new SetupCard(flow);
      card.changed = () => {
        if (this.card !== card) return;
        this.state.dialog = card.state();
        this.repaint();
      };
      const answer = await this.showCard(card);
      if (this.ended || answer !== 'done') return false;
      this.saveConnection(flow);
      this.settingUp = false;
    }
    if (!isFolderTrusted(this.settings, this.workspace)) {
      const answer = await this.askChoice(
        'trust',
        `${this.workspace}\nThis folder can supply instructions, skills, commands and extensions. Extensions execute code.`,
        ['trust this folder', 'quit'],
      );
      if (answer !== 'trust this folder') return false;
      this.trustWorkspace();
    }
    return !this.ended;
  }
  // The URL that answered (`<url>/v1` when only that lists models), as line-mode setup and
  // 0.5.0 save it; the typed one when nothing answered.
  private saveConnection(flow: SetupFlow): void {
    const settings = withConnection(flow.auth(), this.home);
    saveCredentials({ api_key: flow.apiKey }, this.home);
    saveSettings(settings, this.home);
    this.settings = settings;
  }
  private trustWorkspace(): void {
    this.settings = trustFolder(this.settings, this.workspace);
    saveSettingsChange(this.home, (saved) => {
      saved.trusted_folders = trustFolder(
        saved,
        this.workspace,
      ).trusted_folders;
    });
  }
  // Once a day, whether a newer release exists; if so, one line stays in the transcript.
  async checkForUpdate(latest?: () => Promise<string>): Promise<void> {
    if (!updateCheckEnabled(this.settings)) return;
    const found = await availableUpdate(this.home, VERSION, latest);
    if (found && !this.ended) this.notice(updateNotice(found));
  }
  // The project's .circle/settings.json and `--model` over the saved settings, in memory only.
  // Runs once the folder is trusted, as the Python releases did.
  applyRunSettings(modelOverride?: string): void {
    const { problems } = applyProjectSettings(
      this.settings,
      this.workspace,
      this.home,
    );
    if (modelOverride) this.settings.auth.model = modelOverride;
    for (const problem of [...this.keyProblems, ...problems])
      this.fail(problem);
    this.keyProblems = [];
    this.state.model = this.settings.auth.model;
    this.state.showThinking = !this.settings.hide_thinking;
    if (this.theme.mode !== this.settings.theme) {
      this.theme.mode = this.settings.theme;
      this.theme.apply();
    }
  }
  async attach(
    options: Omit<RuntimeOptions, 'approve' | 'question'>,
  ): Promise<void> {
    this.connecting = true;
    this.runtime = new AgentRuntime({
      ...options,
      settings: this.settings,
      ...this.cardHooks(),
    });
    this.offSignals?.();
    this.offSignals = installExitGuard(this.runtime, (code) => {
      void this.close().then(
        () => process.exit(code),
        () => process.exit(code),
      );
    });
    this.off = this.runtime.bus.subscribe((event) => {
      this.turns.apply(event, () => this.runtime?.harness.messages.at(-1)?.id);
      if (event.kind === 'compaction') {
        const progress = event.payload as unknown as CompactionEvent;
        if (progress.sessionId === this.runtime?.session.id) {
          if (progress.phase === 'start')
            this.state.compaction = new CompactionProgress(progress.trigger);
          this.state.compaction?.apply(progress);
          if (progress.phase === 'done') {
            this.state.compaction = undefined;
            this.notice(compactionDone(progress));
          }
          if (progress.phase === 'error') this.state.compaction = undefined;
        }
      }
      if (event.kind === 'job_ended') this.jobWakeAt = Date.now() + 1000;
      if (['job_started', 'job_updated', 'job_ended'].includes(event.kind))
        this.refreshJobsList();
      if (event.tags.subagent) {
        const id = String(event.tags.subagent);
        const old = this.agentActivity.get(id);
        const state =
          event.kind === 'run_end'
            ? 'done'
            : event.kind === 'run_error'
              ? 'error'
              : event.kind === 'tool_waiting'
                ? 'waiting'
                : event.kind === 'tool_start' ||
                    event.kind === 'llm_start' ||
                    event.kind === 'run_start'
                  ? 'running'
                  : (old?.state ?? 'running');
        this.agentActivity.set(id, {
          state,
          name: String(event.tags.name || old?.name || 'subagent'),
          background: Boolean(event.tags.job_id) || old?.background,
        });
        if (event.kind === 'llm_end')
          for (const key of Object.keys(
            this.state.usage,
          ) as (keyof typeof this.state.usage)[])
            this.state.usage[key] += event.usage?.[key] ?? 0;
        this.repaint();
        return;
      }
      if (event.kind === 'run_start') {
        this.plan.follow();
        this.state.started = Date.now();
        this.undo.push(this.screenBefore(event.payload.message));
        this.state.scroll = 0;
      } else if (event.kind === 'llm_start') {
        this.state.streaming = '';
        this.state.thinking = '';
      } else if (event.kind === 'llm_token') {
        if (event.payload.thinking)
          this.state.thinking += String(event.payload.text);
        else this.state.streaming += String(event.payload.text);
      } else if (event.kind === 'llm_end') {
        this.state.streaming = '';
        this.state.thinking = '';
        for (const key of Object.keys(
          this.state.usage,
        ) as (keyof typeof this.state.usage)[])
          this.state.usage[key] += event.usage?.[key] ?? 0;
      } else if (event.kind === 'run_error')
        // A key the endpoint turned down (401, 403) says where to change it, as in 0.5.0.
        this.state.notices.push(
          '✖ ' +
            String(event.payload.message) +
            ([401, 403].includes(Number(event.payload.status))
              ? ' · /login to change the key'
              : ''),
        );
      else if (event.kind === 'info' && event.payload.model_notice) {
        const notice = event.payload.model_notice as {
          event: string;
          [key: string]: unknown;
        };
        if (notice.event === 'retry')
          this.flash(
            `Retry ${notice.attempt}/${notice.max} in ${(Number(notice.wait_ms) / 1000).toFixed(1)}s`,
          );
        else if (notice.event === 'param_dropped')
          this.notice(
            `Endpoint does not support ${notice.param}; continuing without it`,
          );
        else if (
          ['repeat_retry', 'stall_retry', 'missing_finish_retry'].includes(
            notice.event,
          )
        ) {
          this.state.streaming = '';
          this.state.thinking = '';
          this.flash('Retrying model request');
        } else if (notice.event === 'output_budget_exhausted')
          this.notice('✖ Model output budget exhausted before an answer');
        else if (notice.event === 'missing_finish' && notice.truncated)
          this.notice('Model response may be truncated');
        else if (notice.event === 'repetition_stopped')
          this.notice('Model output was repeating; stopped the stream');
      }
      this.repaint();
    });
    try {
      await this.runtime.initialize();
    } finally {
      this.connecting = false;
    }
    for (const error of this.runtime.migration.errors)
      this.fail(
        `Could not migrate ${error.thread || 'legacy data'}: ${error.message}`,
      );
    this.repaint();
  }
  private wakeJobs(): void {
    const runtime = this.runtime;
    if (
      !runtime ||
      this.ended ||
      this.jobWakeSnoozed ||
      this.jobWakeCount >= 10 ||
      runtime.busy ||
      this.state.waiting ||
      this.state.picker ||
      this.state.jobDetail ||
      this.state.draft ||
      Date.now() < this.jobWakeAt ||
      !runtime.jobs.hasNotices(runtime.session.id, true)
    )
      return;
    this.jobWakeCount++;
    void runtime
      .runJobNotices()
      .catch(() => {
        this.jobWakeSnoozed = true;
      })
      .finally(() => this.repaint());
  }
  // Approvals, questions and secrets reach the runtime through the card queue: one card at
  // a time, the turn's own before a background agent's, none while you are typing.
  private cardHooks(): Pick<RuntimeOptions, 'approve' | 'question' | 'secret'> {
    const asCard = <T>(
      action: () => Promise<T>,
      signal: AbortSignal,
      origin?: { jobId?: string },
    ): Promise<T> =>
      this.interactions.run(
        async () => {
          this.backgroundCard = Boolean(origin?.jobId);
          try {
            return await action();
          } finally {
            this.backgroundCard = false;
          }
        },
        signal,
        Boolean(origin?.jobId),
      );
    const label = (origin?: { jobId?: string; name?: string }): string =>
      origin?.jobId ? `${origin.jobId} ${origin.name ?? ''}`.trim() : '';
    return {
      approve: (call, signal, origin) =>
        asCard(() => this.approve(call, signal, label(origin)), signal, origin),
      question: (args, signal, origin) =>
        asCard(
          async () => {
            if (!Array.isArray(args.questions))
              throw new Error('invalid questions');
            // every question in one card; null (cancelled) tells the model nothing was answered
            return JSON.stringify(
              await this.showCard(
                new QuestionCard(args.questions as Question[], label(origin)),
                signal,
              ),
            );
          },
          signal,
          origin,
        ),
      secret: (request, signal, origin) =>
        asCard(
          () =>
            this.enterSecret(
              {
                ...request,
                question:
                  (origin?.jobId ? `${origin.jobId} · ` : '') +
                  request.question,
              },
              signal,
            ),
          signal,
          origin,
        ),
    };
  }
  private async showCard<T>(card: Card<T>, signal?: AbortSignal): Promise<T> {
    this.card = card as Card<unknown>;
    try {
      return await this.dialog<T>(card.state(), signal);
    } finally {
      this.card = undefined;
    }
  }
  private async enterSecret(
    request: SecretRequest,
    signal: AbortSignal,
  ): Promise<void> {
    this.secretReady = request;
    try {
      const choice = await this.askChoice(
        'secret',
        `${request.question}\n${request.key} → ${request.target_file}\nctrl+s enters a masked value`,
        ['enter secret', 'cancel'],
        signal,
      );
      if (choice !== 'enter secret') {
        await cancelRequest(this.home, request.id);
        return;
      }
      const value = await this.showCard(
        new SecretCard(
          `${request.question}\n${request.key} → ${request.target_file}`,
          request.mask !== false,
        ),
        signal,
      );
      if (value === null) {
        await cancelRequest(this.home, request.id);
        return;
      }
      await submitAnswer(this.home, request.id, value);
      this.flash('Collected · not shown');
    } finally {
      this.secretReady = undefined;
    }
  }
  private askChoice(
    title: string,
    body: string,
    options: string[],
    signal?: AbortSignal,
  ): Promise<string> {
    return this.dialog({ title, body, options, focus: 0 }, signal);
  }
  // A card takes the frame: the draft (text and cursor) is set aside and comes back when
  // the card ends, whatever it was answered with; a list would compete for keys, so it closes.
  private dialog<T = string>(
    state: NonNullable<ScreenState['dialog']>,
    signal?: AbortSignal,
  ): Promise<T> {
    if (this.pending)
      return Promise.reject(new Error('another question is waiting'));
    if (signal?.aborted) return Promise.reject(signal.reason);
    // An open list is hidden while the card is up and given back after.
    const list = this.state.picker;
    this.state.picker = undefined;
    this.parked.park(this.state);
    this.state.dialog = state;
    this.state.waiting = true;
    return new Promise<T>((resolve, reject) => {
      const close = (): void => {
        this.pending = undefined;
        this.state.dialog = undefined;
        this.state.waiting = false;
        this.state.picker ??= list;
        this.parked.restore(this.state);
        this.repaint();
      };
      const abort = (): void => {
        close();
        reject(signal?.reason || new Error('Interrupted'));
      };
      this.pending = {
        complete: (answer) => {
          signal?.removeEventListener('abort', abort);
          close();
          resolve(answer as T);
        },
        abort,
      };
      signal?.addEventListener('abort', abort, { once: true });
      this.repaint();
    });
  }
  private async approve(
    call: ToolCall,
    signal: AbortSignal,
    origin = '',
  ): Promise<ApprovalDecision> {
    const runtime = this.runtime!;
    return this.showCard(
      new ApprovalCard(
        approvalRequest(
          call,
          runtime.policy.review(call.name, call.args),
          (path) => runtime.sandbox.resolvePath(path),
          origin,
        ),
      ),
      signal,
    );
  }
  private handle(event: InputEvent): void {
    if (this.ended || this.externalEditor) return;
    this.theme.feed(event);
    if (event.type === 'color' || event.type === 'scheme') return;
    if (event.type === 'mouse') {
      if (this.pageButton(event)) return;
      if (this.stripClick(event)) return;
      if (this.selectionMouse(event)) return;
      if (
        event.action === 'press' &&
        event.button === 0 &&
        /^ . Agent\(/.test(stripAnsi(this.frameRows[event.y] ?? '')) &&
        this.state.subagents?.length
      ) {
        const open = (id: string): void => {
          this.agents.detail = id;
          this.agents.selected = id;
          this.state.scroll = 0;
          this.repaint();
        };
        if (this.state.subagents.length === 1)
          open(this.state.subagents[0]!.id);
        else
          this.picker(
            'Task details',
            this.state.subagents.map((agent) => ({
              key: agent.id,
              label: `${agent.name} · ${agent.state}`,
              meta: agent.description,
            })),
            async (item) => {
              open(item.key);
            },
          );
      }
      if (event.action === 'wheel') {
        const top = this.frameRows.findIndex((row) =>
          /^┌.*Plan \d+\//.test(stripAnsi(row)),
        );
        const bottom =
          top < 0
            ? -1
            : this.frameRows.findIndex(
                (row, index) => index > top && stripAnsi(row).startsWith('└'),
              );
        if (
          top >= 0 &&
          event.y >= top &&
          event.y <= bottom &&
          !this.state.dialog
        ) {
          this.plan.scroll(event.button === 0 ? -1 : 1);
          this.state.planStart = this.plan.start;
        } else
          this.state.scroll = Math.max(
            0,
            this.state.scroll + (event.button === 0 ? 3 : -3),
          );
      }
      this.repaint();
      return;
    }
    if (event.type === 'switch') {
      if (this.runtime)
        void this.runtime.switchSession(event.id).then(
          () => this.repaint(),
          (error) => this.fail(error),
        );
      return;
    }
    if (event.type === 'upload') {
      this.setDraft(this.state.draft + ' @' + event.filename);
      this.repaint();
      return;
    }
    // a key or paste for the draft: a card that arrives now waits until typing pauses
    if (!this.state.dialog) this.interactions.typed();
    if (event.type === 'paste') {
      if (this.state.find && !this.state.dialog) {
        this.state.find.query += event.text;
        this.state.find.refresh(
          transcriptRows(this.state, process.stdout.columns || 80),
        );
      } else if (this.history.query !== undefined && !this.state.dialog) {
        const match = this.history.update(this.history.query + event.text);
        if (match !== undefined) this.setDraft(match);
        this.state.historySearch = {
          query: this.history.query!,
          match: match !== undefined,
        };
      } else if (this.card) {
        this.card.paste(event.text);
        this.state.dialog = this.card.state();
      } else if (this.state.dialog?.input !== undefined)
        this.state.dialog.input += event.text;
      else if (this.state.picker && this.state.picker.options.search !== false)
        // where typing goes: the search, or the line the list asks for (a key, as dots)
        this.state.picker.paste(event.text);
      else if (!this.state.dialog) {
        this.composer.paste(event.text);
        this.composer.update();
      }
      this.repaint();
      return;
    }
    const key = this.remap[event.key] || event.key;
    const char = event.char;
    if (!this.state.dialog && !this.state.picker && this.state.find) {
      const find = this.state.find;
      if (['escape', 'ctrl+c', 'ctrl+f'].includes(key))
        this.state.find = undefined;
      else if (['enter', 'down', 'shift+enter', 'up'].includes(key))
        find.next(key === 'up' || key === 'shift+enter');
      else if (key === 'backspace' || char) {
        find.query =
          key === 'backspace'
            ? Array.from(find.query).slice(0, -1).join('')
            : find.query + char;
        const messages =
          this.state.agentDetail?.messages ?? this.state.messages;
        find.refresh(
          transcriptRows(
            {
              ...this.state,
              messages,
              notices: [],
              streaming: '',
              thinking: '',
            },
            process.stdout.columns || 80,
          ),
        );
      }
      this.repaint();
      return;
    }
    if (
      !this.state.dialog &&
      !this.state.picker &&
      this.history.query !== undefined
    ) {
      if (key === 'escape' || key === 'ctrl+c') {
        this.setDraft(this.history.endSearch(true));
        this.state.historySearch = undefined;
        this.repaint();
        return;
      }
      if (key === 'ctrl+r' || key === 'backspace' || char) {
        const query =
          key === 'backspace'
            ? Array.from(this.history.query).slice(0, -1).join('')
            : this.history.query + char;
        const match =
          key === 'ctrl+r' ? this.history.next() : this.history.update(query);
        if (match !== undefined) this.setDraft(match);
        this.state.historySearch = {
          query: this.history.query!,
          match: match !== undefined,
        };
        this.repaint();
        return;
      }
      this.history.endSearch(false);
      this.state.historySearch = undefined;
    }
    if (!this.state.dialog && !this.state.picker && key === 'ctrl+f') {
      this.state.find = new TranscriptFind();
      this.repaint();
      return;
    }
    if (!this.state.dialog && !this.state.picker && key === 'ctrl+r') {
      const match = this.history.beginSearch(this.state.draft);
      if (match !== undefined) this.setDraft(match);
      this.state.historySearch = {
        query: this.history.query!,
        match: match !== undefined,
      };
      this.repaint();
      return;
    }
    if (!this.state.dialog && !this.state.picker && this.selection.key(key))
      return;
    if (
      !this.state.dialog &&
      !this.state.picker &&
      !this.state.jobDetail &&
      this.agents.handle(
        key,
        char,
        (this.state.subagents ?? [])
          .filter(
            (agent) =>
              this.agents.detail ||
              ['running', 'waiting'].includes(agent.state) ||
              agent.id === this.agents.selected,
          )
          .map((agent) => agent.id),
        this.state.draft,
      )
    ) {
      this.state.scroll = 0;
      this.repaint();
      return;
    }
    // The job page keeps its keys; ctrl+c and ctrl+z work there as anywhere
    if (
      this.state.jobDetail &&
      !this.state.dialog &&
      key !== 'ctrl+c' &&
      key !== 'ctrl+z'
    ) {
      const job = this.state.jobDetail;
      if (key === 'escape') {
        this.state.jobDetail = undefined;
        void this.command('jobs', '');
      } else if (key === 'ctrl+d')
        void (async () => {
          if (job.status === 'running') {
            if (
              (await this.askChoice(`stop ${job.id}`, job.title, [
                'stop job',
                'keep running',
              ])) === 'stop job'
            )
              await this.runtime!.jobs.stop(job.id, 'user');
          } else {
            this.runtime!.jobs.remove(job.id);
            this.state.jobDetail = undefined;
            await this.command('jobs', '');
          }
          this.repaint();
        })().catch((error) => this.fail(error));
      else if (key === 'ctrl+b') this.runtime?.jobs.backgroundForeground();
      this.repaint();
      return;
    }
    if (this.state.dialog) {
      if (key === 'ctrl+c' && this.backgroundCard) {
        // Not an answer: it stops the turn, or leaves on a second press; the card stays.
        this.ctrlC();
        this.repaint();
        return;
      }
      const dialog = this.state.dialog;
      if (this.card) {
        const result = this.card.handle(key, char);
        if (result === 'pass') {
          // not the card's business: ctrl+c stops the turn, page keys scroll
          if (key === 'ctrl+c' && this.runtime?.busy) this.ctrlC();
          else if (key === 'pageup' || key === 'pagedown') {
            const page = Math.max(1, (process.stdout.rows || 24) - 8);
            this.state.scroll = Math.max(
              0,
              this.state.scroll + (key === 'pageup' ? page : -page),
            );
          }
        } else if (result) this.pending?.complete(result.answer);
        else this.state.dialog = this.card.state();
        this.repaint();
        return;
      }
      if (key === 'ctrl+s' && this.secretReady && dialog.input === undefined) {
        this.pending?.complete('enter secret');
        this.repaint();
        return;
      }
      if (key === 'escape' || key === 'ctrl+c')
        this.pending?.complete(dialog.options.at(-1) || '');
      else if (dialog.input !== undefined) {
        if (key === 'enter') this.pending?.complete(dialog.input);
        else if (key === 'backspace')
          dialog.input = Array.from(dialog.input).slice(0, -1).join('');
        else if (char && !key.startsWith('ctrl+') && !key.startsWith('alt+'))
          dialog.input += char;
      } else if (key === 'up' || key === 'down')
        dialog.focus =
          (dialog.focus + (key === 'up' ? -1 : 1) + dialog.options.length) %
          dialog.options.length;
      else if (key === 'enter')
        this.pending?.complete(dialog.options[dialog.focus] || '');
      else if (/^[1-9]$/.test(key) && dialog.options[Number(key) - 1])
        this.pending?.complete(dialog.options[Number(key) - 1]!);
      else if (key === 'y') this.pending?.complete(dialog.options[0] || '');
      else if (key === 'n') this.pending?.complete(dialog.options.at(-1) || '');
      this.repaint();
      return;
    }
    // Every key goes to an open list; it leaves ctrl+c and ctrl+d to the session unless it
    // asks for something or uses them, and a list without a search leaves the keys it does
    // not use.
    if (this.state.picker?.handle(key, char)) {
      this.repaint();
      return;
    }
    if (key === 'ctrl+s') {
      const request = listPending(this.home)[0];
      if (request)
        void this.enterSecret(request, new AbortController().signal).catch(
          (error) => this.fail(error),
        );
      else this.flash('No secret request');
      return;
    }
    if (key === 'ctrl+d' && !this.state.draft) {
      this.exit(0);
      return;
    }
    if (this.composer.completionKey(key)) {
      this.repaint();
      return;
    }
    if (key === 'ctrl+c') {
      if (this.state.draft && !this.runtime?.busy) {
        // What you typed is cleared but stays in the history
        this.jobWakeSnoozed = true;
        this.history.add(this.state.draft);
        this.composer.clear();
        this.lastCtrlC = 0;
      } else this.ctrlC();
    } else if (key === 'ctrl+z') {
      this.suspend();
      return;
    } else if (key === 'escape') {
      this.jobWakeSnoozed = true;
      if (this.runtime?.busy) this.interrupt();
      else if (
        !this.state.draft &&
        Date.now() - this.lastEscape < 500 &&
        this.settings.double_escape !== 'none'
      )
        void this.command(this.settings.double_escape, '');
      // Only an esc on an empty box counts toward esc esc: the one that clears your
      // text must not open the tree as well
      this.lastEscape = this.state.draft ? 0 : Date.now();
      if (!this.runtime?.busy) this.composer.clear();
    } else if (key === 'ctrl+b') {
      const count = this.runtime?.jobs.backgroundForeground() ?? 0;
      this.flash(
        count === 1
          ? 'Moved to the background'
          : count
            ? `${count} commands moved to the background`
            : this.runtime?.busy &&
                this.state.subagents?.some(
                  (agent) => !agent.background && agent.state === 'running',
                )
              ? "Subagents can't move to the background"
              : 'Nothing to move',
      );
    } else if (key === 'ctrl+o') {
      this.state.showTools = !this.state.showTools;
      this.flash(this.state.showTools ? 'Tools expanded' : 'Tools folded');
    } else if (key === 'ctrl+t') {
      this.state.thinkingExpanded = !this.state.thinkingExpanded;
      this.state.showThinking = true;
      this.flash(
        this.state.thinkingExpanded
          ? 'Thinking expanded'
          : 'Thinking collapsed',
      );
    } else if (key === 'ctrl+l') {
      // The screen is drawn again from scratch, then the model list opens
      this.terminal.write('\x1b[2J');
      this.screen.invalidate();
      void this.command('models', '').catch((error) => this.fail(error));
    } else if (key === 'ctrl+g')
      void this.command('editor', '').catch((error) => this.fail(error));
    else if (key === 'ctrl+x')
      void this.command('copy', '').catch((error) => this.fail(error));
    else if (key === 'ctrl+p')
      void this.cycleModel().catch((error) => this.fail(error));
    else if (key === 'shift+tab' && this.runtime) {
      try {
        cycleThinking(this.commandHost());
      } catch (error) {
        this.fail(error);
      }
    } else if (key === 'alt+up' && this.runtime) {
      const queue = this.runtime.harness.clearQueue();
      const messages = [...queue.steering, ...queue.followUp];
      if (messages.length) {
        this.setDraft(
          [...messages, ...(this.state.draft ? [this.state.draft] : [])].join(
            '\n\n',
          ),
        );
        this.flash(
          `${messages.length} queued message${messages.length === 1 ? '' : 's'} back in the box`,
        );
      }
    } else if (['ctrl+q', 'alt+enter', 'alt+return'].includes(key)) {
      if (this.state.draft.trim()) this.send('followUp');
    } else this.composer.key(key, char);
    this.repaint();
  }
  // ctrl+c with nothing typed, as in 0.5.0: it stops a running turn; otherwise the first press
  // says how to leave and a second within 1.5 s leaves (so does one just after a stop).
  private ctrlC(): void {
    this.jobWakeSnoozed = true;
    const now = Date.now();
    if (this.runtime?.busy) {
      this.interrupt();
      this.lastCtrlC = now;
    } else if (now - this.lastCtrlC < 1500) this.exit(0);
    else {
      this.lastCtrlC = now;
      const live =
        this.runtime?.jobs.list().filter((job) => job.status === 'running')
          .length ?? 0;
      this.flash(
        'Press ctrl+c again to exit' +
          (live ? ` · stops ${live} job${live === 1 ? '' : 's'}` : ''),
        1500,
      );
    }
  }
  // esc or ctrl+c during a turn, as in 0.5.0: the turn stops, and the messages it had not read
  // yet are sent next, one turn each, the steering ones first.
  private interrupt(): void {
    const runtime = this.runtime;
    if (!runtime) return;
    void runtime.cancel({ keepQueue: true }).then(() => {
      if (
        this.ended ||
        this.runtime !== runtime ||
        runtime.busy ||
        !runtime.harness.pendingMessageCount
      )
        return;
      // A message of yours starts this turn: finished jobs may start turns again
      this.jobWakeSnoozed = false;
      this.jobWakeCount = 0;
      void runtime.harness
        .run()
        .catch(() => {
          /* The event bus shows how the turn ended. */
        })
        .finally(() => this.repaint());
    });
  }
  // ctrl+z: the shell gets the terminal back and `fg` brings Circle back with the screen drawn
  // again (0.5.0's _suspend). Windows has no job control.
  private suspend(): void {
    if (this.terminal.platform === 'win32') {
      this.flash('Suspending is not supported here');
      return;
    }
    if (this.externalEditor) return;
    this.lendTerminal();
    try {
      // The process stops here; the call returns once the shell continues it.
      this.terminal.kill('SIGTSTP');
    } catch (error) {
      this.fail(error);
    } finally {
      this.takeTerminal();
    }
  }
  // The screen goes to another program (the shell after ctrl+z, $EDITOR): the terminal as it
  // was before Circle, keys in line mode. Nothing is drawn or asked until it comes back.
  private lendTerminal(): void {
    this.externalEditor = true;
    this.input.reset();
    this.terminal.write(
      '\x1b[?2031l\x1b[?1000l\x1b[?1002l\x1b[?1006l\x1b[?2004l\x1b[?25h\x1b[?1049l\x1b[23;0t',
    );
    this.terminal.input(false);
  }
  private takeTerminal(): void {
    this.externalEditor = false;
    if (this.ended) return;
    this.terminal.input(true);
    this.terminal.write(
      '\x1b[22;0t' +
        (this.title ? `\x1b]0;${this.title}\x07` : '') +
        '\x1b[?1049h\x1b[?25l\x1b[?2004h\x1b[?2031h\x1b[?1000h\x1b[?1002h\x1b[?1006h\x1b[2J',
    );
    this.screen.invalidate();
    this.repaint();
  }
  // The open /jobs list takes the jobs as they are now (0.5.0's _refresh_jobs_picker). While
  // it asks something (stop this job?) it is put aside and keeps following.
  private refreshJobsList(): void {
    const open = this.jobsList;
    if (!open) return;
    if (this.state.picker === open.list) {
      if (!open.list.asking) open.list.setItems(open.rows());
    } else if (!this.state.dialog) this.jobsList = undefined;
  }
  /** Send the draft: the model reads the long pastes, the screen and the history keep it as shown. */
  private send(kind: 'steer' | 'followUp'): void {
    const raw = this.state.draft;
    const shown = raw.trim();
    if (!shown) return;
    this.composer.take();
    const message = this.composer.modelText(shown);
    const pastes = this.composer.pastesOf(shown);
    this.history.add(shown);
    if (kind === 'followUp' && this.runtime?.busy) {
      if (message !== shown)
        this.runtime.harness.shown.set(message, { display: shown, pastes });
      this.runtime.harness.queue(message, 'followUp');
      this.flash('Queued follow-up');
    } else
      void this.submit(message, raw, false, shown, pastes).catch((error) =>
        this.fail(error),
      );
  }
  /** Everything that can follow `/` for the completion list, read again each time a `/` is typed. */
  private completionCommands(): Map<string, string> {
    if (this.commandList && this.state.draft.length > 1)
      return this.commandList;
    const found = new Map(
      BUILTIN_SLASH.map((command) => [command.name, command.description]),
    );
    for (const command of discoverCustomCommands(this.workspace, this.home))
      found.set(command.name, command.description);
    for (const [name, command] of this.runtime?.extensions.commands() ?? [])
      found.set(name, command.description);
    for (const skill of this.runtime?.skills ?? [])
      found.set(`skill:${skill.name}`, skill.description);
    this.commandList = found;
    return found;
  }
  // `raw` is the box as it was sent: with a space before it, a mistyped /command goes to the
  // model as text. `plain` text (from /init or a custom command) is never read as a command.
  // `shown` and `pastes`: the box showed long pastes folded; the model reads `message` whole.
  async submit(
    message: string,
    raw = message,
    plain = false,
    shown = message,
    pastes?: Record<string, string>,
  ): Promise<void> {
    if (!plain && message === '?') {
      await this.command('hotkeys', '');
      return;
    }
    if (!plain && message.startsWith('/')) {
      const extra = new Set([
        ...discoverCustomCommands(this.workspace, this.home).map(
          (command) => command.name,
        ),
        ...(this.runtime?.extensions.commands().keys() ?? []),
      ]);
      const slash = parseSlash(message, extra);
      if (slash) {
        await this.command(slash.name, slash.args);
        return;
      }
      const word = commandWord(raw);
      if (word) {
        // Not sent: the text comes back to the box to fix.
        const close = closeMatch(word, [...knownSlashNames(), ...extra]);
        this.composer.restore(raw, pastes);
        this.flash(
          `Unknown command /${word}` +
            (close ? ` · did you mean /${close}?` : ' · /help lists them'),
          4000,
        );
        return;
      }
    }
    if (!this.runtime) return;
    if (!plain && message.startsWith('!')) {
      try {
        await this.runtime.userShells.run(
          message.slice(message.startsWith('!!') ? 2 : 1),
          message.startsWith('!!'),
        );
      } finally {
        if (!this.runtime.busy && this.runtime.harness.pendingMessageCount)
          void this.runtime.harness.run().catch((error) => this.fail(error));
        this.repaint();
      }
      return;
    }
    this.jobWakeSnoozed = false;
    this.jobWakeCount = 0;
    if (shown !== message)
      this.runtime.harness.shown.set(message, { display: shown, pastes });
    if (this.runtime.busy) {
      this.runtime.harness.queue(message);
      this.flash('Queued steering');
    } else {
      try {
        await this.runtime.harness.run(message);
      } catch {
        /* Run error is already displayed by the event bus. */
      }
      this.repaint();
    }
  }
  // A list above the frame. Choosing a row (or, with `freeText`, enter on what was typed)
  // closes it first; its own keys and the answers to what it asks keep it open. `closed`
  // runs when esc closes it.
  private picker(
    title: string,
    items: PickerItem[],
    choose: (item: PickerItem) => Promise<void> | void,
    options: PickerOptions = {},
    closed?: () => void,
  ): Picker {
    const shut = (): void => {
      if (this.state.picker === list) this.state.picker = undefined;
    };
    const freeText = options.freeText;
    const list: Picker = new Picker(
      title,
      items,
      (item) => {
        shut();
        list.settle(() => choose(item));
      },
      () => {
        shut();
        closed?.();
        this.repaint();
      },
      {
        ...options,
        keys: Object.fromEntries(
          Object.entries(options.keys ?? {}).map(([key, action]) => [
            key,
            (item: PickerItem | undefined) => list.settle(() => action(item)),
          ]),
        ),
        freeText:
          freeText &&
          ((text) => {
            shut();
            return freeText(text);
          }),
      },
    );
    list.settle = (work) => {
      Promise.resolve()
        .then(work)
        .then(
          () => this.repaint(),
          (error) => this.fail(error),
        );
    };
    this.state.picker = list;
    this.repaint();
    return list;
  }
  // What the commands in slash_handlers.ts use of the session.
  private commandHost(): CommandHost {
    const app = this;
    return {
      runtime: this.runtime!,
      home: this.home,
      workspace: this.workspace,
      get settings() {
        return app.settings;
      },
      set settings(value) {
        app.settings = value;
      },
      state: this.state,
      undo: this.undo,
      get shared() {
        return app.shared;
      },
      set shared(value) {
        app.shared = value;
      },
      get previousSession() {
        return app.previousSession;
      },
      set previousSession(value) {
        app.previousSession = value;
      },
      notice: (text) => this.notice(text),
      flash: (text, ttl) => this.flash(text, ttl),
      fail: (error) => this.fail(error),
      repaint: () => this.repaint(),
      picker: (title, items, choose, options) => {
        this.picker(title, items, choose, options);
      },
      closePicker: () => {
        this.state.picker = undefined;
        this.repaint();
      },
      setDraft: (text, pastes) => this.composer.restore(text, pastes),
      snoozeJobs: () => {
        this.jobWakeSnoozed = true;
      },
      send: (text) => this.submit(text, text, true),
      command: (name, args) => this.command(name, args),
      setTheme: (mode) => {
        this.theme.mode = mode;
        this.theme.apply();
        this.repaint();
      },
      trustWorkspace: () => this.trustWorkspace(),
      clipboard: (text) => this.clipboard.copyNative(text),
      followJobs: (list, rows) => {
        this.jobsList = { list, rows };
      },
      clearContextMeter: () => {
        this.meterCleared =
          this.runtime?.harness.messages
            .filter((message) => message.role === 'assistant' && message.usage)
            .at(-1)?.id ?? '';
      },
    };
  }
  // The screen before a turn, which /undo goes back to. The turn's own message is saved
  // before the turn starts, so it is left out.
  private screenBefore(prompt: unknown): ScreenSnapshot {
    const runtime = this.runtime!;
    const messages = runtime.harness.messages;
    return this.undo.snapshot(
      runtime.session.id,
      prompt !== undefined && messages.at(-1)?.role === 'user'
        ? messages.slice(0, -1)
        : messages,
      this.state.notices,
    );
  }
  private scopedModels(): string[] {
    const runtime = this.runtime!;
    this.runScopeOnly ??= Boolean(runtime.runOptions.models.length);
    return modelScope(
      this.knownModels ?? [],
      this.runScopeOnly
        ? runtime.runOptions.models
        : this.settings.enabled_models,
      runtime.harness.model.model,
    );
  }
  private async loadModels(): Promise<string[]> {
    const credentials = loadCredentials(this.home);
    const result = await resolveEndpoint(
      this.settings.auth.base_url,
      credentials[this.settings.auth.api_key_ref] || '',
      { protocol: this.settings.auth.protocol },
    );
    if (result.status === 'failed') throw new Error(result.detail);
    this.knownModels = result.models;
    this.knownModelsEndpoint =
      this.settings.auth.protocol + ':' + this.settings.auth.base_url;
    return modelScope(result.models, [], this.runtime!.harness.model.model);
  }
  private async cycleModel(): Promise<void> {
    if (!this.runtime) return;
    if (this.runtime.busy) {
      this.flash('Busy · switch models when the turn has finished');
      return;
    }
    if (
      !this.knownModels ||
      this.knownModelsEndpoint !==
        this.settings.auth.protocol + ':' + this.settings.auth.base_url
    )
      await this.loadModels();
    const scope = this.scopedModels();
    if (scope.length < 2) {
      this.flash('Only one model to cycle through · /models lists them');
      return;
    }
    const current = scope.indexOf(this.runtime.harness.model.model);
    await this.command('models', scope[(current + 1) % scope.length]!);
  }
  async command(name: string, args: string): Promise<void> {
    if (!this.runtime) return;
    if (await runCommand(this.commandHost(), name, args, () => this.exit(0)))
      return;
    try {
      await this.ownCommand(name, args);
    } catch (error) {
      this.fail(
        `/${name} failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  // The commands that open SessionApp's own lists and dialogs.
  private async ownCommand(name: string, args: string): Promise<void> {
    const runtime = this.runtime;
    if (!runtime) return;
    if (name === 'models') {
      const choose = (model: string): void => {
        if (runtime.harness.busy) throw new Error('a turn is running');
        runtime.setModel(model);
        this.flash(
          `Model → ${model} · this session (ctrl+s in /models saves it)`,
          4000,
        );
      };
      if (args.trim()) choose(args.trim());
      else {
        const models = await this.loadModels();
        this.scopedModels();
        const rows = (): PickerItem[] =>
          models.map((model) => ({
            key: model,
            label: model,
            current: model === runtime.harness.model.model,
            meta: [
              model === this.settings.auth.model ? 'default' : '',
              (this.runScopeOnly
                ? runtime.runOptions.models
                : this.settings.enabled_models
              ).length && this.scopedModels().includes(model)
                ? 'in ctrl+p'
                : '',
            ]
              .filter(Boolean)
              .join(' · '),
          }));
        this.picker('Model', rows(), (item) => choose(item.key), {
          hint:
            'enter uses it in this session · ctrl+s also makes it the default · ' +
            'tab adds it to ctrl+p or takes it out',
          empty:
            'No model matches · /models <id> uses an id the endpoint does not list',
          focusKey: runtime.harness.model.model,
          keys: {
            'ctrl+s': (item) => {
              if (!item) return;
              runtime.setModel(item.key);
              this.settings.auth.model = item.key;
              saveSettingsChange(this.home, (saved) => {
                saved.auth.model = item.key;
              });
              this.state.picker = undefined;
              this.notice(`Model → ${item.key} · saved as the default`);
            },
            tab: (item) => {
              if (!item) return;
              const scoped = this.runScopeOnly
                ? runtime.runOptions.models
                : this.settings.enabled_models;
              const chosen = scoped.length ? this.scopedModels() : [];
              const next = chosen.includes(item.key)
                ? chosen.filter((model) => model !== item.key)
                : [...chosen, item.key];
              if (this.runScopeOnly) runtime.runOptions.models = next;
              else {
                this.settings.enabled_models = next;
                saveSettingsChange(this.home, (saved) => {
                  saved.enabled_models = next;
                });
              }
              this.state.picker?.setItems(rows());
              this.flash(
                next.length
                  ? `ctrl+p goes through ${next.length} model${next.length === 1 ? '' : 's'}`
                  : 'ctrl+p goes through every listed model',
                2000,
              );
            },
          },
        });
      }
      return;
    }
    if (name === 'editor') {
      if (await this.editor())
        this.flash('Loaded from the editor · enter sends');
      return;
    }
    if (name === 'login') {
      const provider = args.trim().toLowerCase();
      if (provider) {
        // OAuth is not implemented: there is nothing to sign in to.
        this.fail(
          ['anthropic', 'openai'].includes(provider)
            ? `${provider} OAuth sign-in is not available yet · use API URL + KEY`
            : `Unknown provider '${provider}' · choose anthropic, openai`,
        );
        return;
      }
      this.login();
      return;
    }
    if (name === 'reload') {
      const keys = loadRemap(this.home);
      this.remap = keys.remap;
      for (const problem of keys.problems) this.fail(problem);
      try {
        await runtime.reloadIntegrations();
      } catch (error) {
        this.fail(
          `Reload partly failed: ${error instanceof Error ? error.message : String(error)}`,
        );
        return;
      }
      this.settings = runtime.options.settings;
      runtime.setModel(this.settings.auth.model);
      if (this.theme.mode !== this.settings.theme) {
        this.theme.mode = this.settings.theme;
        this.theme.apply();
      }
      this.notice('Reloaded settings and the model');
      return;
    }
    this.flash(`Unknown command /${name} · try /help`);
  }
  // /login: how Circle reaches the model, then setup's questions asked in the list, the URL
  // and the key (as dots) on its search line (0.5.0's _open_login_picker). Nothing is saved
  // before a model is chosen; esc on a question goes back to the ways in, esc there leaves.
  private login(): void {
    const runtime = this.runtime!;
    const flow = new SetupFlow(this.home);
    this.loginFlow = flow;
    const title = (): string =>
      'Sign in' + (flow.error ? ` · ${flow.error}` : '');
    const leave = (): void => {
      if (this.loginFlow === flow) this.loginFlow = undefined;
    };
    const steps = 'enter continues · esc goes back';
    const askUrl = (list: Picker, text: string): void => {
      list.title = title();
      list.ask(
        'base url',
        text,
        (typed) => {
          flow.submitUrl(typed);
          // not a URL: say why and ask again
          if (flow.step === 'url') askUrl(list, typed);
          else askKey(list);
        },
        { keys: steps },
      );
    };
    const askKey = (list: Picker): void => {
      list.title = title();
      list.ask(
        'api key' + (flow.hasSavedKey ? ' (enter keeps the saved one)' : ''),
        '',
        (typed) => {
          flow.submitKey(typed);
          if (flow.step === 'key') askKey(list);
          else next();
        },
        { mask: true, keys: steps },
      );
    };
    const methods = (): void => {
      const auth = this.settings.auth;
      const list = this.picker(
        title(),
        [
          {
            key: 'api_key',
            label: 'API URL + KEY',
            current: auth.mode === 'api_key',
          },
          {
            key: 'oauth',
            label: 'OAuth sign-in',
            current: auth.mode === 'oauth',
            meta: 'not available yet',
          },
        ],
        () => {},
        {
          hint: !this.settings.initialized
            ? 'not signed in'
            : `now ${auth.mode === 'oauth' ? `oauth · ${auth.oauth_provider}` : `api key · ${endpointName(auth.base_url)}`} · ${auth.model}`,
          focusKey: auth.mode === 'oauth' ? 'oauth' : 'api_key',
          keys: {
            // The list stays: the questions are asked on its search line
            enter: (item) => {
              if (!item) return;
              if (item.key === 'oauth') {
                this.flash(
                  'OAuth sign-in is not available yet · use API URL + KEY',
                  3000,
                );
                return;
              }
              flow.restart();
              askUrl(list, flow.savedUrl);
            },
          },
        },
        leave,
      );
    };
    // The list for the step the answers have reached; at the end, sign in with them.
    const next = (): void => {
      if (this.loginFlow !== flow) return; // left with esc while the endpoint was asked
      if (flow.step === 'done') {
        this.loginFlow = undefined;
        this.saveConnection(flow);
        this.applyRunSettings(runtime.options.modelOverride);
        runtime.options.settings = this.settings;
        runtime.setModel(this.settings.auth.model);
        this.notice(
          `Signed in to ${endpointName(this.settings.auth.base_url)} · model ${this.settings.auth.model}`,
        );
      } else if (flow.step === 'probing') {
        this.picker(
          title(),
          [],
          () => {},
          { empty: `asking ${endpointName(flow.baseUrl)} for its models…` },
          leave,
        );
        void flow.runProbe().then(
          () => next(),
          (error) => this.fail(error),
        );
      } else if (flow.step === 'protocol')
        this.picker(
          title(),
          [
            { key: 'openai', label: 'OpenAI-style API' },
            { key: 'anthropic', label: 'Anthropic-style API' },
          ],
          (item) => {
            flow.chooseProtocol(item.key === 'anthropic' ? 1 : 0);
            next();
          },
          {
            hint: `${flow.status} · which kind of API is it?`,
            focusKey: flow.focus ? 'anthropic' : 'openai',
          },
          leave,
        );
      else if (flow.step === 'model') {
        const current = this.settings.auth.model;
        this.picker(
          title(),
          flow.models.map((model) => ({
            key: model,
            label: model,
            current: model === current,
          })),
          (item) => {
            flow.use(item.key);
            next();
          },
          {
            hint: flow.status,
            focusKey: current,
            // An id the endpoint did not list, not checked
            freeText: (text) => {
              flow.use(text);
              next();
            },
            empty: flow.models.length
              ? 'No model matches · enter uses what you typed'
              : 'Type the model id your endpoint uses',
          },
          leave,
        );
      } else methods();
    };
    methods();
  }
  /** pbcopy, wl-copy or xclip (clip on Windows); false when none took the text. */
  private async copy(text: string): Promise<boolean> {
    return this.clipboard.copyNative(text);
  }
  /** A press on a subagent page's band: `main` goes back, `prev` and `next` step through. */
  private pageButton(event: Extract<InputEvent, { type: 'mouse' }>): boolean {
    const band = this.state.pageButtons;
    if (
      !band ||
      event.action !== 'press' ||
      event.button !== 0 ||
      event.y !== band.row
    )
      return false;
    const hit = band.spans.find(
      ([start, end]) => event.x >= start && event.x < end,
    );
    if (!hit) return false;
    this.agents.handle(
      hit[2] === 'back' ? 'escape' : hit[2] === 'prev' ? 'left' : 'right',
      '',
      (this.state.subagents ?? []).map((agent) => agent.id),
      '',
    );
    this.state.scroll = 0;
    this.repaint();
    return true;
  }
  /** A press on a subagent's row in the strip opens its page, as in 0.5.0. */
  private stripClick(event: Extract<InputEvent, { type: 'mouse' }>): boolean {
    const strip = this.state.stripAgents;
    if (!strip || event.action !== 'press' || event.button !== 0) return false;
    const id = strip.ids[event.y - strip.row];
    if (!id) return false;
    this.agents.detail = id;
    this.agents.selected = id;
    this.state.scroll = 0;
    this.repaint();
    return true;
  }
  /** A mouse event for the selection; a press on a task row opens the task instead. */
  private selectionMouse(
    event: Extract<InputEvent, { type: 'mouse' }>,
  ): boolean {
    if (
      event.action === 'press' &&
      /^ . Agent\(/.test(stripAnsi(this.frameRows[event.y] ?? '')) &&
      this.state.subagents?.length
    )
      return false;
    return this.selection.mouse(event);
  }
  private scrollTranscript(delta: number): void {
    const view = this.state.viewport;
    this.state.scroll = Math.min(
      view ? Math.max(0, view.total - view.height) : Infinity,
      Math.max(0, this.state.scroll - delta),
    );
    this.repaint();
  }
  private copySelection(text: string): void {
    void this.clipboard.copySelection(text).then(
      () => this.flash(`Copied ${Array.from(text).length} chars`),
      (error) => this.fail(error),
    );
  }
  // $VISUAL, $EDITOR, or nvim, vim or nano (notepad on Windows), on the draft in full; what
  // it leaves in the file comes back to the box, whatever the editor exits with (0.5.0).
  private async editor(): Promise<boolean> {
    if (this.externalEditor) throw new Error('an editor is already running');
    const words = editorCommand(process.env, this.terminal.platform);
    if (!words) {
      this.fail('No $VISUAL / $EDITOR set, and no nvim, vim or nano found');
      return false;
    }
    const directory = mkdtempSync(join(tmpdir(), 'circle-editor-'));
    const path = join(directory, 'draft.md');
    // The editor gets the draft in full, pastes written out
    writeFileSync(path, this.composer.modelText(this.state.draft), {
      mode: 0o600,
    });
    this.lendTerminal();
    try {
      try {
        await new Promise<void>((resolveEditor, reject) => {
          const child = spawn(words[0]!, [...words.slice(1), path], {
            cwd: this.workspace,
            stdio: 'inherit',
          });
          child.once('error', reject);
          child.once('exit', () => resolveEditor());
        });
      } finally {
        this.takeTerminal();
      }
      // Back in the box like a paste: a long text folded again
      this.composer.clear();
      this.composer.paste(readFileSync(path, 'utf8').replace(/\n+$/, ''));
      return true;
    } catch (error) {
      this.fail(
        `Could not open the editor: ${error instanceof Error ? error.message : String(error)}`,
      );
      return false;
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }
  exit(code: number): void {
    if (this.ended) return;
    this.ended = true;
    this.pending?.abort?.();
    this.done(code);
  }
  async wait(): Promise<number> {
    return this.completion;
  }
  // Once: the exit guard and runTui may both close, and the lines are written only once.
  close(): Promise<void> {
    this.closing ??= this.closeOnce();
    return this.closing;
  }
  private async closeOnce(): Promise<void> {
    this.ended = true;
    this.off?.();
    this.offSignals?.();
    this.interactions.close();
    this.pending?.abort?.();
    this.input.close();
    this.theme.close();
    if (this.animation) clearInterval(this.animation);
    if (this.flashTimer) clearTimeout(this.flashTimer);
    this.selection.close();
    process.stdout.off('resize', this.resizeListener);
    process.off('SIGINT', this.signalListener);
    this.terminal.input(false);
    this.terminal.write(
      '\x1b[?1000l\x1b[?1002l\x1b[?1006l\x1b[?2004l\x1b[?25h\x1b[?1049l\x1b[23;0t',
    );
    // As 0.5.0 did once the screen was gone: the jobs that leaving stopped, then the
    // command that opens this conversation again.
    const runtime = this.runtime;
    const jobs = runtime ? runningJobs(runtime) : 0;
    const hint = runtime ? resumeHint(runtime, this.workspace) : '';
    await runtime?.close();
    for (const line of [stoppedJobsLine(jobs), hint])
      if (line) this.terminal.write(line + '\n');
  }
}
export async function runTui(
  options: Omit<RuntimeOptions, 'approve' | 'question'> & {
    init?: boolean;
    pickSession?: boolean;
    prompts?: string[];
    // What the conversation shows for each prompt, when it differs (`@file`)
    shown?: string[];
  },
): Promise<number> {
  const app = new SessionApp(options.workspace, options.home, options.settings);
  app.start();
  try {
    if (!(await app.initialize(options.init))) return 0;
    app.applyRunSettings(options.modelOverride);
    await app.attach(options);
    void app.checkForUpdate();
    if (options.pickSession) await app.command('resume', '');
    // The first message starts a turn; the others follow it, one turn each.
    const [first, ...rest] = options.prompts ?? [];
    if (first !== undefined)
      void app.submit(first, first, false, options.shown?.[0] || first);
    for (const [index, prompt] of rest.entries()) {
      const shown = options.shown?.[index + 1];
      if (shown && shown !== prompt)
        app.runtime?.harness.shown.set(prompt, { display: shown });
      app.runtime?.harness.queue(prompt, 'followUp');
    }
    return await app.wait();
  } finally {
    await app.close();
  }
}
