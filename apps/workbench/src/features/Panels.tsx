import { desktopHost } from '../host';
import { NativeBrowser } from './NativeBrowser';
import { usePlugins } from '../plugins/context';
import { PluginBoundary } from '../plugins/Boundary';
import { useEffect, useState } from 'react';
import {
  FileText,
  Folder,
  ChevronRight,
  ChevronDown,
  X,
  ArrowUpRight,
  Terminal,
  Globe,
  FileDiff,
  Layers,
  Activity,
  Download,
  Plus,
  RotateCcw,
  ExternalLink,
  Search,
  Play,
  Users,
  ShieldCheck,
  Check,
} from 'lucide-react';
import { useRuntime } from '../app/context';
import { currentSession } from '../model/state';
import type { PanelId, Interaction, DialogId } from '../model/types';
import {
  Button,
  IconButton,
  SearchInput,
  Status,
  Facts,
  DataBlock,
  FileChip,
} from '../components/common';
export const PANEL_DEFINITIONS = [
  { id: 'files', label: 'files', icon: Folder, plugin: 'files' },
  { id: 'changes', label: 'changes', icon: FileDiff, plugin: 'files' },
  { id: 'context', label: 'context', icon: Layers },
  { id: 'activity', label: 'activity', icon: Activity, plugin: 'activity' },
  { id: 'browser', label: 'browser', icon: Globe, plugin: 'browser' },
] as const;
interface Props {
  panel: PanelId;
  selection: string;
  onPanel: (panel: PanelId, selection?: string) => void;
  onClose: () => void;
  onFile: (path: string) => void;
  onAgent: (id: string) => void;
  onInteraction: (item: Interaction) => void;
  onDialog: (dialog: DialogId, selection?: string) => void;
}
export function Inspector(props: Props) {
  const { snapshot } = useRuntime();
  const { registry, enabled } = usePlugins();
  const session = currentSession(snapshot);
  const panels = registry
    .active(enabled)
    .flatMap((plugin) =>
      (plugin.panels ?? []).map((panel) => ({ plugin, panel })),
    );
  const selected = panels.find((item) => item.panel.id === props.panel);
  const active = selected ? props.panel : 'context';
  return (
    <aside className="inspector">
      <header className="inspector-tabs">
        <div>
          <button
            aria-label="context panel"
            title="context"
            className={active === 'context' ? 'active' : ''}
            onClick={() => props.onPanel('context')}
          >
            <Layers size={15} />
          </button>
          {panels.map(({ panel }) => (
            <button
              key={panel.id}
              aria-label={panel.title + ' panel'}
              title={panel.title}
              className={active === panel.id ? 'active' : ''}
              onClick={() => props.onPanel(panel.id)}
            >
              <panel.icon size={15} />
            </button>
          ))}
        </div>
        <IconButton label="close inspector" onClick={props.onClose}>
          <X size={15} />
        </IconButton>
      </header>
      <div className="inspector-body">
        {selected ? (
          <PluginBoundary key={selected.panel.id} name={selected.plugin.title}>
            <selected.panel.component {...props} sessionId={session.id} />
          </PluginBoundary>
        ) : (
          <ContextPanel {...props} />
        )}
      </div>
    </aside>
  );
}
export function FilesPanel({
  selection,
  onFile,
}: Pick<Props, 'selection' | 'onFile'>) {
  const { snapshot } = useRuntime();
  const [query, setQuery] = useState('');
  const session = currentSession(snapshot);
  const files = snapshot.files.filter(
    (file) =>
      file.workspaceId === session.workspaceId &&
      file.path.toLowerCase().includes(query.toLowerCase()),
  );
  const folders = [
    ...new Set(
      files.map((file) =>
        file.path.includes('/') ? file.path.split('/')[0]! : 'root',
      ),
    ),
  ];
  return (
    <>
      <div className="inspector-heading">
        <h2>files</h2>
        <span>
          {snapshot.workspaces.find(
            (workspace) => workspace.id === session.workspaceId,
          )?.origin === 'native'
            ? 'local workspace'
            : 'sample workspace'}
        </span>
      </div>
      <SearchInput
        value={query}
        onChange={setQuery}
        label="search files"
        placeholder="find a file…"
      />
      <div className="file-tree">
        {folders.map((folder) => (
          <div key={folder}>
            {folder !== 'root' && (
              <div className="tree-folder">
                <ChevronDown size={12} />
                <Folder size={14} />
                {folder}
              </div>
            )}
            {files
              .filter(
                (file) =>
                  (file.path.includes('/')
                    ? file.path.split('/')[0]
                    : 'root') === folder,
              )
              .map((file) => (
                <button
                  className={selection === file.path ? 'active' : ''}
                  key={file.id}
                  onClick={() => onFile(file.path)}
                >
                  <FileText size={14} />
                  <span>{file.path.split('/').at(-1)}</span>
                  {file.status && (
                    <small className={file.status}>
                      {file.status === 'added' ? 'A' : 'M'}
                    </small>
                  )}
                </button>
              ))}
          </div>
        ))}
      </div>
      <p className="panel-note">
        {snapshot.workspaces.find(
          (workspace) => workspace.id === session.workspaceId,
        )?.origin === 'native'
          ? 'Selected folder. Files are read through granted handles; saving a buffer does not write to disk.'
          : 'Files shown here are isolated sample data. Opening a file does not access your disk.'}
      </p>
    </>
  );
}
export function ChangesPanel({ onFile }: Pick<Props, 'onFile'>) {
  const { snapshot, runtime, notify } = useRuntime();
  const session = currentSession(snapshot);
  const changes = snapshot.files.filter(
    (file) => file.workspaceId === session.workspaceId && file.status,
  );
  return (
    <>
      <div className="inspector-heading">
        <h2>changes</h2>
        <span>{changes.length} files</span>
      </div>
      <div className="change-summary">
        <FileDiff size={18} />
        <div>
          <strong>working changes</strong>
          <p>sample · not applied to disk</p>
        </div>
      </div>
      {changes.map((file) => (
        <button
          className="change-file"
          key={file.id}
          onClick={() => onFile(file.path)}
        >
          <FileText size={15} />
          <span>
            {file.path}
            <small>{file.status}</small>
          </span>
          <ChevronRight size={13} />
        </button>
      ))}
      <div className="panel-section">
        <h3>review</h3>
        <p>
          Compare the proposed content with the original. Accepting a proposal
          needs the connected runtime.
        </p>
        <Button
          disabled={session.readOnly || !changes.length}
          onClick={() => {
            runtime.request('apply-changes', {
              fileIds: changes.map((file) => file.id),
            });
            notify('apply request recorded; no workspace file changed');
          }}
        >
          request apply
          <ArrowUpRight size={12} />
        </Button>
      </div>
    </>
  );
}
export function ContextPanel({ onDialog }: Pick<Props, 'onDialog'>) {
  const { snapshot, runtime, perform } = useRuntime();
  const session = currentSession(snapshot);
  const workspace = snapshot.workspaces.find(
    (item) => item.id === session.workspaceId,
  )!;
  const { registry, enabled } = usePlugins();
  const widgets = registry.widgets(enabled, 'widgets');
  return (
    <>
      <div className="inspector-heading">
        <h2>session context</h2>
        <button className="text-button" onClick={() => onDialog('session')}>
          details
          <ArrowUpRight size={12} />
        </button>
      </div>
      <Facts
        values={{
          workspace: workspace.path,
          model: session.model,
          effort: session.effort,
          mode: session.readOnly ? 'read-only' : session.auto ? 'auto' : 'ask',
          connection: 'not connected',
        }}
      />
      <div className="panel-section">
        <h3>instructions</h3>
        {workspace.instructions.map((item) => (
          <details key={item.name} className="context-source">
            <summary>
              <FileText size={14} />
              {item.name}
            </summary>
            <pre>{item.content}</pre>
          </details>
        ))}
      </div>
      <div className="panel-section">
        <h3>
          attached context <span>{session.attachments.length}</span>
        </h3>
        {session.attachments.length ? (
          session.attachments.map((file) => (
            <details className="context-source" key={file.id}>
              <summary>
                <FileText size={14} />
                {file.name}
                <span>{file.kind}</span>
              </summary>
              {file.kind === 'image' ? (
                <img
                  className="attachment-image"
                  src={file.content}
                  alt={file.name}
                />
              ) : (
                <pre>{file.content}</pre>
              )}
              {file.truncated && (
                <p className="panel-note">
                  preview truncated; original file not stored
                </p>
              )}
              <Button
                onClick={() =>
                  perform(() =>
                    runtime.change((state) => {
                      currentSession(state).attachments = currentSession(
                        state,
                      ).attachments.filter((item) => item.id !== file.id);
                    }),
                  )
                }
              >
                remove
              </Button>
            </details>
          ))
        ) : (
          <p className="muted">no files or skills attached</p>
        )}
      </div>
      {widgets.map(({ plugin, widget }) => (
        <PluginBoundary key={widget.id} name={plugin.title}>
          <widget.component sessionId={session.id} />
        </PluginBoundary>
      ))}
      <div className="panel-section">
        <h3>
          pending requests{' '}
          <span>
            {
              snapshot.requests.filter((item) => item.sessionId === session.id)
                .length
            }
          </span>
        </h3>
        {snapshot.requests
          .filter((item) => item.sessionId === session.id)
          .slice(0, 8)
          .map((request) => (
            <details className="context-source" key={request.id}>
              <summary>
                {request.kind}
                <small>not sent</small>
              </summary>
              <DataBlock title="request" value={request} />
            </details>
          ))}
      </div>
    </>
  );
}
export function ActivityPanel({
  selection,
  onAgent,
  onInteraction,
  onDialog,
}: Pick<Props, 'selection' | 'onAgent' | 'onInteraction' | 'onDialog'>) {
  const { snapshot, runtime, perform } = useRuntime();
  const session = currentSession(snapshot);
  const [all, setAll] = useState(false);
  const [selected, setSelected] = useState(selection);
  useEffect(() => setSelected(selection), [selection]);
  const job = snapshot.jobs.find((item) => item.id === selected);
  const jobs = snapshot.jobs.filter(
    (item) => all || item.sessionId === session.id,
  );
  const interactions = snapshot.interactions.filter(
    (item) => item.sessionId === session.id,
  );
  return (
    <>
      <div className="inspector-heading">
        <h2>activity</h2>
        <button className="text-button" onClick={() => setAll(!all)}>
          {all ? 'this session' : 'all sessions'}
        </button>
      </div>
      {job ? (
        <div className="job-detail">
          <button className="text-button" onClick={() => setSelected('')}>
            ← jobs
          </button>
          <h3>
            {job.id} · {job.title}
          </h3>
          <Status value={job.state} />
          <Facts
            values={{
              elapsed: job.elapsed,
              output: job.outputPath,
              stop: job.stopRequested
                ? 'requested · unverified'
                : 'not requested',
            }}
          />
          <pre>{job.output}</pre>
          <div className="detail-actions">
            {job.state === 'running' || job.state === 'waiting' ? (
              <Button
                disabled={job.stopRequested}
                onClick={() => onDialog('job-stop', job.id)}
              >
                request stop
              </Button>
            ) : (
              <Button
                onClick={() =>
                  perform(() => {
                    runtime.change((state) => {
                      state.jobs = state.jobs.filter(
                        (item) => item.id !== job.id,
                      );
                    });
                    setSelected('');
                  })
                }
              >
                remove from preview
              </Button>
            )}
            {job.agentId && (
              <Button onClick={() => onAgent(job.agentId!)}>
                agent record
              </Button>
            )}
          </div>
        </div>
      ) : (
        <>
          <div className="panel-section first">
            <h3>
              jobs <span>{jobs.length}</span>
            </h3>
            {jobs.map((item) => (
              <button
                className="activity-row"
                key={item.id}
                onClick={() => setSelected(item.id)}
              >
                <Terminal size={15} />
                <span>
                  <strong>
                    {item.id} · {item.title}
                  </strong>
                  <small>
                    {item.sessionId !== session.id ? 'other session · ' : ''}
                    {item.elapsed}
                    {item.stopRequested ? ' · stop requested' : ''}
                  </small>
                </span>
                <Status value={item.state} />
              </button>
            ))}
          </div>
          <div className="panel-section">
            <h3>subagents</h3>
            {snapshot.agents
              .filter((agent) => agent.sessionId === session.id)
              .map((agent) => (
                <button
                  className="activity-row"
                  key={agent.id}
                  onClick={() => onAgent(agent.id)}
                >
                  <Users size={15} />
                  <span>
                    <strong>{agent.name}</strong>
                    <small>{agent.description}</small>
                  </span>
                  <Status value={agent.status} />
                </button>
              ))}
          </div>
        </>
      )}
      <div className="panel-section">
        <h3>
          requests{' '}
          <span>
            {interactions.filter((item) => item.status === 'pending').length}
          </span>
        </h3>
        {interactions.map((item) => (
          <button
            className="activity-row"
            key={item.id}
            onClick={() => onInteraction(item)}
          >
            <ShieldCheck size={15} />
            <span>
              <strong>{item.title}</strong>
              <small>
                {item.kind} ·{' '}
                {item.status === 'pending'
                  ? 'sample request'
                  : 'response saved locally'}
              </small>
            </span>
            <ChevronRight size={13} />
          </button>
        ))}
      </div>
    </>
  );
}
export function BrowserPanel() {
  return desktopHost() ? <NativeBrowser /> : <BrowserPlaceholder />;
}
function BrowserPlaceholder() {
  const { runtime, notify } = useRuntime();
  const [url, setUrl] = useState('https://app.example.test');
  return (
    <>
      <div className="browser-address">
        <Globe size={13} />
        <input
          aria-label="browser address"
          value={url}
          onChange={(event) => setUrl(event.target.value)}
        />
        <IconButton
          label="request navigation"
          onClick={() => {
            try {
              const parsed = new URL(url);
              if (!['https:', 'http:'].includes(parsed.protocol)) throw Error();
              runtime.request('browser.navigate', { url });
              notify('navigation requested; no browser is attached');
            } catch {
              notify('enter an http or https URL');
            }
          }}
        >
          <ArrowUpRight size={14} />
        </IconButton>
      </div>
      <div className="browser-empty">
        <Globe size={32} />
        <h3>no browser attached</h3>
        <p>
          The desktop host will display the browser that the agent is using.
        </p>
        <span className="label">layout preview</span>
      </div>
      <div className="panel-section">
        <h3>same session, shared view</h3>
        <p>
          Page observation and control will refer to one browser session.
          Navigation requests are currently saved locally.
        </p>
      </div>
    </>
  );
}
export function TerminalPanel({ onClose }: { onClose: () => void }) {
  const { runtime, snapshot } = useRuntime();
  const session = currentSession(snapshot);
  const [input, setInput] = useState('');
  const [output, setOutput] = useState<string[]>([
    'terminal not connected',
    'commands stay in the preview request log',
  ]);
  useEffect(() => {
    setInput('');
    setOutput([
      'terminal not connected',
      'commands stay in the preview request log',
    ]);
  }, [session.id]);
  return (
    <section className="terminal-pane">
      <header>
        <span>
          <Terminal size={14} />
          terminal{' '}
          <small>
            {
              snapshot.workspaces.find(
                (workspace) => workspace.id === session.workspaceId,
              )?.name
            }
          </small>
        </span>
        <div>
          <span className="muted small">not connected</span>
          <IconButton label="close terminal" onClick={onClose}>
            <X size={13} />
          </IconButton>
        </div>
      </header>
      <pre>{output.join('\n')}</pre>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (input.trim()) {
            runtime.request('execute', { command: input });
            setOutput((lines) => [
              ...lines,
              '$ ' + input,
              'not executed · runtime connection required',
            ]);
            setInput('');
          }
        }}
      >
        <span>›</span>
        <input
          aria-label="terminal command"
          value={input}
          placeholder="enter a command…"
          onChange={(event) => setInput(event.target.value)}
        />
        <button aria-label="record terminal command">
          <ArrowUpRight size={14} />
        </button>
      </form>
    </section>
  );
}
