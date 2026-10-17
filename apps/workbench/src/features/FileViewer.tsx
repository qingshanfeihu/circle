import { useEffect, useRef, useState } from 'react';
import {
  Activity,
  Bug,
  ChevronUp,
  FileText,
  Save,
  TriangleAlert,
  X,
} from 'lucide-react';
import { Tooltip } from 'radix-ui';
import type { IRange } from 'monaco-editor';
import { useRuntime } from '../app/context';
import { currentSession } from '../model/state';
import { Button, IconButton, Status } from '../components/common';
import { dateLocale, t, tn } from '../i18n';
import { copyText } from '../host';
import type { WorkspaceServiceEvent } from '../../../desktop/src/workspace-protocol';
import {
  workspaceCall,
  subscribeWorkspace,
  connectWorkspaceStreams,
} from '../model/workspace-client';
import {
  NativeCodeEditor,
  editorDocuments,
  editorBuffer,
  editorUri,
  pendingEditorDocuments,
  retainedModel,
  refreshEditorDocument,
  setEditorDocument,
} from './NativeCodeEditor';
import type { EditorDocument } from './NativeCodeEditor';
import type { SourceResourceOwner } from '../model/source-resource-owner';
type SaveFlight = {
  queued?: { all: boolean; restore: boolean };
  writes: Map<string, string>;
  latest: Map<string, EditorDocument>;
};
type LanguageProcessStatus = {
  kind: 'external' | 'in-process';
  provider: string;
  state: 'idle' | 'starting' | 'running' | 'stopping' | 'exited' | 'failed';
  pid?: number;
  command?: string;
  cwd?: string;
  stderrTail?: string;
  exitCode?: number;
  signal?: string;
  reason?: string;
  canStop: boolean;
  canRestart: boolean;
};
type LanguageOwner = { identity: string; sequence: number; busy: boolean };
type DiagnosticHistory = {
  owner: LanguageOwner;
  events: WorkspaceServiceEvent[];
  cursor: { offset: number; seq: number };
  hasMore: boolean;
  loaded: boolean;
  pending: boolean;
  error?: string;
  errorTitle?: string;
};
function diagnosticBatches(events: WorkspaceServiceEvent[]) {
  const batches = new Map<
    string,
    {
      id: string;
      at: string;
      provider?: string;
      version?: number;
      count: number;
      parts: Map<number, string>;
      invalid: boolean;
    }
  >();
  for (const event of events) {
    const data = event.data;
    if (
      data.kind !== 'diagnostics' ||
      typeof data.batchId !== 'string' ||
      !Number.isSafeInteger(data.index) ||
      !Number.isSafeInteger(data.count) ||
      Number(data.count) < 1 ||
      Number(data.index) < 0 ||
      Number(data.index) >= Number(data.count) ||
      typeof data.body !== 'string'
    )
      continue;
    let batch = batches.get(data.batchId);
    if (!batch) {
      batch = {
        id: data.batchId,
        at: event.at,
        count: Number(data.count),
        provider: typeof data.provider === 'string' ? data.provider : undefined,
        version:
          typeof data.documentVersion === 'number'
            ? data.documentVersion
            : undefined,
        parts: new Map(),
        invalid: false,
      };
      batches.set(batch.id, batch);
    }
    const old = batch.parts.get(Number(data.index));
    if (batch.count !== data.count || (old !== undefined && old !== data.body))
      batch.invalid = true;
    batch.parts.set(Number(data.index), data.body);
  }
  return [...batches.values()].map((batch) => {
    const parts = [...batch.parts].sort(([a], [b]) => a - b);
    const body = parts.map(([, text]) => text).join('');
    let diagnostics: Record<string, unknown>[] = [];
    let complete =
      !batch.invalid &&
      parts.length === batch.count &&
      parts.every(([index], position) => index === position);
    if (complete) {
      try {
        const parsed = JSON.parse(body);
        complete = Array.isArray(parsed);
        if (complete) diagnostics = parsed;
      } catch {
        complete = false;
      }
    }
    return { ...batch, body, complete, diagnostics };
  });
}
const LANGUAGE_STATE_LABEL = {
  idle: () => t('idle'),
  starting: () => t('starting'),
  running: () => t('running'),
  stopping: () => t('stopping'),
  exited: () => t('exited'),
  failed: () => t('failed'),
};
const DIAGNOSTIC_SEVERITY_LABEL: Record<number, () => string> = {
  8: () => t('error'),
  4: () => t('warning'),
  2: () => t('information'),
  1: () => t('hint'),
};
const MODE_LABEL = {
  edit: (readOnly: boolean) => (readOnly ? t('view') : t('edit')),
  diff: () => t('diff'),
};
export function FileViewer({
  path: requestedPath,
  line,
  column,
  resourceOwner,
  onClose,
  onDebugSource,
  onNavigate: onSourceNavigate,
}: {
  path: string;
  line?: number;
  column?: number;
  resourceOwner?: SourceResourceOwner;
  onClose: () => void;
  onDebugSource?: (path: string, line?: number) => void;
  onNavigate?: (
    path: string,
    line?: number,
    column?: number,
  ) => void | Promise<void>;
}) {
  const { snapshot, runtime, perform, notify } = useRuntime();
  const parentSession = currentSession(snapshot);
  const session = resourceOwner
    ? {
        ...parentSession,
        id: resourceOwner.sessionId,
        workspaceId: resourceOwner.workspaceId,
        readOnly: resourceOwner.readOnly,
      }
    : parentSession;
  const workspaceId = session.workspaceId;
  const [path, setPath] = useState(
    requestedPath.replace(/#L\d+(?:C\d+)?$/, ''),
  );
  const projected = snapshot.files.find(
    (item) => item.path === path && item.workspaceId === workspaceId,
  );
  // Files open editable in place; "diff" compares with the disk or git
  // original only when asked, as a changed file does by default.
  const [mode, setMode] = useState<'diff' | 'edit'>(
    projected?.status ? 'diff' : 'edit',
  );
  const [document, setDocument] = useState<EditorDocument | null>(null);
  const [loadedKey, setLoadedKey] = useState<string | null>(null);
  const identity = JSON.stringify([workspaceId, session.id, path]);
  const currentIdentity = useRef(identity);
  currentIdentity.current = identity;
  const [value, setValue] = useState(
    projected?.draft ?? projected?.content ?? '',
  );
  const [selection, setSelection] = useState<IRange>();
  const [error, setError] = useState('');
  const [conflict, setConflict] = useState<EditorDocument | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveQueued, setSaveQueued] = useState(false);
  const inFlightSaves = useRef(new Map<string, SaveFlight>());
  const [projectErrors, setProjectErrors] = useState<
    {
      path?: string;
      message: string;
      source?: string;
      startLineNumber: number;
      startColumn: number;
    }[]
  >([]);
  const languageOwner = useRef<LanguageOwner>({
    identity,
    sequence: 0,
    busy: false,
  });
  if (languageOwner.current.identity !== identity)
    languageOwner.current = { identity, sequence: 0, busy: false };
  const owner = languageOwner.current;
  const [languageDetailsOpen, setLanguageDetailsOpen] = useState(false);
  const [languageView, setLanguageView] = useState<{
    owner: LanguageOwner;
    status?: LanguageProcessStatus;
    error?: string;
    pending?: 'stop' | 'restart';
  }>({ owner });
  const languageViewCurrent: typeof languageView =
    languageView.owner === owner ? languageView : { owner };
  const [diagnosticHistoryOpen, setDiagnosticHistoryOpen] = useState(false);
  const emptyHistory = (): DiagnosticHistory => ({
    owner,
    events: [],
    cursor: { offset: 0, seq: 0 },
    hasMore: true,
    loaded: false,
    pending: false,
  });
  const [diagnosticHistory, setDiagnosticHistory] =
    useState<DiagnosticHistory>(emptyHistory);
  const history =
    diagnosticHistory.owner === owner ? diagnosticHistory : emptyHistory();
  const historyRequest = useRef(0);
  const historyPending = useRef<LanguageOwner | null>(null);
  const [copyingDiagnostic, setCopyingDiagnostic] =
    useState<LanguageOwner | null>(null);
  useEffect(
    () => () => {
      owner.sequence++;
    },
    [owner],
  );
  const [loading, setLoading] = useState(true);
  const [missing, setMissing] = useState(false);
  const [moved, setMoved] = useState<EditorDocument | null>(null);
  const [bufferCount, setBufferCount] = useState(0);
  const live = runtime.mode === 'live';
  useEffect(() => {
    if (!resourceOwner || !live) return;
    return connectWorkspaceStreams(workspaceId, session.id, (error) =>
      setError(String(error)),
    );
  }, [workspaceId, session.id, live, !!resourceOwner]);
  const language = /\.[cm]?tsx?$/.test(path)
    ? 'typescript'
    : /\.[cm]?jsx?$/.test(path)
      ? 'javascript'
      : (projected?.language ?? 'plaintext');
  const readOnly = resourceOwner
    ? resourceOwner.readOnly
    : session.readOnly &&
      !['plan', 'plan.md'].includes(path.split('/').at(-1)!);
  const sourceWorkspace = snapshot.workspaces.find(
    (item) => item.id === workspaceId,
  );
  const sourceAgent =
    resourceOwner &&
    snapshot.agents.find(
      (item) =>
        item.resourceSessionId === resourceOwner.sessionId &&
        item.workspaceId === resourceOwner.workspaceId &&
        item.id === resourceOwner.sessionId,
    );
  const sourceLabel = resourceOwner
    ? sourceAgent
      ? t('agent source: {name}', { name: sourceAgent.name })
      : t('agent source')
    : t('workspace: {name}', {
        name: sourceWorkspace?.name ?? t('workspace'),
      });
  // The heading names the file once; its folder and owner follow, muted.
  const shownSource = resourceOwner
    ? sourceLabel
    : (sourceWorkspace?.name ?? t('workspace'));
  const sourceDirectory = sourceWorkspace?.path;
  const fileName = path.split('/').at(-1) || path;
  const fileFolder = path.includes('/')
    ? path.slice(0, path.lastIndexOf('/'))
    : '';
  const sourceHeading = (
    <div className="file-view-title">
      <div className="file-view-filename">
        <FileText size={15} aria-hidden />
        <strong title={path}>{fileName}</strong>
        {projected?.status && <Status value={projected.status} />}
      </div>
      <div className="file-source-summary">
        {fileFolder && (
          <span className="file-source-folder" title={fileFolder}>
            {fileFolder}
          </span>
        )}
        <Tooltip.Root>
          <Tooltip.Trigger asChild>
            <span
              tabIndex={0}
              className="file-source-origin"
              aria-label={
                sourceDirectory
                  ? `${sourceLabel}: ${sourceDirectory}`
                  : sourceLabel
              }
            >
              {shownSource}
            </span>
          </Tooltip.Trigger>
          <Tooltip.Portal>
            <Tooltip.Content
              className="tooltip file-source-directory"
              sideOffset={7}
            >
              {sourceLabel}
              <br />
              {sourceDirectory ?? t('source directory is not available')}
              <Tooltip.Arrow />
            </Tooltip.Content>
          </Tooltip.Portal>
        </Tooltip.Root>
        {readOnly && (
          <span className="file-source-readonly">{t('read-only')}</span>
        )}
      </div>
    </div>
  );
  const showDocument = (doc: EditorDocument) => {
    const uri = editorUri(workspaceId, doc.path).toString();
    const model = retainedModel(
      workspaceId,
      doc.path,
      projected?.draft ?? doc.content,
      language,
    );
    let retained = editorDocuments.get(uri);
    if (retained && retained.revision !== doc.revision) {
      const result = refreshEditorDocument(workspaceId, doc);
      if (result === 'conflict') {
        setConflict(doc);
        setError(t('file changed on disk; your changes are kept'));
      }
      retained = editorDocuments.get(uri);
    }
    if (!retained) setEditorDocument(workspaceId, doc);
    setLoadedKey(JSON.stringify([workspaceId, session.id, doc.path]));
    if (doc.path !== path) {
      setPath(doc.path);
      void onSourceNavigate?.(doc.path);
    }
    setDocument(retained ?? doc);
    setValue(
      retainedModel(
        workspaceId,
        doc.path,
        projected?.draft ?? doc.content,
        language,
      ).getValue(),
    );
  };
  useEffect(() => {
    const next = requestedPath.replace(/#L\d+(?:C\d+)?$/, '');
    setPath(next);
    const anchor = requestedPath.match(/#L(\d+)(?:C(\d+))?$/);
    const row = line ?? (anchor ? Number(anchor[1]) : undefined);
    if (row)
      setSelection({
        startLineNumber: row,
        startColumn: column ?? Number(anchor?.[2] ?? 1),
        endLineNumber: row,
        endColumn: column ?? Number(anchor?.[2] ?? 1),
      });
    else setSelection(undefined);
  }, [requestedPath, line, column]);
  useEffect(() => {
    let active = true;
    const readIdentity = identity;
    setError('');
    setConflict(null);
    setMissing(false);
    setMoved(null);
    setDocument(null);
    setLoadedKey(null);
    setSaving(inFlightSaves.current.has(identity));
    setSaveQueued(false);
    setLoading(true);
    if (live) {
      void workspaceCall<EditorDocument>(session.id, 'documents', 'read', {
        path,
      })
        .then((doc) => {
          if (active && currentIdentity.current === readIdentity)
            showDocument(doc);
        })
        .catch((cause) => {
          if (!active || currentIdentity.current !== readIdentity) return;
          retainedModel(workspaceId, path, '', language);
          const prior = editorDocuments.get(
            editorUri(workspaceId, path).toString(),
          );
          if (prior) showDocument(prior);
          const message = String(
            cause instanceof Error ? cause.message : cause,
          );
          const deleted = /ENOENT|no such file|does not exist/i.test(message);
          setMissing(deleted);
          setError(
            deleted && prior
              ? t('file deleted on disk; your changes are kept')
              : message,
          );
        })
        .finally(() => {
          if (active && currentIdentity.current === readIdentity)
            setLoading(false);
        });
    } else {
      if (projected)
        showDocument({ path, content: projected.content, revision: 'preview' });
      setLoading(false);
    }
    return () => {
      active = false;
    };
  }, [path, workspaceId, session.id, live]);
  useEffect(() => {
    const update = () =>
      setBufferCount(pendingEditorDocuments(workspaceId).length);
    const failure = () =>
      setError(
        t('unsaved changes could not be backed up; keep this window open'),
      );
    window.addEventListener('circle-editor-change', update);
    window.addEventListener('circle-editor-persistence-error', failure);
    update();
    return () => {
      window.removeEventListener('circle-editor-change', update);
      window.removeEventListener('circle-editor-persistence-error', failure);
    };
  }, [workspaceId]);
  useEffect(() => {
    if (!live) return;
    let alive = true;
    let generation = 0;
    const sequences = new Map<string, number>();
    const reads = new Map<string, number>();
    return (() => {
      const unsubscribe = subscribeWorkspace((event) => {
        if (
          event.service !== 'documents' ||
          event.workspaceId !== workspaceId ||
          event.sessionId !== session.id
        )
          return;
        if (event.seq <= (sequences.get(event.epoch) ?? -1)) return;
        sequences.set(event.epoch, event.seq);
        const snapshot = (event.data.snapshot ?? event.data) as {
          files?: { path: string }[];
          changes?: { kind: string; file: { path: string } }[];
        };
        const paths = Array.isArray(event.data.paths)
          ? event.data.paths.filter(
              (item): item is string => typeof item === 'string',
            )
          : (snapshot.changes ?? []).map((change) => change.file.path);
        const currentGeneration = ++generation;
        for (const target of new Set(paths)) {
          const uri = editorUri(workspaceId, target).toString();
          if (!editorDocuments.has(uri)) continue;
          const readVersion = (reads.get(target) ?? 0) + 1;
          reads.set(target, readVersion);
          const removed =
            snapshot.changes?.some(
              (change) =>
                change.kind === 'removed' && change.file.path === target,
            ) && !snapshot.files?.some((file) => file.path === target);
          if (removed) {
            if (target !== path) continue;
            setMissing(true);
            setConflict(null);
            setError(t('file deleted on disk; your changes are kept'));
            const added =
              snapshot.changes
                ?.filter((change) => change.kind === 'added')
                .map((change) => change.file.path) ?? [];
            void Promise.all(
              added.map((candidate) =>
                workspaceCall<EditorDocument>(session.id, 'documents', 'read', {
                  path: candidate,
                }).catch(() => null),
              ),
            ).then((documents) => {
              if (!alive || currentGeneration !== generation) return;
              const previous = editorDocuments.get(uri);
              const matches = documents.filter(
                (document): document is EditorDocument =>
                  !!document && document.content === previous?.content,
              );
              setMoved(matches.length === 1 ? matches[0]! : null);
            });
            continue;
          }
          const readCurrent = async () => {
            // Recheck a snapshot overtaken by our own save, but never spin
            // indefinitely under continuous writes. A newer event supersedes us.
            for (let attempt = 0; attempt < 3; attempt++) {
              if (!alive || reads.get(target) !== readVersion) return;
              const baselineRevision = editorDocuments.get(uri)?.revision;
              const document = await workspaceCall<EditorDocument>(
                session.id,
                'documents',
                'read',
                { path: target },
              );
              if (!alive || reads.get(target) !== readVersion) return;
              if (editorDocuments.get(uri)?.revision !== baselineRevision)
                continue;
              const pending = [...inFlightSaves.current.values()].find(
                (flight) => flight.writes.has(uri),
              );
              if (pending) {
                // The pre-save disk baseline is expected while the write is pending.
                if (document.revision === baselineRevision) return;
                pending.latest.set(uri, document);
                if (
                  target === path &&
                  document.content !== pending.writes.get(uri)
                ) {
                  setConflict(document);
                  setError(t('file changed on disk; your changes are kept'));
                }
                return;
              }
              const result = refreshEditorDocument(workspaceId, document);
              if (target !== path) return;
              setMissing(false);
              setMoved(null);
              if (result === 'conflict') {
                setConflict(document);
                setError(t('file changed on disk; your changes are kept'));
              } else if (result === 'updated') {
                setDocument(document);
                setValue(
                  retainedModel(
                    workspaceId,
                    path,
                    document.content,
                    language,
                  ).getValue(),
                );
                setConflict(null);
                setError('');
              }
              return;
            }
            throw Error(t('file changed on disk; your changes are kept'));
          };
          void readCurrent().catch((cause) => {
            if (alive && reads.get(target) === readVersion && target === path)
              setError(String(cause instanceof Error ? cause.message : cause));
          });
        }
      });
      return () => {
        alive = false;
        unsubscribe();
      };
    })();
  }, [workspaceId, session.id, path, live, language]);
  useEffect(() => {
    setProjectErrors([]);
    const update = (event: Event) => {
      const detail = (event as CustomEvent).detail;
      if (detail.workspaceId === workspaceId)
        setProjectErrors(detail.diagnostics);
    };
    window.addEventListener('circle-language-project', update);
    return () => window.removeEventListener('circle-language-project', update);
  }, [workspaceId]);
  useEffect(() => {
    if (!live || !languageDetailsOpen) return;
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      if (!active || languageOwner.current !== owner) return;
      if (!owner.busy) {
        const sequence = ++owner.sequence;
        try {
          const status = await workspaceCall<LanguageProcessStatus>(
            session.id,
            'language',
            'request',
            { method: 'status', path },
          );
          if (
            active &&
            languageOwner.current === owner &&
            owner.sequence === sequence
          )
            setLanguageView({ owner, status });
        } catch (cause) {
          if (
            active &&
            languageOwner.current === owner &&
            owner.sequence === sequence
          )
            setLanguageView((view) => ({
              ...(view.owner === owner ? view : { owner }),
              error: String(cause instanceof Error ? cause.message : cause),
            }));
        }
      }
      if (active) timer = setTimeout(poll, 1000);
    };
    void poll();
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [live, languageDetailsOpen, owner, session.id, path]);
  const controlLanguage = async (method: 'stop' | 'restart') => {
    if (!live || readOnly || owner.busy || languageOwner.current !== owner)
      return;
    owner.busy = true;
    const sequence = ++owner.sequence;
    setLanguageView((view) => ({
      ...(view.owner === owner ? view : { owner }),
      pending: method,
      error: undefined,
    }));
    try {
      const status = await workspaceCall<LanguageProcessStatus>(
        session.id,
        'language',
        'request',
        { method, path },
      );
      if (languageOwner.current === owner && owner.sequence === sequence)
        setLanguageView({ owner, status });
    } catch (cause) {
      if (languageOwner.current === owner && owner.sequence === sequence)
        setLanguageView((view) => ({
          ...(view.owner === owner ? view : { owner }),
          pending: undefined,
          error: String(cause instanceof Error ? cause.message : cause),
        }));
    } finally {
      owner.busy = false;
    }
  };
  const acceptsDiagnostic = (event: WorkspaceServiceEvent) =>
    event.workspaceId === workspaceId &&
    event.sessionId === session.id &&
    event.service === 'language' &&
    event.resourceId === path &&
    event.data.kind === 'diagnostics';
  const appendDiagnostics = (events: WorkspaceServiceEvent[]) => {
    const accepted = events.filter(acceptsDiagnostic);
    setDiagnosticHistory((previous) => {
      if (languageOwner.current !== owner) return previous;
      const current = previous.owner === owner ? previous : emptyHistory();
      const merged = new Map(
        current.events.map((event) => [`${event.epoch}:${event.seq}`, event]),
      );
      for (const event of accepted)
        merged.set(`${event.epoch}:${event.seq}`, event);
      return {
        ...current,
        events: [...merged.values()].sort((a, b) => a.seq - b.seq),
      };
    });
  };
  const readDiagnosticHistory = async () => {
    if (
      !live ||
      historyPending.current === owner ||
      languageOwner.current !== owner
    )
      return;
    historyPending.current = owner;
    const sequence = ++historyRequest.current;
    const version = editorBuffer(workspaceId, path)?.version;
    const current = () =>
      languageOwner.current === owner &&
      historyRequest.current === sequence &&
      editorBuffer(workspaceId, path)?.version === version;
    setDiagnosticHistory((previous) => ({
      ...(previous.owner === owner ? previous : emptyHistory()),
      pending: true,
      error: undefined,
      errorTitle: undefined,
    }));
    try {
      const page = await workspaceCall<{
        events: WorkspaceServiceEvent[];
        cursor: DiagnosticHistory['cursor'];
        hasMore: boolean;
      }>(session.id, 'events', 'replay', { after: history.cursor, limit: 32 });
      if (!current()) return;
      if (
        page.cursor.seq < history.cursor.seq ||
        page.cursor.offset < history.cursor.offset ||
        (page.hasMore && page.cursor.seq === history.cursor.seq)
      )
        throw Error(t('no newer history was returned; try again'));
      appendDiagnostics(page.events);
      setDiagnosticHistory((previous) =>
        languageOwner.current !== owner
          ? previous
          : {
              ...previous,
              owner,
              cursor: page.cursor,
              hasMore: page.hasMore,
              loaded: true,
              pending: false,
            },
      );
    } catch (cause) {
      if (current())
        setDiagnosticHistory((previous) => ({
          ...previous,
          owner,
          pending: false,
          error: String(cause instanceof Error ? cause.message : cause),
        }));
    } finally {
      if (historyPending.current === owner) historyPending.current = null;
      if (
        languageOwner.current === owner &&
        historyRequest.current === sequence
      )
        setDiagnosticHistory((previous) =>
          previous.owner === owner ? { ...previous, pending: false } : previous,
        );
    }
  };
  useEffect(() => {
    if (!live || !languageDetailsOpen || !diagnosticHistoryOpen) return;
    if (!history.loaded) void readDiagnosticHistory();
    return subscribeWorkspace((event) => {
      if (languageOwner.current === owner && acceptsDiagnostic(event))
        appendDiagnostics([event]);
    });
  }, [live, languageDetailsOpen, diagnosticHistoryOpen, owner]);
  const copyDiagnostic = async (
    batch: ReturnType<typeof diagnosticBatches>[number],
  ) => {
    if (
      !batch.complete ||
      languageOwner.current !== owner ||
      copyingDiagnostic === owner
    )
      return;
    setCopyingDiagnostic(owner);
    try {
      await copyText(batch.body);
      if (languageOwner.current === owner) notify(t('diagnostics copied'));
    } catch (cause) {
      if (languageOwner.current === owner)
        setDiagnosticHistory((previous) => ({
          ...previous,
          errorTitle: t('could not copy diagnostics'),
          error: String(cause instanceof Error ? cause.message : cause),
        }));
    } finally {
      if (languageOwner.current === owner) setCopyingDiagnostic(null);
    }
  };
  const changed = (text: string) => {
    setValue(text);
    setBufferCount(pendingEditorDocuments(workspaceId).length);
  };
  const navigate = async (target: string, range?: IRange) => {
    setSelection(range);
    setMode('edit');
    setPath(target);
    await onSourceNavigate?.(
      target,
      range?.startLineNumber,
      range?.startColumn,
    );
  };
  const save = async (all = false, restore = false) => {
    const buffer = editorBuffer(workspaceId, path);
    if (
      !document ||
      document.path !== path ||
      loadedKey !== identity ||
      !buffer ||
      readOnly
    )
      return;
    const currentFlight = inFlightSaves.current.get(identity);
    if (currentFlight) {
      currentFlight.queued = { all, restore };
      if (currentIdentity.current === identity) setSaveQueued(true);
      return;
    }
    const baseline = editorDocuments.get(buffer.uri) ?? document;
    if (!all && !restore && buffer.content === baseline.content) {
      if (currentIdentity.current === identity) notify(t('file saved'));
      return;
    }
    const flight: SaveFlight = {
      writes: new Map([[buffer.uri, buffer.content]]),
      latest: new Map(),
    };
    inFlightSaves.current.set(identity, flight);
    let completed = false;
    // Capture one immutable target before any asynchronous operation. Never route
    // an old editor's value to whichever path/session is selected after a reply.
    const target = {
      key: identity,
      workspaceId,
      sessionId: session.id,
      path,
      revision: baseline.revision,
      content: buffer.content,
      version: buffer.version,
      fileId: projected?.id,
    };
    const selected = () => currentIdentity.current === target.key;
    if (selected()) {
      setSaving(true);
      setSaveQueued(false);
      setError('');
    }
    try {
      if (!live) {
        if (selected()) notify(t('changes kept in this window'));
        completed = true;
        return;
      }
      if (all) {
        const edits = pendingEditorDocuments(target.workspaceId).map(
          (item) => ({
            path: item.path,
            content: item.content,
            expectedRevision: item.revision,
          }),
        );
        for (const edit of edits)
          flight.writes.set(
            editorUri(target.workspaceId, edit.path).toString(),
            edit.content,
          );
        const result = await workspaceCall<{
          status: string;
          applied?: EditorDocument[];
          committedPaths?: string[];
          remaining?: { path: string }[];
          failures?: { path: string; message?: string }[];
        }>(target.sessionId, 'documents', 'applyEdits', { edits });
        for (const committed of result.committedPaths ?? []) {
          const doc =
            result.applied?.find((document) => document.path === committed) ??
            (await workspaceCall<EditorDocument>(
              target.sessionId,
              'documents',
              'read',
              { path: committed },
            ));
          setEditorDocument(target.workspaceId, doc);
          if (selected() && committed === target.path) setDocument(doc);
        }
        if (result.status !== 'applied' || result.failures?.length) {
          const committed = new Set(result.committedPaths ?? []);
          const remaining =
            result.remaining?.map((edit) => edit.path) ??
            edits
              .map((edit) => edit.path)
              .filter((path) => !committed.has(path));
          throw Error(
            [
              t('saved: {saved}; not saved: {unsaved}', {
                saved: [...committed].join(', ') || t('none'),
                unsaved: remaining.join(', ') || t('none'),
              }),
              ...(result.failures ?? []).map(
                (item) =>
                  `${item.path}: ${item.message ?? t('file changed on disk')}`,
              ),
            ].join('\n'),
          );
        }
      } else {
        const doc = await workspaceCall<EditorDocument>(
          target.sessionId,
          'documents',
          'save',
          {
            path: target.path,
            content: target.content,
            expectedRevision: restore ? null : target.revision,
          },
        );
        if (doc.path !== target.path)
          throw Error(t('the file changed while saving; reopen it'));
        setEditorDocument(target.workspaceId, doc);
        if (selected()) {
          setDocument(doc);
          const external = flight.latest.get(buffer.uri);
          // The save checked the revision it wrote over, so a change seen
          // during it landed after it. Refresh as for any change on disk: a
          // buffer with nothing new takes it, one edited meanwhile keeps the
          // edit and shows the conflict.
          const result =
            external &&
            external.revision !== doc.revision &&
            external.content !== doc.content
              ? refreshEditorDocument(target.workspaceId, external)
              : 'unchanged';
          if (result === 'conflict') {
            setConflict(external!);
            setError(t('file changed on disk; your changes are kept'));
          } else {
            // A change seen during the save was shown as a conflict until
            // now; the buffer took it or never differed from it.
            setError('');
            if (result === 'updated') {
              setDocument(external!);
              setValue(
                retainedModel(
                  target.workspaceId,
                  target.path,
                  external!.content,
                  language,
                ).getValue(),
              );
            }
            setConflict(null);
          }
          setMissing(false);
          setMoved(null);
        }
        if (target.fileId)
          runtime.change((state) => {
            const item = state.files.find(
              (file) =>
                file.id === target.fileId &&
                file.workspaceId === target.workspaceId &&
                file.path === target.path,
            );
            if (item) {
              item.content = doc.content;
              item.draft = undefined;
            }
          });
      }
      completed = true;
      if (selected()) {
        setBufferCount(pendingEditorDocuments(target.workspaceId).length);
        notify(t('file saved'));
      }
    } catch (cause) {
      if (!selected()) return;
      setError(String(cause instanceof Error ? cause.message : cause));
      try {
        const disk = await workspaceCall<EditorDocument>(
          target.sessionId,
          'documents',
          'read',
          { path: target.path },
        );
        if (selected()) {
          // SaveAll may have committed this file before a later file failed.
          const baseline = editorDocuments.get(buffer.uri);
          if (disk.revision !== (baseline?.revision ?? target.revision)) {
            if (disk.content !== baseline?.content) setConflict(disk);
            else {
              setEditorDocument(target.workspaceId, disk);
              setDocument(disk);
            }
          }
        }
      } catch {
        /* Keep the original failure and the target's retained draft. */
      }
    } finally {
      inFlightSaves.current.delete(target.key);
      if (selected()) {
        setSaving(false);
        setSaveQueued(false);
      }
      if (completed && flight.queued)
        await save(flight.queued.all, flight.queued.restore);
    }
  };
  if (
    loading ||
    (document && (document.path !== path || loadedKey !== identity))
  )
    return (
      <section className="file-view">
        <header className="file-view-heading">
          {sourceHeading}
          <IconButton label={t('close file')} onClick={onClose}>
            <X size={15} />
          </IconButton>
        </header>
        <div className="empty-state" role="status">
          {t('loading file')}
        </div>
      </section>
    );
  if (!document)
    return (
      <div className="empty-state">
        <h3>{t('file not found')}</h3>
        {error && <p role="alert">{error}</p>}
        <Button onClick={onClose}>{t('back to conversation')}</Button>
      </div>
    );
  const dirty = value !== document.content;
  const codeChecks = (live || !!projectErrors.length) && (
    <details
      className={`editor-project-diagnostics${projectErrors.length ? ' attention' : ''}`}
      role={projectErrors.length ? 'alert' : undefined}
      open={languageDetailsOpen}
      onToggle={(event) => setLanguageDetailsOpen(event.currentTarget.open)}
    >
      <summary>
        {projectErrors.length ? (
          <TriangleAlert size={12} aria-hidden />
        ) : (
          <Activity size={12} aria-hidden />
        )}
        {!projectErrors.length
          ? t('code checks')
          : projectErrors.every((problem) => problem.source === 'configuration')
            ? t('project configuration needs attention')
            : t('code checks need attention')}
        {projectErrors.length ? ` (${projectErrors.length})` : ''}
        <ChevronUp size={12} aria-hidden className="disclosure" />
      </summary>
      <div className="editor-language-panel">
        {live && languageViewCurrent.status && (
          <div
            className="editor-language-status"
            aria-label={t('code checks status')}
            aria-busy={!!languageViewCurrent.pending}
          >
            <span>
              {languageViewCurrent.status.provider} ·{' '}
              {LANGUAGE_STATE_LABEL[languageViewCurrent.status.state]()}
            </span>
            {(languageViewCurrent.status.pid !== undefined ||
              !!languageViewCurrent.status.command ||
              !!languageViewCurrent.status.cwd) && (
              <details>
                <summary>{t('process details')}</summary>
                {languageViewCurrent.status.pid !== undefined && (
                  <span>
                    {t('process id')}: {languageViewCurrent.status.pid}
                  </span>
                )}
                {languageViewCurrent.status.command && (
                  <span>
                    {t('command')}:{' '}
                    <code>{languageViewCurrent.status.command}</code>
                  </span>
                )}
                {languageViewCurrent.status.cwd && (
                  <span>
                    {t('working directory')}:{' '}
                    <code>{languageViewCurrent.status.cwd}</code>
                  </span>
                )}
              </details>
            )}
            {languageViewCurrent.status.exitCode !== undefined && (
              <span>
                {t('exit code')}: {languageViewCurrent.status.exitCode}
              </span>
            )}
            {languageViewCurrent.status.signal && (
              <span>
                {t('ended by signal {signal}', {
                  signal: languageViewCurrent.status.signal,
                })}
              </span>
            )}
            {languageViewCurrent.status.reason && (
              <span>{languageViewCurrent.status.reason}</span>
            )}
            {languageViewCurrent.status.stderrTail && (
              <pre aria-label={t('error output')}>
                {languageViewCurrent.status.stderrTail}
              </pre>
            )}
            {languageViewCurrent.status.kind === 'external' && (
              <Button
                disabled={
                  readOnly ||
                  !!languageViewCurrent.pending ||
                  !languageViewCurrent.status.canStop
                }
                onClick={() => void controlLanguage('stop')}
              >
                {languageViewCurrent.pending === 'stop'
                  ? t('stopping')
                  : t('stop')}
              </Button>
            )}
            <Button
              disabled={
                readOnly ||
                !!languageViewCurrent.pending ||
                !languageViewCurrent.status.canRestart
              }
              onClick={() => void controlLanguage('restart')}
            >
              {languageViewCurrent.pending === 'restart'
                ? languageViewCurrent.status.kind === 'in-process'
                  ? t('refreshing…')
                  : t('restarting…')
                : languageViewCurrent.status.kind === 'in-process'
                  ? t('refresh')
                  : t('restart')}
            </Button>
            {languageViewCurrent.status.kind === 'in-process' && (
              <details>
                <summary>{t('details')}</summary>
                <span>{t('runs inside Circle')}</span>
              </details>
            )}
          </div>
        )}
        {live && !languageViewCurrent.status && !languageViewCurrent.error && (
          <span>{t('checking status…')}</span>
        )}
        {live && languageViewCurrent.error && (
          <div>
            <span role="alert">{t('could not update code checks')}</span>
            <details>
              <summary>{t('details')}</summary>
              <pre>{languageViewCurrent.error}</pre>
            </details>
          </div>
        )}
        {live && (
          <details
            className="editor-diagnostic-history"
            open={diagnosticHistoryOpen}
            onToggle={(event) =>
              setDiagnosticHistoryOpen(event.currentTarget.open)
            }
          >
            <summary>{t('diagnostic history')}</summary>
            {diagnosticBatches(history.events).map((batch) => (
              <details
                key={batch.id}
                data-diagnostic-batch={batch.id}
                className="editor-diagnostic-batch"
              >
                <summary title={batch.at}>
                  {new Date(batch.at).toLocaleString(dateLocale())}
                  {batch.provider && ` · ${batch.provider}`}
                  {batch.version !== undefined &&
                    ` · ${t('document version {version}', { version: batch.version })}`}
                </summary>
                {batch.complete ? (
                  <>
                    {!batch.diagnostics.length && (
                      <span>{t('no problems')}</span>
                    )}
                    {!!batch.diagnostics.length && (
                      <ul>
                        {batch.diagnostics.map((problem, index) => (
                          <li key={index}>
                            {String(problem.source ?? batch.provider ?? '')}{' '}
                            {typeof problem.severity === 'number' &&
                              `${DIAGNOSTIC_SEVERITY_LABEL[problem.severity]?.() ?? t('severity {severity}', { severity: problem.severity })} · `}
                            {typeof problem.startLineNumber === 'number' &&
                              `${t('line {line}', { line: problem.startLineNumber })} · `}
                            {typeof problem.message === 'string'
                              ? problem.message
                              : ''}
                          </li>
                        ))}
                      </ul>
                    )}
                    <details>
                      <summary>{t('original diagnostic data')}</summary>
                      <pre>{batch.body}</pre>
                    </details>
                  </>
                ) : (
                  <span>{t('diagnostic batch incomplete; read more')}</span>
                )}
                <Button
                  disabled={!batch.complete || copyingDiagnostic === owner}
                  onClick={() => void copyDiagnostic(batch)}
                >
                  {t('copy complete diagnostics')}
                </Button>
              </details>
            ))}
            {history.loaded && !history.events.length && (
              <span>
                {history.hasMore
                  ? t('no diagnostics in this page; continue reading')
                  : t('no diagnostic history')}
              </span>
            )}
            {history.hasMore && (
              <Button
                disabled={history.pending}
                onClick={() => void readDiagnosticHistory()}
              >
                {history.pending
                  ? t('reading diagnostic history')
                  : t('read more diagnostic history')}
              </Button>
            )}
            {history.error && (
              <div>
                <span role="alert">
                  {history.errorTitle ?? t('could not read diagnostic history')}
                </span>
                <details>
                  <summary>{t('details')}</summary>
                  <pre>{history.error}</pre>
                </details>
              </div>
            )}
          </details>
        )}
        {projectErrors.map((problem, index) => (
          <span key={index}>
            {problem.path && (
              <Button
                onClick={() => {
                  setSelection({
                    startLineNumber: problem.startLineNumber,
                    startColumn: problem.startColumn,
                    endLineNumber: problem.startLineNumber,
                    endColumn: problem.startColumn,
                  });
                  void navigate(problem.path!, {
                    startLineNumber: problem.startLineNumber,
                    startColumn: problem.startColumn,
                    endLineNumber: problem.startLineNumber,
                    endColumn: problem.startColumn,
                  });
                }}
              >
                {problem.path}
              </Button>
            )}{' '}
            {problem.message}
          </span>
        ))}
      </div>
    </details>
  );
  return (
    <section className="file-view">
      <header className="file-view-heading">
        {sourceHeading}
        {onDebugSource && /\.[cm]?[jt]sx?$/i.test(path) && (
          <IconButton
            label={t('debug file')}
            disabled={readOnly || saving || missing || !!conflict}
            onClick={() => onDebugSource(path, line)}
          >
            <Bug size={15} />
          </IconButton>
        )}
        <IconButton label={t('close file')} onClick={onClose}>
          <X size={15} />
        </IconButton>
      </header>
      <div className="file-view-toolbar">
        <div className="segmented" role="group" aria-label={t('file view')}>
          {(['edit', 'diff'] as const).map((item) => (
            <button
              key={item}
              type="button"
              className={mode === item ? 'active' : ''}
              aria-pressed={mode === item}
              onClick={() => setMode(item)}
            >
              {MODE_LABEL[item](readOnly)}
            </button>
          ))}
        </div>
        <span
          className={`file-view-state${dirty ? ' dirty' : ''}`}
          role="status"
        >
          {dirty ? t('unsaved changes') : t('all changes saved')}
        </span>
        {bufferCount > 1 && (
          <Button
            disabled={readOnly || saving}
            onClick={() => perform(() => save(true))}
          >
            {t('save all')}
          </Button>
        )}
        <Button
          className={dirty ? 'primary' : ''}
          disabled={readOnly || saving || !!conflict || missing}
          onClick={() => perform(() => save())}
        >
          <Save size={13} aria-hidden />
          {saveQueued
            ? t('save queued')
            : saving
              ? t('saving file')
              : t('save')}
        </Button>
      </div>
      {error && (
        <div className="editor-notice" role="alert">
          <span>{error}</span>
          {missing && (
            <Button
              disabled={readOnly || saving}
              onClick={() => perform(() => save(false, true))}
            >
              {t('restore file with your changes')}
            </Button>
          )}
          {moved && (
            <Button
              onClick={() => {
                setSelection(undefined);
                void navigate(moved.path);
              }}
            >
              {t('open possible moved file: {path}', { path: moved.path })}
            </Button>
          )}
          {conflict && (
            <Button
              onClick={() => {
                setMode('diff');
                setDocument(conflict);
                setEditorDocument(workspaceId, conflict);
                setError(
                  t('file changed on disk; review the diff before saving'),
                );
                setConflict(null);
              }}
            >
              {t('review disk changes')}
            </Button>
          )}
        </div>
      )}
      <NativeCodeEditor
        key={`${workspaceId}:${path}`}
        workspaceId={workspaceId}
        sessionId={session.id}
        path={path}
        value={value}
        original={
          document.content !== value ? document.content : projected?.original
        }
        language={language}
        readOnly={readOnly}
        diff={mode === 'diff'}
        live={live}
        selection={selection}
        onChange={changed}
        // As the save button: a conflict or a missing file is settled first.
        onSave={() => {
          if (!conflict && !missing) perform(() => save());
        }}
        onNavigate={navigate}
      />
      <footer className="file-view-footer">
        <span>
          {language} · {tn(value.split('\n').length, '{n} line', '{n} lines')}
        </span>
        {codeChecks}
      </footer>
    </section>
  );
}
