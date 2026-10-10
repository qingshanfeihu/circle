import { desktopHost } from '../host';
import { validateKeybindings } from '../model/shortcuts';
import { usePlugins } from '../plugins/context';
import { useState } from 'react';
import {
  Plus,
  Search,
  ArrowUpRight,
  Check,
  FileText,
  Terminal,
  Globe,
  Blocks,
  Settings2,
  ShieldCheck,
  Trash2,
  GitBranch,
  Copy,
  Pin,
  RotateCcw,
  Eye,
  ChevronRight,
  Command,
  BookOpen,
  Folder,
  Monitor,
  Code,
  Plug,
  MessageSquare,
} from 'lucide-react';
import { BUILTIN_SLASH } from '../../../../src/tui/slash_commands';
import { VERSION } from '../../../../src/version';
import { useRuntime } from '../app/context';
import { currentSession, EFFORTS } from '../model/state';
import type { DialogId, PageId, PanelId, McpServer } from '../model/types';
import {
  Page,
  SearchInput,
  Button,
  IconButton,
  Modal,
  Badge,
  DataBlock,
  Status,
  Switch,
  Facts,
  PreviewNotice,
} from '../components/common';
import { Markdown } from '../components/Markdown';
import { BUILTIN_TOOL_INFO } from '../model/tool-info';
interface Props {
  page: PageId;
  onSession: () => void;
  onDialog: (dialog: DialogId, selection?: string) => void;
  onPanel: (panel: PanelId, selection?: string) => void;
}
export function ManagementPage(props: Props) {
  switch (props.page) {
    case 'sessions':
      return <SessionsPage {...props} />;
    case 'models':
      return <ModelsPage onDialog={props.onDialog} />;
    case 'skills':
      return <SkillsPage />;
    case 'commands':
      return <CommandsPage />;
    case 'mcp':
      return <McpPage />;
    case 'extensions':
      return <ExtensionsPage />;
    case 'tools':
      return <ToolsPage />;
    case 'approvals':
      return <ApprovalsPage />;
    case 'settings':
      return <SettingsPage onDialog={props.onDialog} />;
    default:
      return <HelpPage onDialog={props.onDialog} />;
  }
}
function SessionsPage({ onSession, onDialog }: Props) {
  const { snapshot, runtime, perform } = useRuntime();
  const [search, setSearch] = useState('');
  const [all, setAll] = useState(false);
  const current = currentSession(snapshot);
  const sessions = snapshot.sessions.filter(
    (session) =>
      (all || session.workspaceId === current.workspaceId) &&
      (session.title + ' ' + session.id)
        .toLowerCase()
        .includes(search.toLowerCase()),
  );
  return (
    <Page
      title="sessions"
      description="Reopen a conversation or continue from an earlier point."
      action={
        <Button
          onClick={() => {
            runtime.newSession();
            onSession();
          }}
        >
          <Plus size={14} />
          new session
        </Button>
      }
    >
      <div className="list-toolbar">
        <SearchInput
          value={search}
          onChange={setSearch}
          label="search sessions"
        />
        <Switch label="all workspaces" checked={all} onChange={setAll} />
      </div>
      <div className="records">
        {sessions.map((session) => (
          <div className="record-row" key={session.id}>
            <button
              className="record-main"
              onClick={() => {
                runtime.selectSession(session.id);
                onSession();
              }}
            >
              <MessageSquare size={17} />
              <span>
                <strong>{session.title}</strong>
                <small>
                  {
                    snapshot.workspaces.find(
                      (workspace) => workspace.id === session.workspaceId,
                    )?.name
                  }{' '}
                  · {session.updatedAt}
                </small>
              </span>
              {session.id === current.id && <Badge>open</Badge>}
            </button>
            <IconButton
              label={`pin ${session.title}`}
              onClick={() =>
                perform(() =>
                  runtime.change((state) => {
                    const target = state.sessions.find(
                      (item) => item.id === session.id,
                    )!;
                    target.pinned = !target.pinned;
                  }),
                )
              }
            >
              <Pin size={14} fill={session.pinned ? 'currentColor' : 'none'} />
            </IconButton>
            <IconButton
              label={`rename ${session.title}`}
              onClick={() => onDialog('rename', session.id)}
            >
              <FileText size={14} />
            </IconButton>
            <IconButton
              label={`delete ${session.title}`}
              disabled={session.id === current.id}
              onClick={() => onDialog('delete-session', session.id)}
            >
              <Trash2 size={14} />
            </IconButton>
          </div>
        ))}
      </div>
    </Page>
  );
}
function ModelsPage({ onDialog }: { onDialog: Props['onDialog'] }) {
  const { snapshot, runtime, perform, notify } = useRuntime();
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState(currentSession(snapshot).model);
  const [saveDefault, setSaveDefault] = useState(false);
  const session = currentSession(snapshot);
  const models = snapshot.models.filter((model) =>
    (model.id + ' ' + model.provider).includes(query),
  );
  const choose = (id: string) =>
    perform(() => {
      if (session.state === 'waiting')
        throw Error('pause the current conversation before switching models');
      runtime.change((state) => {
        currentSession(state).model = id;
        if (saveDefault) state.settings.defaultModel = id;
      });
      runtime.request('set-model', { modelId: id, saveDefault });
      notify('model choice saved locally');
    });
  return (
    <Page
      title="models"
      description="Choose the model and thinking depth for this session."
      action={
        <Button onClick={() => onDialog('connect')}>
          <Plug size={14} />
          connection
        </Button>
      }
    >
      <div className="connection-banner">
        <span>
          <i />
          not connected
        </span>
        <code>{snapshot.settings.endpoint || 'no endpoint configured'}</code>
      </div>
      <div className="list-toolbar">
        <SearchInput value={query} onChange={setQuery} label="search models" />
        <Switch
          label="save as default"
          checked={saveDefault}
          onChange={setSaveDefault}
        />
      </div>
      <div className="model-list">
        {models.map((model) => (
          <div
            className={
              model.id === selected ? 'model-row selected' : 'model-row'
            }
            key={model.id}
          >
            <button onClick={() => setSelected(model.id)}>
              <span className="model-glyph">
                <Blocks size={17} />
              </span>
              <span>
                <strong>{model.id}</strong>
                <small>{model.provider}</small>
              </span>
              <span>
                {model.contextWindow?.toLocaleString() ?? 'N/A'} context
              </span>
              <span>{model.vision ? 'text + image' : 'text'}</span>
              {session.model === model.id && <Badge>current</Badge>}
            </button>
            <label title="include in model cycling" className="check-label">
              <input
                type="checkbox"
                aria-label={`cycle ${model.id}`}
                checked={
                  !snapshot.settings.enabledModels.length ||
                  snapshot.settings.enabledModels.includes(model.id)
                }
                onChange={(event) =>
                  perform(() =>
                    runtime.change((state) => {
                      const enabled = state.settings.enabledModels.length
                        ? state.settings.enabledModels
                        : state.models.map((item) => item.id);
                      state.settings.enabledModels = event.target.checked
                        ? [...new Set([...enabled, model.id])]
                        : enabled.filter((id) => id !== model.id);
                    }),
                  )
                }
              />
            </label>
            <Button
              disabled={session.state === 'waiting'}
              onClick={() => choose(model.id)}
            >
              use model
            </Button>
          </div>
        ))}
        {!models.length && query.trim() && (
          <Button onClick={() => choose(query.trim())}>
            use “{query.trim()}”
          </Button>
        )}
      </div>
      <section className="settings-block">
        <h2>thinking depth</h2>
        <p>
          Applied to the current session. The connected runtime will report
          which levels the model accepts.
        </p>
        <div className="effort-options">
          {EFFORTS.map((effort) => (
            <button
              key={effort}
              className={session.effort === effort ? 'active' : ''}
              disabled={session.state === 'waiting'}
              onClick={() =>
                perform(() =>
                  runtime.change((state) => {
                    currentSession(state).effort = effort;
                    if (saveDefault) state.settings.defaultEffort = effort;
                  }),
                )
              }
            >
              {effort}
            </button>
          ))}
        </div>
      </section>
      <section className="settings-block">
        <h2>usage</h2>
        <Facts
          values={{
            'input price': 'N/A',
            'output price': 'N/A',
            'cache usage': 'N/A',
            source: 'sample catalog; no endpoint queried',
          }}
        />
      </section>
    </Page>
  );
}
function SkillsPage() {
  const { snapshot, runtime, act } = useRuntime();
  const [query, setQuery] = useState('');
  const [id, setId] = useState(snapshot.skills[0]?.id ?? '');
  const selected = snapshot.skills.find((skill) => skill.id === id);
  return (
    <Page
      title="skills"
      description="Instructions loaded into a conversation when needed."
    >
      <div className="catalog-layout">
        <div>
          <SearchInput
            value={query}
            onChange={setQuery}
            label="search skills"
          />
          {snapshot.skills
            .filter((skill) =>
              (skill.name + ' ' + skill.description).includes(query),
            )
            .map((skill) => (
              <button
                className={
                  skill.id === id ? 'catalog-row active' : 'catalog-row'
                }
                key={skill.id}
                onClick={() => setId(skill.id)}
              >
                <BookOpen size={16} />
                <span>
                  <strong>{skill.name}</strong>
                  <small>{skill.scope}</small>
                </span>
              </button>
            ))}
        </div>
        <div className="catalog-detail">
          {selected && (
            <>
              <div className="detail-title">
                <div>
                  <h2>{selected.name}</h2>
                  <p>{selected.description}</p>
                </div>
                <Button
                  disabled={currentSession(snapshot).state === 'waiting'}
                  onClick={() =>
                    act(() => runtime.command('skill', selected.name))
                  }
                >
                  <Plus size={14} />
                  add to session
                </Button>
              </div>
              <code className="file-path">{selected.path}</code>
              <Markdown text={selected.content} />
            </>
          )}
        </div>
      </div>
    </Page>
  );
}
function CommandsPage() {
  const { snapshot, runtime, perform, notify } = useRuntime();
  const [id, setId] = useState(snapshot.commands[0]?.name ?? '');
  const [selectedTemplate, setTemplate] = useState('');
  const [editing, setEditing] = useState(false);
  const [query, setQuery] = useState('');
  const selected = snapshot.commands.find((command) => command.name === id);
  return (
    <Page
      title="commands"
      description="Reusable prompts from your project, user folders and extensions."
      action={
        <Button
          onClick={() => {
            const name = 'new-command-' + (snapshot.commands.length + 1);
            runtime.change((state) =>
              state.commands.push({
                name,
                description: 'a local preview command',
                arguments: '[args]',
                scope: 'project',
                template: '$ARGUMENTS',
              }),
            );
            setId(name);
          }}
        >
          <Plus size={14} />
          new command
        </Button>
      }
    >
      <div className="catalog-layout">
        <div>
          <SearchInput
            value={query}
            onChange={setQuery}
            label="search commands"
          />
          {snapshot.commands
            .filter((command) =>
              (command.name + ' ' + command.description).includes(query),
            )
            .map((command) => (
              <button
                key={command.name}
                className={
                  command.name === id ? 'catalog-row active' : 'catalog-row'
                }
                onClick={() => {
                  setId(command.name);
                  setEditing(false);
                }}
              >
                <Command size={15} />
                <span>
                  <strong>/{command.name}</strong>
                  <small>{command.scope}</small>
                </span>
              </button>
            ))}
        </div>
        <div className="catalog-detail">
          {selected && (
            <>
              <div className="detail-title">
                <div>
                  <h2>
                    /{selected.name} {selected.arguments}
                  </h2>
                  <p>{selected.description}</p>
                </div>
                <Button
                  onClick={() => {
                    setTemplate(selected.template);
                    setEditing(true);
                  }}
                >
                  edit template
                </Button>
              </div>
              {editing ? (
                <>
                  <textarea
                    aria-label="command template"
                    className="code-editor short"
                    value={selectedTemplate}
                    onChange={(event) => setTemplate(event.target.value)}
                  />
                  <Button
                    onClick={() =>
                      perform(() => {
                        runtime.change((state) => {
                          state.commands.find(
                            (command) => command.name === id,
                          )!.template = selectedTemplate;
                        });
                        setEditing(false);
                        notify('template saved to local preview');
                      })
                    }
                  >
                    save template
                  </Button>
                </>
              ) : (
                <pre className="source-preview">{selected.template}</pre>
              )}
              <p className="panel-note">
                Shell snippets remain plain text in this frontend. A connected
                runtime must expand and execute a custom command.
              </p>
              <Button
                onClick={() => {
                  runtime.change((state) => {
                    currentSession(state).draft = '/' + selected.name + ' ';
                  });
                  notify('command added to the message draft');
                }}
              >
                insert into draft
                <ArrowUpRight size={12} />
              </Button>
            </>
          )}
        </div>
      </div>
    </Page>
  );
}
function McpPage() {
  const { snapshot, runtime, perform, notify } = useRuntime();
  const [selected, setSelected] = useState<string | null>(null);
  const [editing, setEditing] = useState<McpServer | null>(null);
  const server = snapshot.mcp.find((item) => item.id === selected);
  return (
    <Page
      title="mcp servers"
      description="Inspect server configuration and the tools it exposes."
      action={
        <div className="inline-actions">
          <Button
            onClick={() => {
              runtime.request('mcp.reload');
              notify('reload requested; no server was started');
            }}
          >
            <RotateCcw size={13} />
            reload
          </Button>
          <Button
            onClick={() =>
              setEditing({
                id: crypto.randomUUID(),
                name: '',
                transport: 'stdio',
                command: '',
                args: '',
                url: '',
                enabled: true,
                status: 'not connected',
                tools: [],
              })
            }
          >
            <Plus size={14} />
            add server
          </Button>
        </div>
      }
    >
      <div className="records">
        {snapshot.mcp.map((item) => (
          <div key={item.id} className="record-row">
            <button
              className="record-main"
              onClick={() => setSelected(item.id)}
            >
              <Plug size={18} />
              <span>
                <strong>{item.name}</strong>
                <small>
                  {item.transport} · {item.tools.length} tools
                  {item.error ? ' · ' + item.error : ''}
                </small>
              </span>
              <Status value={item.status} />
            </button>
            <Button onClick={() => setEditing(structuredClone(item))}>
              configure
            </Button>
            <Switch
              label={`enable ${item.name}`}
              checked={item.enabled}
              onChange={(enabled) =>
                perform(() =>
                  runtime.change((state) => {
                    state.mcp.find((server) => server.id === item.id)!.enabled =
                      enabled;
                  }),
                )
              }
            />
          </div>
        ))}
      </div>
      <Modal
        open={!!server}
        onOpenChange={(open) => {
          if (!open) setSelected(null);
        }}
        title={server?.name ?? 'server'}
        wide
      >
        {server && (
          <>
            <Facts
              values={{
                transport: server.transport,
                command: server.command || '—',
                arguments: server.args || '—',
                url: server.url || '—',
                status: server.status,
              }}
            />
            {server.tools.map((tool) => (
              <details key={tool.name} className="tool-definition">
                <summary>
                  {tool.name}
                  <span>{tool.description}</span>
                </summary>
                <DataBlock title="input schema" value={tool.schema} />
              </details>
            ))}
            {!server.tools.length && (
              <p className="muted">no tools discovered</p>
            )}
          </>
        )}
      </Modal>
      <Modal
        open={!!editing}
        onOpenChange={(open) => {
          if (!open) setEditing(null);
        }}
        title="server configuration"
        description="Saved only in this browser. No process or connection is started."
      >
        {editing && (
          <form
            className="form-stack"
            onSubmit={(event) => {
              event.preventDefault();
              if (
                !editing.name.trim() ||
                !(editing.transport === 'stdio' ? editing.command : editing.url)
              ) {
                notify('enter a name and a command or URL');
                return;
              }
              perform(() => {
                runtime.change((state) => {
                  const index = state.mcp.findIndex(
                    (item) => item.id === editing.id,
                  );
                  if (index >= 0) state.mcp[index] = editing;
                  else state.mcp.push(editing);
                });
                setEditing(null);
                notify('server configuration saved locally');
              });
            }}
          >
            <label>
              name
              <input
                required
                value={editing.name}
                onChange={(event) =>
                  setEditing({ ...editing, name: event.target.value })
                }
              />
            </label>
            <label>
              transport
              <select
                value={editing.transport}
                onChange={(event) =>
                  setEditing({
                    ...editing,
                    transport: event.target.value as McpServer['transport'],
                  })
                }
              >
                {['stdio', 'sse', 'streamable_http', 'websocket'].map(
                  (value) => (
                    <option key={value}>{value}</option>
                  ),
                )}
              </select>
            </label>
            {editing.transport === 'stdio' ? (
              <>
                <label>
                  command
                  <input
                    required
                    value={editing.command}
                    onChange={(event) =>
                      setEditing({ ...editing, command: event.target.value })
                    }
                  />
                </label>
                <label>
                  arguments
                  <input
                    value={editing.args}
                    onChange={(event) =>
                      setEditing({ ...editing, args: event.target.value })
                    }
                  />
                </label>
              </>
            ) : (
              <label>
                url
                <input
                  required
                  type="url"
                  value={editing.url}
                  onChange={(event) =>
                    setEditing({ ...editing, url: event.target.value })
                  }
                />
              </label>
            )}
            <p className="panel-note">
              Environment secrets will be supplied by the runtime. This preview
              does not collect them.
            </p>
            <Button type="submit" className="primary">
              save configuration
            </Button>
          </form>
        )}
      </Modal>
    </Page>
  );
}
function ExtensionsPage() {
  const { snapshot, runtime, perform, notify } = useRuntime();
  const [tab, setTab] = useState<'runtime' | 'interface'>('runtime');
  const { registry, enabled, toggle } = usePlugins();
  return (
    <Page
      title="extensions"
      description="Runtime tools and interface components have separate lifecycles."
      action={
        <Button
          onClick={() => {
            runtime.request('extensions.reload');
            notify('extension reload recorded; no code was loaded');
          }}
        >
          <RotateCcw size={14} />
          reload
        </Button>
      }
    >
      <div className="segmented page-tabs">
        <button
          className={tab === 'runtime' ? 'active' : ''}
          onClick={() => setTab('runtime')}
        >
          runtime extensions
        </button>
        <button
          className={tab === 'interface' ? 'active' : ''}
          onClick={() => setTab('interface')}
        >
          interface components
        </button>
      </div>
      {tab === 'runtime' ? (
        <div className="extension-list">
          {snapshot.extensions.map((extension) => (
            <article className="extension-card" key={extension.id}>
              <div className="detail-title">
                <span className="extension-icon">
                  <Blocks size={21} />
                </span>
                <div>
                  <h2>{extension.name}</h2>
                  <p>
                    {extension.scope} · {extension.version}
                  </p>
                </div>
                <Switch
                  label={`enable ${extension.name}`}
                  checked={extension.enabled}
                  onChange={(enabled) =>
                    perform(() =>
                      runtime.change((state) => {
                        state.extensions.find(
                          (item) => item.id === extension.id,
                        )!.enabled = enabled;
                      }),
                    )
                  }
                />
              </div>
              {extension.error && (
                <div className="inline-error">{extension.error}</div>
              )}
              <div className="extension-contributions">
                <span>{extension.tools.length} tools</span>
                <span>{extension.commands.length} commands</span>
                <span>{extension.events.length} event handlers</span>
              </div>
              <details>
                <summary>contributions</summary>
                <DataBlock
                  title="registered items"
                  value={{
                    tools: extension.tools,
                    commands: extension.commands,
                    events: extension.events,
                  }}
                />
              </details>
            </article>
          ))}
        </div>
      ) : (
        <div className="extension-list">
          {registry.plugins.map((plugin) => (
            <article className="extension-card" key={plugin.id}>
              <div className="detail-title">
                <Blocks size={20} />
                <div>
                  <h2>{plugin.title}</h2>
                  <p>{plugin.description}</p>
                </div>
                <Switch
                  label={`enable ${plugin.id} interface`}
                  checked={enabled.includes(plugin.id)}
                  onChange={(value) => toggle(plugin.id, value)}
                />
              </div>
              <p className="panel-note">
                bundled first-party component · 0.1.0
              </p>
            </article>
          ))}
        </div>
      )}
    </Page>
  );
}
function ToolsPage() {
  const [query, setQuery] = useState('');
  return (
    <Page
      title="tools"
      description="Circle's built-in tools, with inputs and results shown in the conversation."
    >
      <SearchInput value={query} onChange={setQuery} label="search tools" />
      <div className="tool-catalog">
        {BUILTIN_TOOL_INFO.filter((tool) =>
          (tool.name + ' ' + tool.description).includes(query),
        ).map((tool) => (
          <details className="tool-definition" key={tool.name}>
            <summary>
              <Code size={15} />
              <code>{tool.name}</code>
              <span>{tool.description}</span>
              <Badge>{tool.kind}</Badge>
            </summary>
            <p>{tool.detail}</p>
            <p className="muted small">
              Raw inputs and outputs use the same expandable transcript
              renderer. Actual execution requires Circle.
            </p>
          </details>
        ))}
      </div>
    </Page>
  );
}
function ApprovalsPage() {
  const { snapshot, runtime, perform } = useRuntime();
  const session = currentSession(snapshot);
  const rules = snapshot.approvalRules.filter(
    (rule) => rule.sessionId === session.id,
  );
  return (
    <Page
      title="approvals"
      description="Allow rules belong to the current session."
    >
      <div className="connection-banner">
        <ShieldCheck size={18} />
        <span>
          {session.readOnly
            ? 'read-only'
            : session.auto
              ? 'auto'
              : 'ask before changes'}
        </span>
        <small>preview policy</small>
      </div>
      <div className="records">
        {rules.map((rule) => (
          <div className="record-row" key={rule.id}>
            <div className="record-main">
              <ShieldCheck size={16} />
              <span>
                <strong>{rule.description}</strong>
                <small>{rule.kind} · this session</small>
              </span>
            </div>
            <Button
              onClick={() =>
                perform(() => {
                  runtime.change((state) => {
                    state.approvalRules = state.approvalRules.filter(
                      (item) => item.id !== rule.id,
                    );
                  });
                  runtime.request('revoke-approval', { ruleId: rule.id });
                })
              }
            >
              revoke
            </Button>
          </div>
        ))}
        {!rules.length && (
          <div className="empty-state">
            <h3>no session rules</h3>
          </div>
        )}
      </div>
      <section className="settings-block">
        <h2>recent decisions</h2>
        {snapshot.interactions
          .filter(
            (item) =>
              item.sessionId === session.id && item.status === 'recorded',
          )
          .map((item) => (
            <div className="decision-row" key={item.id}>
              <span>{item.title}</span>
              <strong>{item.decision}</strong>
            </div>
          ))}
        <p className="panel-note">
          Preview decisions do not grant permissions to a running agent.
        </p>
      </section>
    </Page>
  );
}
function SettingsPage({ onDialog }: { onDialog: Props['onDialog'] }) {
  const { snapshot, runtime, perform, notify } = useRuntime();
  const settings = snapshot.settings;
  const [bindings, setBindings] = useState(
    JSON.stringify(settings.keybindings, null, 2),
  );
  const [launch, setLaunch] = useState('--mode rpc --no-tools');
  const save = (update: (draft: WorkbenchSnapshotSettings) => void) =>
    perform(() => runtime.change((state) => update(state.settings)));
  return (
    <Page
      title="settings"
      description="Preferences here apply to this frontend preview."
    >
      <section className="settings-block first">
        <h2>appearance</h2>
        <div className="setting-row">
          <span>theme</span>
          <div className="segmented">
            {(['auto', 'light', 'dark'] as const).map((theme) => (
              <button
                key={theme}
                className={settings.theme === theme ? 'active' : ''}
                onClick={() =>
                  save((value) => {
                    value.theme = theme;
                  })
                }
              >
                {theme}
              </button>
            ))}
          </div>
        </div>
        <div className="setting-row">
          <label htmlFor="ui-font">interface size</label>
          <input
            id="ui-font"
            type="range"
            min={11}
            max={18}
            value={settings.uiFontSize}
            onChange={(event) =>
              save((value) => {
                value.uiFontSize = Number(event.target.value);
              })
            }
          />
          <span>{settings.uiFontSize}</span>
        </div>
        <div className="setting-row">
          <label htmlFor="code-font">code size</label>
          <input
            id="code-font"
            type="range"
            min={11}
            max={20}
            value={settings.codeFontSize}
            onChange={(event) =>
              save((value) => {
                value.codeFontSize = Number(event.target.value);
              })
            }
          />
          <span>{settings.codeFontSize}</span>
        </div>
        <Switch
          label="hide thinking in new sessions"
          checked={settings.hideThinking}
          onChange={(checked) =>
            save((value) => {
              value.hideThinking = checked;
            })
          }
        />
      </section>
      <section className="settings-block">
        <h2>session defaults</h2>
        <div className="setting-row">
          <span>model</span>
          <code>{settings.defaultModel}</code>
          <Button onClick={() => onDialog('connect')}>connection</Button>
        </div>
        <div className="setting-row">
          <label htmlFor="double-escape">double escape</label>
          <select
            id="double-escape"
            value={settings.doubleEscape}
            onChange={(event) =>
              save((value) => {
                value.doubleEscape = event.target
                  .value as typeof settings.doubleEscape;
              })
            }
          >
            {['tree', 'fork', 'none'].map((value) => (
              <option key={value}>{value}</option>
            ))}
          </select>
        </div>
        <div className="setting-row">
          <label htmlFor="default-effort">thinking depth</label>
          <select
            id="default-effort"
            value={settings.defaultEffort}
            onChange={(event) =>
              save((value) => {
                value.defaultEffort = event.target
                  .value as typeof settings.defaultEffort;
              })
            }
          >
            {EFFORTS.map((value) => (
              <option key={value}>{value}</option>
            ))}
          </select>
        </div>
      </section>
      <section className="settings-block">
        <h2>workspace trust</h2>
        {snapshot.workspaces.map((workspace) => (
          <div className="setting-row" key={workspace.id}>
            <span>
              {workspace.name}
              <small>{workspace.path}</small>
            </span>
            <Status value={workspace.trusted ? 'trusted' : 'not trusted'} />
            <Button onClick={() => onDialog('trust', workspace.id)}>
              review
            </Button>
          </div>
        ))}
      </section>
      <section className="settings-block">
        <h2>protected files</h2>
        <label className="field-label" htmlFor="credential-patterns">
          additional file patterns
        </label>
        <textarea
          id="credential-patterns"
          className="input short"
          value={settings.credentialFiles.join('\n')}
          onChange={(event) =>
            save((value) => {
              value.credentialFiles = event.target.value
                .split('\n')
                .filter(Boolean);
            })
          }
        />
        <p className="panel-note">
          Circle's built-in protections remain in force when a runtime is
          connected.
        </p>
      </section>
      <section className="settings-block">
        <h2>keyboard</h2>
        <Button onClick={() => onDialog('hotkeys')}>view shortcuts</Button>
        <textarea
          aria-label="keybindings json"
          className="code-editor short"
          value={bindings}
          onChange={(event) => setBindings(event.target.value)}
        />
        <Button
          onClick={() =>
            perform(() => {
              const parsed = validateKeybindings(JSON.parse(bindings));
              save((value) => {
                value.keybindings = parsed;
              });
              notify('preview key preferences saved');
            })
          }
        >
          save key preferences
        </Button>
      </section>
      <section className="settings-block">
        <h2>launch options</h2>
        <textarea
          aria-label="launch arguments"
          className="input short"
          value={launch}
          onChange={(event) => setLaunch(event.target.value)}
        />
        <Button
          onClick={() => {
            runtime.request('launch-options', { arguments: launch });
            notify('launch draft saved; no process started');
          }}
        >
          save launch draft
        </Button>
      </section>
      <section className="settings-block">
        <h2>about</h2>
        <Facts
          values={{
            version: VERSION,
            runtime: 'not connected',
            host: desktopHost()
              ? 'desktop application'
              : 'browser layout preview',
            data: 'this browser only',
          }}
        />
        <Switch
          label="check for updates"
          checked={settings.updateCheck}
          onChange={(checked) =>
            save((value) => {
              value.updateCheck = checked;
            })
          }
        />
        <Button
          onClick={() => {
            runtime.request('check-update');
            notify('update check requires a connected host');
          }}
        >
          check now
        </Button>
        <Button onClick={() => onDialog('preview')}>preview data</Button>
      </section>
    </Page>
  );
}
type WorkbenchSnapshotSettings = ReturnType<
  typeof useRuntime
