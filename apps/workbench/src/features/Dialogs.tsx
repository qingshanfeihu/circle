import { desktopHost, saveExport } from '../host';
import { useEffect, useRef, useState } from 'react';
import {
  ArrowUpRight,
  Check,
  ChevronRight,
  Copy,
  Download,
  FileText,
  GitBranch,
  Plus,
  ShieldCheck,
  Terminal,
  X,
} from 'lucide-react';
import { hotkeysText } from '../../../../src/tui/slash_commands';
import { VERSION } from '../../../../src/version';
import { useRuntime } from '../app/context';
import { branchMessages, currentSession, sessionText } from '../model/state';
import type { DialogId, Interaction, Session } from '../model/types';
import {
  Button,
  Modal,
  SearchInput,
  DataBlock,
  Facts,
  Switch,
  Status,
} from '../components/common';
export const downloadFile = saveExport;
export function DialogHost({
  dialog,
  selection,
  onClose,
  onSession,
}: {
  dialog: DialogId | null;
  selection: string;
  onClose: () => void;
  onSession: () => void;
}) {
  const { snapshot, runtime, perform, notify } = useRuntime();
  const current = currentSession(snapshot);
  const target =
    snapshot.sessions.find((session) => session.id === selection) ?? current;
  const workspace = snapshot.workspaces.find(
    (item) =>
      item.id ===
      (dialog === 'trust' && selection ? selection : target.workspaceId),
  )!;
  const [title, setTitle] = useState('');
  const [editor, setEditor] = useState('');
  const [query, setQuery] = useState('');
  const [userOnly, setUserOnly] = useState(false);
  const [selectedNode, setSelectedNode] = useState('');
  const [label, setLabel] = useState('');
  const [format, setFormat] = useState('markdown');
  const [endpoint, setEndpoint] = useState('');
  const [protocol, setProtocol] = useState<'openai' | 'anthropic'>('openai');
  const [model, setModel] = useState('');
  const [secret, setSecret] = useState('');
  const [resetConfirm, setResetConfirm] = useState(false);
  const [hint, setHint] = useState('');
  useEffect(() => {
    setTitle(target.title);
    setEditor(current.draft);
    setQuery('');
    setSelectedNode(current.leafId ?? '');
    setLabel('');
    setEndpoint(snapshot.settings.endpoint);
    setProtocol(snapshot.settings.protocol);
    setModel(current.model);
    setSecret('');
    setFormat(
      selection === 'html'
        ? 'html'
        : selection === 'jsonl'
          ? 'json'
          : 'markdown',
    );
    setResetConfirm(false);
    setHint('');
  }, [dialog, selection]);
  const names: Record<DialogId, string> = {
    rename: 'rename session',
    'delete-session': 'delete session',
    tree: 'session tree',
    fork: 'fork session',
    session: 'session details',
    export: 'export session',
    editor: 'draft editor',
    connect: 'connection',
    trust: 'workspace trust',
    preview: 'frontend preview',
    hotkeys: 'keyboard shortcuts',
    compact: 'compact context',
    exit: 'close session',
    secret: 'secret input',
    'job-stop': 'stop background job',
  };
  const selectedJob = snapshot.jobs.find((job) => job.id === selection);
  const selectedSecret = snapshot.interactions.find(
    (item) =>
      item.sessionId === current.id &&
      item.kind === 'secret' &&
      item.status === 'pending',
  );
  const nodes = current.messages.filter(
    (message) =>
      ((dialog !== 'fork' && (!userOnly || message.role === 'user')) ||
        message.role === 'user') &&
      (message.text + ' ' + message.label + ' ' + message.role)
        .toLowerCase()
        .includes(query.toLowerCase()),
  );
  const selectedMessage = current.messages.find(
    (message) => message.id === selectedNode,
  );
  return (
    <Modal
      open={!!dialog}
      onOpenChange={(open) => {
        if (!open) {
          setSecret('');
          onClose();
        }
      }}
      title={dialog ? names[dialog] : ''}
      wide={['tree', 'fork', 'editor', 'hotkeys', 'session', 'export'].includes(
        dialog ?? '',
      )}
    >
      {dialog === 'rename' && (
        <form
          className="form-stack"
          onSubmit={(event) => {
            event.preventDefault();
            perform(() => {
              runtime.change((state) => {
                state.sessions.find(
                  (session) => session.id === target.id,
                )!.title = title.trim() || target.title;
              });
              onClose();
            });
          }}
        >
          <label>
            session name
            <input
              autoFocus
              aria-label="session name"
              value={title}
              onChange={(event) => setTitle(event.target.value)}
            />
          </label>
          <div className="dialog-actions">
            <Button onClick={onClose} type="button">
              cancel
            </Button>
            <Button className="primary" type="submit">
              save
            </Button>
          </div>
        </form>
      )}
      {dialog === 'delete-session' && (
        <>
          <p className="dialog-paragraph">
            Delete “{target.title}” from this browser preview?
          </p>
          <div className="dialog-actions">
            <Button onClick={onClose}>keep session</Button>
            <Button
              className="danger"
              onClick={() =>
                perform(() => {
                  runtime.deleteSession(target.id);
                  onClose();
                })
              }
            >
              delete local session
            </Button>
          </div>
        </>
      )}
      {(dialog === 'tree' || dialog === 'fork') && (
        <>
          <div className="list-toolbar">
            <SearchInput
              value={query}
              onChange={setQuery}
              label="search session tree"
            />
            {dialog === 'tree' && (
              <Switch
                label="user messages only"
                checked={userOnly}
                onChange={setUserOnly}
              />
            )}
          </div>
          <p className="panel-note">
            {dialog === 'fork'
              ? 'Create a new session from before a user message.'
              : 'Choose what the next message continues from.'}{' '}
            File changes are not reverted.
          </p>
          <div className="session-tree">
            {nodes.map((message) => {
              const depth = branchMessages({
                ...current,
                leafId: message.id,
              }).length;
              return (
                <button
                  key={message.id}
                  className={
                    selectedNode === message.id
                      ? 'tree-node selected'
                      : 'tree-node'
                  }
                  style={{ paddingLeft: Math.min(depth, 6) * 12 + 10 }}
                  onClick={() => {
                    setSelectedNode(message.id);
                    setLabel(message.label ?? '');
                  }}
                >
                  <GitBranch size={13} />
                  <span>
                    <strong>
                      {message.role}
                      {message.label ? ' · ' + message.label : ''}
                    </strong>
                    <p>{message.text || message.tool?.name}</p>
                  </span>
                  {current.leafId === message.id && <Status value="active" />}
                </button>
              );
            })}
          </div>
          {selectedMessage && (
            <div className="tree-selection">
              <label>
                label
                <input
                  aria-label="node label"
                  value={label}
                  onChange={(event) => setLabel(event.target.value)}
                />
              </label>
              <Button
                onClick={() =>
                  perform(() => {
                    runtime.change((state) => {
                      currentSession(state).messages.find(
                        (message) => message.id === selectedNode,
                      )!.label = label;
                    });
                    notify('message label saved');
                  })
                }
              >
                save label
              </Button>
              <Button
                className="primary"
                disabled={dialog === 'fork' && current.state === 'waiting'}
                onClick={() =>
                  perform(() => {
                    runtime.branch(
                      selectedNode,
                      dialog === 'fork' ? 'fork' : 'tree',
                    );
                    onClose();
                    onSession();
                  })
                }
              >
                {dialog === 'fork' ? 'create fork' : 'continue from here'}
              </Button>
            </div>
          )}
        </>
      )}
      {dialog === 'session' && (
        <>
          <Facts
            values={{
              session: current.id,
              title: current.title,
              workspace: workspace.path,
              model: current.model,
              effort: current.effort,
              messages: current.messages.length,
              'visible branch': branchMessages(current).length,
              'tool calls': current.messages.filter((message) => message.tool)
                .length,
              'active node': current.leafId ?? 'none',
              storage: 'isolated browser preview',
              runtime: 'not connected',
            }}
          />
          <details className="raw-session">
            <summary>raw session and pending input</summary>
            <DataBlock title="session snapshot" value={current} />
          </details>
        </>
      )}
      {dialog === 'editor' && (
        <>
          <textarea
            autoFocus
            className="code-editor editor-draft"
            aria-label="expanded message draft"
            value={editor}
            onChange={(event) => setEditor(event.target.value)}
          />
          <div className="dialog-actions">
            <Button
              onClick={() => {
                runtime.request('external-editor', { draft: editor });
                notify('external editor requires a native host');
              }}
            >
              external editor
            </Button>
            <Button
              className="primary"
              onClick={() =>
                perform(() => {
                  runtime.change((state) => {
                    currentSession(state).draft = editor;
                  });
                  onClose();
                })
              }
            >
              use draft
            </Button>
          </div>
        </>
      )}
      {dialog === 'export' && (
        <>
          <div className="list-toolbar">
            <label>
              format
              <select
                aria-label="export format"
                value={format}
                onChange={(event) => setFormat(event.target.value)}
              >
                <option value="markdown">markdown</option>
                <option value="html">html</option>
                <option value="json">preview bundle</option>
              </select>
            </label>
            <Button
              onClick={async () => {
                const plain = sessionText(current);
                const escaped = plain
                  .replaceAll('&', '&amp;')
                  .replaceAll('<', '&lt;')
                  .replaceAll('>', '&gt;');
                const content =
                  format === 'json'
                    ? JSON.stringify(
                        {
                          schema: 'circle-workbench-preview/v1',
                          session: current,
                        },
                        null,
                        2,
                      )
                    : format === 'html'
                      ? `<!doctype html><meta charset="utf-8"><title>Circle preview</title><pre>${escaped}</pre>`
                      : plain;
                const saved = await downloadFile(
                  'circle-preview.' +
                    (format === 'json'
                      ? 'json'
                      : format === 'html'
                        ? 'html'
                        : 'md'),
                  content,
                );
                notify(saved ? 'preview exported' : 'export cancelled');
              }}
            >
              <Download size={14} />
              download preview
            </Button>
          </div>
          <DataBlock title="preview content" value={sessionText(current)} />
          <p className="panel-note">
            Native Circle JSONL export and checksums need the connected runtime.
            A preview bundle is only for this frontend.
          </p>
          <div className="dialog-actions">
            <Button
              onClick={() => {
                runtime.request('export-session', {
                  format: selection || format,
                });
                notify('native export request recorded');
              }}
            >
              request native export
            </Button>
            <Button
              onClick={async () => {
                const saved = await downloadFile(
                  'circle-share.md',
                  sessionText(current),
                );
                if (saved) {
                  perform(() =>
                    runtime.change((state) => {
                      currentSession(state).shared = true;
                    }),
                  );
                  notify('local copy saved; nothing was uploaded');
                }
              }}
            >
              share local copy
            </Button>
          </div>
        </>
      )}
      {dialog === 'connect' && (
        <form
          className="form-stack"
          onSubmit={(event) => {
            event.preventDefault();
            perform(() => {
              const url = new URL(endpoint);
              if (
                !['http:', 'https:'].includes(url.protocol) ||
                url.username ||
                url.password
              )
                throw Error(
                  'use an http or https endpoint without credentials in the URL',
                );
              runtime.change((state) => {
                state.settings.endpoint = endpoint;
                state.settings.protocol = protocol;
                currentSession(state).model = model;
              });
              runtime.request('configure-connection', {
                endpoint,
                protocol,
                model,
                credentialProvided: !!secret,
              });
              setSecret('');
              notify(
                'connection draft saved; key discarded, no endpoint contacted',
              );
              onClose();
            });
          }}
        >
          <div className="connection-banner">
            <Status value="not connected" />
            <span>API URL + key</span>
          </div>
          <label>
            base url
            <input
              type="url"
              required
              autoFocus
              aria-label="base url"
              value={endpoint}
              onChange={(event) => setEndpoint(event.target.value)}
            />
          </label>
          <label>
            protocol
            <select
              value={protocol}
              onChange={(event) =>
                setProtocol(event.target.value as typeof protocol)
              }
            >
              <option value="openai">openai</option>
              <option value="anthropic">anthropic</option>
            </select>
          </label>
          <label>
            api key
            <input
              type="password"
              autoComplete="off"
              aria-label="api key"
              value={secret}
              onChange={(event) => setSecret(event.target.value)}
              placeholder="not saved or sent by this preview"
            />
          </label>
          <label>
            model
            <input
              required
              aria-label="connection model"
              list="connection-models"
              value={model}
              onChange={(event) => setModel(event.target.value)}
            />
            <datalist id="connection-models">
              {snapshot.models.map((item) => (
                <option key={item.id}>{item.id}</option>
              ))}
            </datalist>
          </label>
          <p className="panel-note">
            Credentials stay in this form and are discarded when it closes. The
            desktop host will own the actual connection.
          </p>
          <div className="dialog-actions">
            <Button
              type="button"
              onClick={() => {
                setSecret('');
                onClose();
              }}
            >
              cancel
            </Button>
            <Button type="submit" className="primary">
              save connection draft
            </Button>
          </div>
        </form>
      )}
      {dialog === 'trust' && (
        <>
          <p className="dialog-paragraph">{workspace.path}</p>
          <p className="dialog-paragraph">
            Circle can load this workspace's instructions, skills, commands,
            settings and extensions after you trust it. Extensions run code in
            the runtime.
          </p>
          {workspace.instructions.map((item) => (
            <details className="context-source" key={item.name}>
              <summary>{item.name}</summary>
              <pre>{item.content}</pre>
            </details>
          ))}
          <p className="panel-note">
            {workspace.origin === 'native'
              ? 'This choice is kept locally. The connected Circle runtime must enforce workspace trust before loading project code.'
              : 'This choice applies only to the sample workspace. No folder is opened or loaded.'}
          </p>
          <div className="dialog-actions">
            <Button onClick={onClose}>cancel</Button>
            <Button
              className="primary"
              onClick={() =>
                perform(() => {
                  runtime.change((state) => {
                    state.workspaces.find(
                      (item) => item.id === workspace.id,
                    )!.trusted = true;
                  });
                  onClose();
                  notify('sample workspace marked trusted');
                })
              }
            >
              trust in preview
            </Button>
          </div>
        </>
      )}
      {dialog === 'compact' && (
        <form
          className="form-stack"
          onSubmit={(event) => {
            event.preventDefault();
            runtime.request('compact', { hint });
            onClose();
            notify('compaction requested; raw history is unchanged');
          }}
        >
          <p className="dialog-paragraph">
            A connected Circle runtime summarizes older context. The full record
            is kept.
          </p>
          <label>
            focus
            <input
              aria-label="compaction focus"
              value={hint}
              onChange={(event) => setHint(event.target.value)}
              placeholder="what should the summary preserve?"
            />
          </label>
          <Button type="submit" className="primary">
            request compaction
          </Button>
        </form>
      )}
      {dialog === 'hotkeys' && (
        <>
          <p className="panel-note">
            Circle's terminal bindings are listed below. Browser-reserved keys
            and process suspension need a desktop host; the same features have
            clickable controls here.
          </p>
          <pre className="shortcut-list">{hotkeysText()}</pre>
        </>
      )}
      {dialog === 'exit' && (
        <>
          <p className="dialog-paragraph">
            Closing a real Circle process stops its owned background jobs. This
            preview can only record the request.
          </p>
          <div className="dialog-actions">
            <Button onClick={onClose}>keep working</Button>
            <Button
              onClick={() => {
                runtime.request('exit');
                onClose();
                if (desktopHost()) void desktopHost()!.windowControl('quit');
                else notify('exit requested; no runtime process was stopped');
              }}
            >
              {desktopHost() ? 'quit application' : 'request exit'}
            </Button>
          </div>
        </>
      )}
      {dialog === 'job-stop' && selectedJob && (
        <>
          <h3>
            {selectedJob.id} · {selectedJob.title}
          </h3>
          <p className="dialog-paragraph">
            The runtime must confirm that the process and its children stopped.
            A request alone does not establish that.
          </p>
          <div className="dialog-actions">
            <Button onClick={onClose}>keep running</Button>
            <Button
              onClick={() => {
                runtime.request('stop-job', { id: selectedJob.id });
                onClose();
                notify('stop requested; execution state is unverified');
              }}
            >
              request stop
            </Button>
          </div>
        </>
      )}
      {dialog === 'secret' && (
        <form
          className="form-stack"
          onSubmit={(event) => {
            event.preventDefault();
            if (!secret.trim()) {
              notify('enter a value or cancel');
              return;
            }
            if (selectedSecret)
              perform(() =>
                runtime.answer(
                  selectedSecret.id,
                  selectedSecret.revision,
                  secret,
                ),
              );
            setSecret('');
            onClose();
            notify('secret discarded by preview; nothing was sent');
          }}
        >
          <Facts
            values={{
              request: selectedSecret?.title ?? 'no pending secret',
              destination: selectedSecret?.target ?? 'none',
            }}
          />
          <label>
            secret
            <input
              autoFocus
              type="password"
              autoComplete="off"
              maxLength={512}
              aria-label="secret value"
              value={secret}
              onChange={(event) => setSecret(event.target.value)}
            />
          </label>
          <p className="panel-note">
            This preview does not retain or transmit the value.
          </p>
          <div className="dialog-actions">
            <Button
              type="button"
              onClick={() => {
                setSecret('');
                onClose();
              }}
            >
              cancel
            </Button>
            <Button type="submit" disabled={!selectedSecret}>
              record preview response
            </Button>
          </div>
        </form>
      )}
      {dialog === 'preview' && (
        <>
          <Facts
            values={{
              version: VERSION,
              scope: 'frontend only',
              data: 'synthetic records and your local input',
              runtime: 'not connected',
              models: 'not contacted',
              workspace: desktopHost()
                ? 'user-selected files through granted handles'
                : 'no real files accessed',
            }}
          />
          <p className="dialog-paragraph">
            Use the interface to review sessions, tools, branches, approvals,
            jobs and settings. Requests remain local. Your real Circle settings
            and sessions are not read.
          </p>
          {resetConfirm ? (
            <div className="dialog-actions">
              <Button onClick={() => setResetConfirm(false)}>
                keep local data
              </Button>
              <Button
                className="danger"
                onClick={() => {
                  runtime.reset();
                  onClose();
                  onSession();
                }}
              >
                confirm reset
              </Button>
            </div>
          ) : (
            <Button onClick={() => setResetConfirm(true)}>
              reset sample data
            </Button>
          )}
        </>
      )}
    </Modal>
  );
}
export function InteractionDialog({
  item,
  onClose,
}: {
  item: Interaction | null;
  onClose: () => void;
}) {
  const { runtime, perform, notify } = useRuntime();
  const [selected, setSelected] = useState<string[]>([]);
  const [comment, setComment] = useState('');
  const [cancelConfirm, setCancelConfirm] = useState(false);
  useEffect(() => {
    setSelected([]);
    setComment('');
    setCancelConfirm(false);
  }, [item?.id]);
  const finish = (answer: string) => {
    if (!item) return;
    perform(() => {
      runtime.answer(item.id, item.revision, answer);
      onClose();
      notify('response recorded locally; runtime not connected');
    });
  };
  const close = () => {
    if (!item) return;
    if (item.status === 'recorded') {
      onClose();
      return;
    }
    if (
      item.kind === 'question' &&
      (selected.length || comment) &&
      !cancelConfirm
    ) {
      setCancelConfirm(true);
      return;
    }
    finish(item.kind === 'question' ? 'cancelled' : 'reject');
  };
  return (
    <Modal
      open={!!item}
      onOpenChange={(open) => {
        if (!open) close();
      }}
      title={item?.title ?? 'request'}
      wide={!!item?.before}
    >
      {item && (
        <>
          <div className="interaction-meta">
            <Status
              value={item.status === 'pending' ? 'waiting' : 'recorded'}
            />
            <code>
              {item.id} · revision {item.revision}
            </code>
            <span>sample request</span>
          </div>
          {item.target && <p className="file-path">{item.target}</p>}
          {item.command && (
            <pre className="approval-command">{item.command}</pre>
          )}
          {item.before !== undefined && (
            <div className="approval-diff">
              <DataBlock title="before" value={item.before} />
              <DataBlock title="after" value={item.after} />
            </div>
          )}
          {item.status === 'recorded' ? (
            <DataBlock title="local response" value={item.decision} />
          ) : item.kind === 'question' ? (
            <>
              <div className="question-options">
                {item.choices?.map((choice) => (
                  <label key={choice}>
                    <input
                      type={item.multiple ? 'checkbox' : 'radio'}
                      name="question"
                      checked={selected.includes(choice)}
                      onChange={(event) =>
                        setSelected(
                          item.multiple
                            ? event.target.checked
                              ? [...selected, choice]
                              : selected.filter((value) => value !== choice)
                            : [choice],
                        )
                      }
                    />
                    {choice}
                  </label>
                ))}
              </div>
              <label className="field-label" htmlFor="question-comment">
                your answer
              </label>
              <textarea
                id="question-comment"
                className="input short"
                value={comment}
                onChange={(event) => setComment(event.target.value)}
              />
              {cancelConfirm && (
                <p className="inline-error">
                  Cancel this answer? Press escape again or choose cancel.
                </p>
              )}
              <div className="dialog-actions">
                <Button onClick={() => finish('cancelled')}>cancel</Button>
                <Button
                  className="primary"
                  disabled={!selected.length && !comment.trim()}
                  onClick={() =>
                    finish(JSON.stringify({ choices: selected, comment }))
                  }
                >
                  save response
                </Button>
              </div>
            </>
          ) : item.kind === 'plan-exit' ? (
            <>
              <p className="dialog-paragraph">
                Leave read-only mode and implement the plan?
              </p>
              <div className="dialog-actions">
                <Button onClick={() => finish('stay read-only')}>
                  stay read-only
                </Button>
                <Button onClick={() => finish('implement plan')}>
                  request implementation
                </Button>
              </div>
            </>
          ) : (
            <>
              <div className="approval-options">
                <Button
                  className="primary"
                  onClick={() => finish('allow once')}
                >
                  allow once
                </Button>
                <Button onClick={() => finish('allow for this session')}>
                  allow for this session
                </Button>
                <Button onClick={() => finish('reject')}>reject</Button>
              </div>
              <label className="field-label" htmlFor="reject-reason">
                reject and explain
              </label>
              <div className="inline-actions">
                <input
                  id="reject-reason"
                  className="input"
                  value={comment}
                  onChange={(event) => setComment(event.target.value)}
                />
                <Button
                  onClick={() =>
                    finish(comment.trim() ? 'reject: ' + comment : 'reject')
                  }
                >
                  send rejection
                </Button>
              </div>
            </>
          )}
        </>
      )}
    </Modal>
  );
}
