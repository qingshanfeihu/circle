import { QuestionCard } from '../ink/components/question_card.js';
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
  mkdirSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
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
  clearCredentials,
  withConnection,
} from '../settings.js';
import { defaultAuth } from '../settings.js';
import { normalizeBaseUrl, resolveEndpoint } from '../probe.js';
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
import { TranscriptFind } from './transcript_find.js';
import { InteractionQueue } from './interaction_queue.js';
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
import { loadRemap, ACTIONS } from '../keybindings.js';
import { emptyUsage, type ToolCall } from '../types.js';
import { ScreenRenderer } from '../ink/screen.js';
import { type ApprovalDecision } from '../harness.js';
import { BUILTIN_SLASH, parseSlash } from './slash_commands.js';
import { GatewayModel, EFFORT_LEVELS } from '../model.js';
import { exportKind, toHtml, toMarkdown } from '../session_export.js';
import {
  discoverCustomCommands,
  expandCommandTemplate,
  splitArguments,
} from '../commands.js';
import { loadSkillBody } from '../skills.js';
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
export { VERSION } from '../version.js';
interface DialogPending {
  complete: (answer: string) => void;
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
  private questionCard?: QuestionCard;
  private secretReady?: SecretRequest;
  private ended = false;
  private externalEditor = false;
  private animation?: NodeJS.Timeout;
  private flashTimer?: NodeJS.Timeout;
  private keyProblems: string[];
  private done!: (code: number) => void;
  private completion: Promise<number>;
  private previousSession = '';
  private lastEscape = 0;
  private history: InputHistory;
  private off?: () => void;
  private offSignals?: () => void;
  private jobWakeAt = 0;
  private jobWakeCount = 0;
  private jobWakeSnoozed = false;
  private interactions = new InteractionQueue(
    (background) =>
      !this.externalEditor &&
      !this.state.dialog &&
      (!background ||
        (!this.state.draft &&
          !this.state.picker &&
          !this.runtime?.harness.busy)),
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
  private shared?: string;
  private turns = new TurnStatus();
  private welcomeState: WelcomeState;
  // The runtime is loading the folder's things (attach): the welcome's lamps blink.
  private connecting = false;
  private started = false;
  private title = '';
  private titleAt = 0;
  private dataListener = (data: string): void => {
    if (this.externalEditor) return;
    for (const event of this.input.feed(data)) this.handle(event);
  };
  private resizeListener = (): void => this.repaint();
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
      '\x1b[22;0t\x1b[?1049h\x1b[?25l\x1b[?2004h\x1b[?1000h\x1b[?1006h',
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
    if (this.ended || this.externalEditor) return;
    if (this.runtime) {
      this.state.messages = this.runtime.harness.messages;
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
    this.screen.render(rows);
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
  private flash(text: string): void {
    this.state.flash = text;
    if (this.flashTimer) clearTimeout(this.flashTimer);
    this.flashTimer = setTimeout(() => {
      this.state.flash = '';
      this.repaint();
    }, 1800);
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
    this.state.draft = text;
    this.state.draftCursor = Array.from(text).length;
  }
  async initialize(force = false): Promise<boolean> {
    if (force || !this.settings.initialized) {
      const url = await this.askText(
        'connect',
        'API base URL',
        this.settings.auth.base_url,
      );
      if (this.ended || !url) return false;
      const old = loadCredentials(this.home);
      const key = await this.askText(
        'connect',
        'API key',
        old[this.settings.auth.api_key_ref] || old.api_key || '',
        true,
      );
      if (this.ended || !key) return false;
      const result = await resolveEndpoint(url, key);
      const protocol = result.inferred
        ? await this.askChoice('protocol', 'Choose the API protocol', [
            'openai',
            'anthropic',
          ])
        : result.protocol;
      if (this.ended || !protocol) return false;
      const model = await this.askText(
        'model',
        result.models.length
          ? 'Model ID (' + result.models.slice(0, 5).join(', ') + ')'
          : 'Model ID',
        this.settings.auth.model,
      );
      if (this.ended || !model) return false;
      const auth = {
        ...defaultAuth(),
        protocol,
        base_url: normalizeBaseUrl(url, protocol),
        model,
      };
      const settings = withConnection(auth, this.home);
      saveCredentials({ api_key: key }, this.home);
      saveSettings(settings, this.home);
      this.settings = settings;
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
    const { problems } = applyProjectSettings(this.settings, this.workspace);
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
      approve: (call, signal, origin) =>
        this.interactions.run(
          async () => {
            this.backgroundCard = Boolean(origin?.jobId);
            try {
              return await this.approve(
                call,
                signal,
                origin?.jobId ? `${origin.jobId} ${origin.name} · ` : '',
              );
            } finally {
              this.backgroundCard = false;
            }
          },
          signal,
          Boolean(origin?.jobId),
        ),
      question: (args, signal, origin) =>
        this.interactions.run(
          async () => {
            this.backgroundCard = Boolean(origin?.jobId);
            try {
              if (!Array.isArray(args.questions))
                throw new Error('invalid questions');
              const answers: string[][] = [];
              for (const question of args.questions as Question[])
                answers.push(
                  await this.askQuestion(
                    {
                      ...question,
                      header: origin?.jobId
                        ? `${origin.jobId} ${question.header}`
                        : question.header,
                    },
                    signal,
                  ),
                );
              return JSON.stringify(answers);
            } finally {
              this.backgroundCard = false;
            }
          },
          signal,
          Boolean(origin?.jobId),
        ),
      secret: (request, signal, origin) =>
        this.interactions.run(
          async () => {
            this.backgroundCard = Boolean(origin?.jobId);
            try {
              await this.enterSecret(
                {
                  ...request,
                  question:
                    (origin?.jobId ? `${origin.jobId} · ` : '') +
                    request.question,
                },
                signal,
              );
            } finally {
              this.backgroundCard = false;
            }
          },
          signal,
          Boolean(origin?.jobId),
        ),
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
        this.state.hiddenTurns = 0;
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
        this.state.notices.push('✖ ' + String(event.payload.message));
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
  private async askQuestion(
    question: Question,
    signal: AbortSignal,
  ): Promise<string[]> {
    const card = new QuestionCard(question);
    this.questionCard = card;
    try {
      return JSON.parse(await this.dialog(card.state(), signal)) as string[];
    } finally {
      this.questionCard = undefined;
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
      const value = await this.askText(
        'secret',
        `${request.question}\n${request.key} → ${request.target_file}`,
        '',
        true,
        signal,
      );
      if (!value) {
        await cancelRequest(this.home, request.id);
        return;
      }
      await submitAnswer(this.home, request.id, value);
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
  private askText(
    title: string,
    body: string,
    initial = '',
    masked = false,
    signal?: AbortSignal,
  ): Promise<string> {
    return this.dialog(
      { title, body, options: [], focus: 0, input: initial, masked },
      signal,
    );
  }
  private dialog(
    state: NonNullable<ScreenState['dialog']>,
    signal?: AbortSignal,
  ): Promise<string> {
    if (this.pending)
      return Promise.reject(new Error('another question is waiting'));
    if (signal?.aborted) return Promise.reject(signal.reason);
    this.state.dialog = state;
    this.state.waiting = true;
    return new Promise((resolve, reject) => {
      const abort = (): void => {
        this.pending = undefined;
        this.state.dialog = undefined;
        this.state.waiting = false;
        this.repaint();
        reject(signal?.reason || new Error('Interrupted'));
      };
      this.pending = {
        complete: (answer) => {
          signal?.removeEventListener('abort', abort);
          this.pending = undefined;
          this.state.dialog = undefined;
          this.state.waiting = false;
          this.repaint();
          resolve(answer);
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
    titlePrefix = '',
  ): Promise<ApprovalDecision> {
    const review = this.runtime!.policy.review(call.name, call.args);
    const choices = ['allow this call'];
    const decisions: ApprovalDecision[] = ['approve'];
    if (review.prefix.length && review.verdict === 'ASK') {
      choices.push(`allow "${review.prefix.join(' ')} …" for this session`);
      decisions.push('prefix');
    }
    if (review.pattern && review.verdict === 'ASK') {
      choices.push(`allow ${review.scope} for this session`);
      decisions.push('always');
    }
    choices.push('reject');
    decisions.push('reject');
    const answer = await this.askChoice(
      titlePrefix + 'approval',
      `${call.name}\n${JSON.stringify(call.args, null, 2)}`,
      choices,
      signal,
    );
    return decisions[choices.indexOf(answer)] || 'reject';
  }
  private handle(event: InputEvent): void {
    if (this.ended || this.externalEditor) return;
    this.theme.feed(event);
    if (event.type === 'color' || event.type === 'scheme') return;
    if (event.type === 'mouse') {
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
      } else if (this.questionCard) {
        this.questionCard.paste(event.text);
        this.state.dialog = this.questionCard.state();
      } else if (this.state.dialog?.input !== undefined)
        this.state.dialog.input += event.text;
      else this.insert(event.text);
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
    if (this.state.jobDetail && !this.state.dialog) {
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
      if (key === 'ctrl+c' && this.backgroundCard) return;
      const dialog = this.state.dialog;
      if (this.questionCard) {
        const answer = this.questionCard.handle(key, char);
        if (answer !== undefined)
          this.pending?.complete(JSON.stringify(answer));
        else this.state.dialog = this.questionCard.state();
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
    if (this.state.picker && !['ctrl+c', 'ctrl+d'].includes(key)) {
      this.state.picker.handle(key, char);
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
    if (key === 'ctrl+c') {
      this.jobWakeSnoozed = true;
      if (this.runtime?.busy) void this.runtime.cancel();
      else this.setDraft('');
    } else if (key === 'escape') {
      this.jobWakeSnoozed = true;
      if (this.runtime?.busy) void this.runtime.cancel();
      else if (
        !this.state.draft &&
        Date.now() - this.lastEscape < 600 &&
        this.settings.double_escape !== 'none'
      )
        void this.command(this.settings.double_escape, '');
      this.lastEscape = Date.now();
    } else if (key === 'ctrl+b') {
      const count = this.runtime?.jobs.backgroundForeground() ?? 0;
      this.flash(
        count
          ? `Moved ${count} command${count === 1 ? '' : 's'} to background`
          : 'No foreground command',
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
    } else if (key === 'ctrl+l')
      void this.command('models', '').catch((error) => this.fail(error));
    else if (key === 'ctrl+g')
      void this.command('editor', '').catch((error) => this.fail(error));
    else if (key === 'ctrl+x')
      void this.command('copy', '').catch((error) => this.fail(error));
    else if (key === 'ctrl+p')
      void this.cycleModel().catch((error) => this.fail(error));
    else if (key === 'shift+tab' && this.runtime) {
      const current = EFFORT_LEVELS.indexOf(
        this.runtime.thinkingLevel as (typeof EFFORT_LEVELS)[number],
      );
      void this.command(
        'effort',
        EFFORT_LEVELS[(current + 1) % EFFORT_LEVELS.length]!,
      ).catch((error) => this.fail(error));
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
    } else if (
      ['ctrl+q', 'alt+enter', 'alt+return'].includes(key) &&
      this.state.draft.trim()
    ) {
      const message = this.state.draft.trim();
      this.setDraft('');
      this.history.add(message);
      if (this.runtime?.busy) {
        this.runtime.harness.queue(message, 'followUp');
        this.flash('Queued follow-up');
      } else void this.submit(message).catch((error) => this.fail(error));
    } else if (key === 'shift+enter' || key === 'ctrl+j') this.insert('\n');
    else if (key === 'enter') {
      const message = this.state.draft.trim();
      if (message) {
        this.setDraft('');
        this.history.add(message);
        void this.submit(message).catch((error) => this.fail(error));
      }
    } else if (key === 'tab') this.completeDraft();
    else if (key === 'backspace') {
      const chars = Array.from(this.state.draft);
      if (this.state.draftCursor > 0) chars.splice(--this.state.draftCursor, 1);
      this.state.draft = chars.join('');
    } else if (key === 'delete' || key === 'ctrl+d') {
      const chars = Array.from(this.state.draft);
      chars.splice(this.state.draftCursor, 1);
      this.state.draft = chars.join('');
    } else if (key === 'left')
      this.state.draftCursor = Math.max(0, this.state.draftCursor - 1);
    else if (key === 'right')
      this.state.draftCursor = Math.min(
        Array.from(this.state.draft).length,
        this.state.draftCursor + 1,
      );
    else if (key === 'home' || key === 'ctrl+a') this.state.draftCursor = 0;
    else if (key === 'end' || key === 'ctrl+e')
      this.state.draftCursor = Array.from(this.state.draft).length;
    else if (key === 'up' || key === 'down') {
      const value =
        key === 'up' ? this.history.up(this.state.draft) : this.history.down();
      if (value !== undefined) this.setDraft(value);
    } else if (key === 'pageup')
      this.state.scroll += Math.max(1, (process.stdout.rows || 24) - 8);
    else if (key === 'pagedown')
      this.state.scroll = Math.max(
        0,
        this.state.scroll - Math.max(1, (process.stdout.rows || 24) - 8),
      );
    else if (char && !key.startsWith('ctrl+') && !key.startsWith('alt+'))
      this.insert(char);
    this.repaint();
  }
  private insert(text: string): void {
    const chars = Array.from(this.state.draft);
    chars.splice(this.state.draftCursor, 0, ...Array.from(text));
    this.state.draftCursor += Array.from(text).length;
    this.state.draft = chars.join('');
  }
  private completeDraft(): void {
    if (this.state.draft.startsWith('/') && !this.state.draft.includes(' ')) {
      const matches = BUILTIN_SLASH.filter((command) =>
        command.name.startsWith(this.state.draft.slice(1)),
      );
      if (matches[0]) this.setDraft('/' + matches[0].name + ' ');
    } else {
      const match = this.state.draft.match(/@([^\s]*)$/);
      if (match) {
        const matches = complete(match[1]!, this.workspace);
        if (matches[0])
          this.setDraft(
            this.state.draft.slice(0, match.index) + '@' + matches[0],
          );
      }
    }
  }
  async submit(message: string): Promise<void> {
    if (message === '?') {
      await this.command('hotkeys', '');
      return;
    }
    const slash = parseSlash(message);
    if (slash) {
      await this.command(slash.name, slash.args);
      return;
    }
    if (!this.runtime) return;
    if (message.startsWith('!')) {
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
  private picker(
    title: string,
    items: PickerItem[],
    choose: (item: PickerItem) => Promise<void> | void,
    options: PickerOptions = {},
  ): void {
    this.state.picker = new Picker(
      title,
      items,
      (item) => {
        this.state.picker = undefined;
        Promise.resolve(choose(item)).then(
          () => this.repaint(),
          (error) => this.fail(error),
        );
      },
      () => {
        this.state.picker = undefined;
        this.repaint();
      },
      {
        ...options,
        keys: Object.fromEntries(
          Object.entries(options.keys ?? {}).map(([key, action]) => [
            key,
            (item: PickerItem | undefined) => {
              Promise.resolve()
                .then(() => action(item))
                .then(
                  () => this.repaint(),
                  (error) => this.fail(error),
                );
            },
          ]),
        ),
      },
    );
    this.repaint();
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
    if (this.runtime.busy) throw new Error('a turn is running');
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
    const runtime = this.runtime;
    if (!runtime) return;
    if (name === 'exit') {
      this.exit(0);
      return;
    }
    if (name === 'jobs') {
      const jobs = runtime.jobs.list();
      if (args) {
        const job = runtime.jobs.get(args.trim());
        if (!job) throw new Error('unknown job');
        this.state.jobDetail = job;
        this.repaint();
      } else if (!jobs.length) this.notice('No background jobs');
      else
        this.picker(
          'Jobs',
          jobs.map((job) => ({
            key: job.id,
            label: `${job.id} · ${job.status} · ${job.title}`,
          })),
          async (item) => {
            this.state.jobDetail = runtime.jobs.get(item.key);
            this.repaint();
          },
        );
      return;
    }
    if (name === 'help') {
      this.notice(
        BUILTIN_SLASH.map(
          (command) => `/${command.name}  ${command.description}`,
        ).join('\n'),
      );
      return;
    }
    if (name === 'hotkeys') {
      this.notice(
        Object.entries(ACTIONS)
          .map(([action, key]) => `${key.padEnd(14)} ${action}`)
          .join('\n'),
      );
      return;
    }
    if (name === 'plan') {
      runtime.setPlanMode(
        args === 'on' || (args !== 'off' && !runtime.harness.planMode),
      );
      this.notice(
        runtime.harness.planMode ? 'Read-only mode on' : 'Read-only mode off',
      );
      return;
    }
    if (name === 'yolo') {
      runtime.policy.setYolo(runtime.session.id, args !== 'off');
      this.notice(args === 'off' ? 'Auto mode off' : 'Auto mode on');
      return;
    }
    if (name === 'thinking' && !args) {
      this.state.showThinking = !this.state.showThinking;
      this.repaint();
      return;
    }
    if (name === 'details') {
      this.state.showTools = !this.state.showTools;
      this.repaint();
      return;
    }
    if (name === 'themes') {
      if (!args) {
        this.notice(
          `Theme: ${this.settings.theme} · available: auto, dark, light`,
        );
        return;
      }
      if (!['auto', 'dark', 'light'].includes(args))
        throw new Error('use /themes auto|dark|light');
      const theme = args as CircleSettings['theme'];
      this.settings.theme = theme;
      saveSettingsChange(this.home, (saved) => {
        saved.theme = theme;
      });
      this.theme.mode = this.settings.theme;
      this.theme.apply();
      this.notice(
        theme === 'auto'
          ? `Theme → auto (${palette().is_dark ? 'dark' : 'light'})`
          : `Theme → ${theme}`,
      );
      return;
    }
    if (name === 'name') {
      runtime.store.rename(runtime.session.id, args);
      this.notice('Session renamed');
      return;
    }
    if (name === 'session') {
      const session = runtime.store.get(runtime.session.id)!;
      this.notice(
        `${session.id}\n${session.title}\n${this.workspace}\n${runtime.harness.model.model}\n${runtime.harness.messages.length} messages`,
      );
      return;
    }
    if (name === 'approvals') {
      if (args.startsWith('revoke '))
        runtime.policy.store.revoke(
          runtime.session.id,
          Number(args.slice(7)) - 1,
        );
      this.notice(
        runtime.policy.store
          .rules(runtime.session.id)
          .map((rule, index) => `${index + 1}. ${rule.tool}: ${rule.label}`)
          .join('\n') || 'No session rules',
      );
      return;
    }
    if (name === 'mcp' || name === 'extensions') {
      if (args === 'reload') {
        if (runtime.harness.busy) {
          this.flash(
            `reload ${name === 'mcp' ? 'MCP' : 'extensions'} after the current turn`,
          );
          return;
        }
        await runtime.reloadIntegrations();
      }
      this.notice(
        name === 'mcp' ? runtime.mcp.describe() : runtime.extensions.describe(),
      );
      return;
    }
    if (name === 'trust') {
      this.trustWorkspace();
      this.notice('Folder trusted');
      return;
    }
    if (name === 'undo') {
      this.state.hiddenTurns = Math.min(40, this.state.hiddenTurns + 1);
      this.repaint();
      return;
    }
    if (name === 'redo') {
      this.state.hiddenTurns = Math.max(0, this.state.hiddenTurns - 1);
      this.repaint();
      return;
    }
    if (name === 'new') {
      this.previousSession = runtime.session.id;
      await runtime.newSession();
      this.state.notices = [];
      this.state.hiddenTurns = 0;
      this.state.usage = emptyUsage();
      this.repaint();
      return;
    }
    if (name === 'continue') {
      if (!this.previousSession) throw new Error('no previous session');
      const current = runtime.session.id;
      await runtime.switchSession(this.previousSession);
      this.previousSession = current;
      this.repaint();
      return;
    }
    if (name === 'resume') {
      const sessions = runtime.store.list(this.workspace);
      const choose = async (id: string): Promise<void> => {
        this.previousSession = runtime.session.id;
        await runtime.switchSession(id);
        this.state.hiddenTurns = 0;
        this.state.notices = [];
      };
      if (args)
        await choose(
          /^\d+$/.test(args) ? sessions[Number(args) - 1]?.id || '' : args,
        );
      else
        this.picker(
          'sessions',
          sessions.map((session) => ({
            key: session.id,
            label: session.title || session.id,
            meta: session.id,
            current: session.id === runtime.session.id,
          })),
          (item) => choose(item.key),
        );
      return;
    }
    if (name === 'tree' || name === 'fork') {
      this.jobWakeSnoozed = true;
      if (runtime.harness.busy) throw new Error('a turn is running');
      const tree = runtime.store.tree(runtime.session.id);
      const choices = tree
        .filter((checkpoint) => !checkpoint.message.internal)
        .filter(
          (checkpoint) => name !== 'fork' || checkpoint.message.role === 'user',
        )
        .filter(
          (checkpoint) =>
            !args ||
            checkpoint.message.content
              .toLowerCase()
              .includes(args.toLowerCase()),
        );
      this.picker(
        name,
        choices.map((checkpoint) => ({
          key: checkpoint.id,
          label: `${checkpoint.message.role}: ${checkpoint.message.display || checkpoint.message.content || '(tool call)'}`,
          current:
            checkpoint.id === runtime.store.get(runtime.session.id)?.head,
        })),
        async (item) => {
          const checkpoint = runtime.store.checkpoint(item.key)!;
          if (!checkpoint.message)
            throw new Error('selected entry has no message');
          const head =
            checkpoint.message.role === 'user'
              ? checkpoint.parent
              : checkpoint.id;
          if (name === 'fork') {
            const session = runtime.store.fork(
              runtime.session.id,
              this.workspace,
              head,
            );
            await runtime.switchSession(session.id);
          } else runtime.store.select(runtime.session.id, head);
          if (checkpoint.message.role === 'user')
            this.setDraft(
              checkpoint.message.display || checkpoint.message.content,
            );
          this.state.notices = [];
          this.state.hiddenTurns = 0;
        },
      );
      return;
    }
    if (name === 'clone') {
      if (runtime.harness.busy) throw new Error('a turn is running');
      const session = runtime.store.fork(runtime.session.id, this.workspace);
      await runtime.switchSession(session.id);
      this.repaint();
      return;
    }
    if (name === 'models') {
      if (runtime.busy) throw new Error('a turn is running');
      const choose = (model: string): void => {
        if (runtime.harness.busy) throw new Error('a turn is running');
        runtime.setModel(model);
        this.notice(`Model → ${model}`);
      };
      if (args) choose(args);
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
        this.picker('models', rows(), (item) => choose(item.key), {
          hint: 'enter uses · ctrl+s saves default · tab changes ctrl+p scope',
          keys: {
            'ctrl+s': (item) => {
              if (!item) return;
              choose(item.key);
              this.settings.auth.model = item.key;
              saveSettingsChange(this.home, (saved) => {
                saved.auth.model = item.key;
              });
              this.state.picker = undefined;
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
                  ? `ctrl+p goes through ${next.length} models`
                  : 'ctrl+p goes through every listed model',
              );
            },
          },
        });
      }
      return;
    }
    if (name === 'effort' || name === 'thinking') {
      const choose = (effort: string): void => {
        if (!(EFFORT_LEVELS as readonly string[]).includes(effort))
          throw new Error('unknown thinking depth');
        runtime.setThinkingLevel(effort);
        this.notice(`Thinking → ${effort}`);
      };
      if (args) choose(args);
      else
        this.picker(
          'thinking depth',
          EFFORT_LEVELS.map((level) => ({ key: level, label: level })),
          (item) => choose(item.key),
          {
            hint: 'enter uses · ctrl+s saves default',
            keys: {
              'ctrl+s': (item) => {
                if (!item) return;
                choose(item.key);
                this.settings.default_thinking = item.key;
                saveSettingsChange(this.home, (saved) => {
                  saved.default_thinking = item.key;
                });
                this.state.picker = undefined;
              },
            },
          },
        );
      return;
    }
    if (name === 'skill' || name.startsWith('skill:')) {
      const value = name.startsWith('skill:')
        ? name.slice(6)
        : args.split(/\s+/)[0];
      if (!value)
        this.notice(
          runtime.skills
            .map((skill) => `${skill.name}  ${skill.description}`)
            .join('\n') || 'No skills found',
        );
      else
        await this.submit(loadSkillBody(value, runtime.skills) + '\n' + args);
      return;
    }
    if (name === 'compact') {
      if (runtime.busy) throw new Error('a turn is running');
      const result = await runtime.compact(args);
      if (result === 'Nothing to compact yet') this.notice(result);
      this.repaint();
      return;
    }
    if (name === 'init') {
      await runtime.harness.run(
        'Read the repository and write an AGENTS.md contributor guide. ' + args,
      );
      return;
    }
    if (name === 'export' || name === 'share') {
      const kind = name === 'share' ? 'md' : exportKind(args);
      const directory = join(
        this.home,
        name === 'share' ? 'shares' : 'exports',
      );
      mkdirSync(directory, { recursive: true });
      const path =
        args && !['html', 'jsonl', 'md'].includes(args)
          ? resolve(this.workspace, args)
          : join(directory, runtime.session.id + '.' + kind);
      const session = runtime.store.get(runtime.session.id)!;
      const meta = {
        thread_id: session.id,
        title: session.title,
        workspace: session.workspace,
        model: runtime.harness.model.model,
      };
      const messages = runtime.harness.messages;
      writeFileSync(
        path,
        kind === 'html'
          ? toHtml(messages, meta)
          : kind === 'jsonl'
            ? runtime.exportSession()
            : toMarkdown(messages, meta),
      );
      if (name === 'share') {
        this.shared = path;
        await this.copy(path);
      }
      this.notice(`Exported ${path}`);
      return;
    }
    if (name === 'unshare') {
      if (this.shared && existsSync(this.shared)) unlinkSync(this.shared);
      this.shared = undefined;
      this.notice('Local share removed');
      return;
    }
    if (name === 'import') {
      if (!args) throw new Error('use /import <path>');
      const text = readFileSync(resolve(this.workspace, args), 'utf8');
      if (args.endsWith('.jsonl')) await runtime.importSession(text);
      else {
        await runtime.newSession();
        runtime.store.append(runtime.session.id, [
          {
            id: crypto.randomUUID(),
            role: 'user',
            content: text.slice(0, 8000),
            display: text,
          },
        ]);
      }
      this.repaint();
      return;
    }
    if (name === 'copy') {
      await this.copy(
        runtime.harness.messages
          .filter((message) => message.role === 'assistant' && message.content)
          .at(-1)?.content || '',
      );
      this.flash('Copied answer');
      return;
    }
    if (name === 'editor') {
      await this.editor();
      return;
    }
    if (name === 'settings') {
      this.notice(JSON.stringify(this.settings, null, 2));
      return;
    }
    if (name === 'logout') {
      if (runtime.harness.busy) await runtime.harness.cancel();
      clearCredentials(this.home);
      this.settings.initialized = false;
      saveSettingsChange(this.home, (saved) => {
        saved.initialized = false;
      });
      this.exit(0);
      return;
    }
    if (name === 'login') {
      if (args === 'anthropic' || args === 'openai')
        throw new Error('OAuth sign-in is not available yet');
      if (runtime.harness.busy) throw new Error('a turn is running');
      if (await this.initialize(true)) {
        this.applyRunSettings(runtime.options.modelOverride);
        runtime.options.settings = this.settings;
        runtime.setModel(this.settings.auth.model);
      }
      return;
    }
    if (name === 'reload') {
      if (runtime.harness.busy) throw new Error('a turn is running');
      await runtime.reloadIntegrations();
      const keys = loadRemap(this.home);
      this.remap = keys.remap;
      for (const problem of keys.problems) this.fail(problem);
      this.settings = runtime.options.settings;
      runtime.setModel(this.settings.auth.model);
      this.notice('Settings and integrations reloaded');
      return;
    }
    const custom = discoverCustomCommands(this.workspace, this.home).find(
      (command) => command.name === name,
    );
    if (custom) {
      const prompt = await expandCommandTemplate(
        custom.template,
        args,
        runtime.sandbox,
        new AbortController().signal,
      );
      await this.submit(prompt);
      return;
    }
    const extensionCommand = runtime.extensions.commands().get(name);
    if (extensionCommand) {
      await extensionCommand.handler(args, {
        workspace: this.workspace,
        toast: (message) => this.notice(message),
        append: (message) => {
          runtime.store.append(runtime.session.id, [
            { id: crypto.randomUUID(), role: 'assistant', content: message },
          ]);
          this.repaint();
        },
        sendUserMessage: (message) => {
          void this.submit(message).catch((error) => this.fail(error));
        },
      });
      return;
    }
    throw new Error(`command not available: /${name}`);
  }
  private async copy(text: string): Promise<void> {
    const program =
      process.platform === 'darwin'
        ? 'pbcopy'
        : process.platform === 'win32'
          ? 'clip'
          : 'wl-copy';
    await new Promise<void>((resolveCopy) => {
      const child = spawn(program, [], { stdio: ['pipe', 'ignore', 'ignore'] });
      child.once('error', () => {
        const path = join(this.home, 'exports', 'clipboard.txt');
        mkdirSync(join(this.home, 'exports'), { recursive: true });
        writeFileSync(path, text);
        resolveCopy();
      });
      child.once('close', () => resolveCopy());
      child.stdin.end(text);
    });
  }
  private async editor(): Promise<void> {
    if (this.externalEditor) throw new Error('an editor is already running');
    const words = splitArguments(
      process.env.VISUAL ||
        process.env.EDITOR ||
        (process.platform === 'win32' ? 'notepad' : 'vi'),
    );
    const directory = mkdtempSync(join(tmpdir(), 'circle-editor-'));
    const path = join(directory, 'draft.md');
    writeFileSync(path, this.state.draft, { mode: 0o600 });
    this.externalEditor = true;
    process.stdin.off('data', this.dataListener);
    this.input.reset();
    process.stdin.pause();
    process.stdin.setRawMode(false);
    process.stdout.write(
      '\x1b[?1000l\x1b[?1006l\x1b[?2004l\x1b[?25h\x1b[?1049l\x1b[23;0t',
    );
    try {
      await new Promise<void>((resolveEditor, reject) => {
        const child = spawn(words[0]!, [...words.slice(1), path], {
          cwd: this.workspace,
          stdio: 'inherit',
        });
        child.once('error', reject);
        child.once('exit', (code) =>
          code === 0
            ? resolveEditor()
            : reject(new Error(`editor exited ${code}`)),
        );
      });
      this.setDraft(readFileSync(path, 'utf8'));
    } finally {
      rmSync(directory, { recursive: true, force: true });
      this.externalEditor = false;
      if (!this.ended) {
        process.stdin.setRawMode(true);
        process.stdin.resume();
        process.stdin.on('data', this.dataListener);
        process.stdout.write(
          `\x1b[22;0t\x1b]0;${this.title}\x07\x1b[?1049h\x1b[?25l\x1b[?2004h\x1b[?1000h\x1b[?1006h`,
        );
        this.screen.invalidate();
        this.repaint();
      }
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
  async close(): Promise<void> {
    this.ended = true;
    this.off?.();
    this.offSignals?.();
    this.interactions.close();
    this.pending?.abort?.();
    this.input.close();
    this.theme.close();
    if (this.animation) clearInterval(this.animation);
    if (this.flashTimer) clearTimeout(this.flashTimer);
    process.stdin.off('data', this.dataListener);
    process.stdout.off('resize', this.resizeListener);
    process.off('SIGINT', this.signalListener);
    process.stdin.setRawMode(false);
    process.stdin.pause();
    process.stdout.write(
      '\x1b[?1000l\x1b[?1006l\x1b[?2004l\x1b[?25h\x1b[?1049l\x1b[23;0t',
    );
    await this.runtime?.close();
  }
}
export async function runTui(
  options: Omit<RuntimeOptions, 'approve' | 'question'> & {
    init?: boolean;
    pickSession?: boolean;
    prompts?: string[];
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
    for (const prompt of options.prompts ?? []) void app.submit(prompt);
    return await app.wait();
  } finally {
    await app.close();
  }
}