>['snapshot']['settings'];
function HelpPage({ onDialog }: { onDialog: Props['onDialog'] }) {
  const { runtime, act } = useRuntime();
  const [query, setQuery] = useState('');
  return (
    <Page
      title="commands & help"
      description="Every Circle command has a frontend entry point. Runtime actions are recorded as requests."
      action={
        <Button onClick={() => onDialog('hotkeys')}>keyboard shortcuts</Button>
      }
    >
      <SearchInput
        value={query}
        onChange={setQuery}
        label="search built-in commands"
      />
      <div className="command-table">
        {BUILTIN_SLASH.filter((command) =>
          (
            command.name +
            ' ' +
            command.description +
            ' ' +
            command.aliases?.join(' ')
          )
            .toLowerCase()
            .includes(query.toLowerCase()),
        ).map((command) => (
          <button
            key={command.name}
            onClick={() => act(() => runtime.command(command.name))}
          >
            <code>/{command.name}</code>
            <span>{command.description}</span>
            <small>
              {command.aliases?.map((alias) => '/' + alias).join(' ')}
            </small>
            <ChevronRight size={13} />
          </button>
        ))}
      </div>
      <div className="help-links">
        <a
          href="https://github.com/qingshanfeihu/circle/tree/main/docs"
          target="_blank"
          rel="noreferrer"
        >
          Circle documentation
          <ArrowUpRight size={12} />
        </a>
        <span>UI controls are local; no runtime effects are implied.</span>
      </div>
    </Page>
  );
}
