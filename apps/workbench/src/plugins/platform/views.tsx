import { desktopHost } from '../../host';
import { useState, useSyncExternalStore } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import {
  BookOpen,
  FileText,
  Plus,
  ArrowUpRight,
  CirclePlay,
  Server,
  Terminal,
  Globe,
  Blocks,
  Check,
  Upload,
  Network,
  LockKeyhole,
} from 'lucide-react';
import { usePluginService } from '../context';
import { useRuntime } from '../../app/context';
import { currentSession } from '../../model/state';
import {
  Page,
  Button,
  SearchInput,
  Modal,
  DataBlock,
  Facts,
  Badge,
  Status,
  Switch,
  IconButton,
} from '../../components/common';
import { Markdown } from '../../components/Markdown';
import type { PluginViewProps } from '../types';
import { PlatformPreviewService } from './store';
import type { PlatformRole } from './store';
export function usePlatform() {
  const service = usePluginService<PlatformPreviewService>('platform');
  return {
    service,
    state: useSyncExternalStore(service.subscribe, service.getSnapshot),
  };
}
function RoleSelector() {
  const { service, state } = usePlatform();
  return (
    <label className="platform-role">
      platform view
      <select
        aria-label="platform role"
        value={state.role}
        onChange={(event) =>
          service.setRole(event.target.value as PlatformRole)
        }
      >
        {['engineer', 'viewer', 'maintainer', 'expert'].map((role) => (
          <option key={role}>{role}</option>
        ))}
      </select>
    </label>
  );
}
function AccessGate() {
  return (
    <div className="empty-state">
      <LockKeyhole size={24} />
      <h3>business access required</h3>
      <p>
        The selected platform role can inspect execution infrastructure without
        reading business records.
      </p>
      <RoleSelector />
    </div>
  );
}
function useRecord() {
  const [params, setParams] = useSearchParams();
  return {
    id: params.get('record'),
    params,
    setParams,
    open: (id: string) => setParams({ record: id }),
    close: () => setParams({}),
  };
}
export function KnowledgePage({ sessionId }: PluginViewProps) {
  const { service, state } = usePlatform();
  const { runtime, perform, notify } = useRuntime();
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState('all');
  const record = useRecord();
  if (!service.can('read')) return <AccessGate />;
  const selected = state.sources.find((item) => item.id === record.id);
  const revision = record.params.get('revision') ?? selected?.revision;
  const version = selected?.versions.find((item) => item.revision === revision);
  const attach = () =>
    perform(() => {
      if (!service.can('operate'))
        throw Error('this platform role cannot attach business context');
      if (!selected || !version) return;
      runtime.change((snapshot) => {
        const target = snapshot.sessions.find(
          (session) => session.id === sessionId,
        );
        if (!target) throw Error('session not found');
        const id = `knowledge:${selected.id}@${version.revision}`;
        if (!target.attachments.some((item) => item.id === id))
          target.attachments.push({
            id,
            name: `${selected.title} · rev.${version.revision}`,
            kind: 'file',
            content: version.content,
          });
      });
      notify('source revision attached to this Circle session');
    });
  const importFile = async () => {
    if (desktopHost()) {
      try {
        for (const file of await desktopHost()!.chooseFiles('source')) {
          if (file.truncated) {
            notify('source is too large for this preview');
            continue;
          }
          perform(() => service.addSource(file.name, file.content));
        }
      } catch (error) {
        notify(
          error instanceof Error ? error.message : 'source could not be read',
        );
      }
      return;
    }
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.md,.txt,.json,.log';
    input.onchange = async () => {
      const file = input.files?.[0];
      if (file) {
        if (file.size > 1000000) {
          notify('source exceeds the 1 MB preview limit');
          return;
        }
        const content = await file.text();
        perform(() => service.addSource(file.name, content));
      }
    };
    input.click();
  };
  const sources = state.sources.filter(
    (item) =>
      (filter === 'all' || item.kind === filter) &&
      (item.title + ' ' + item.description)
        .toLowerCase()
        .includes(search.toLowerCase()),
  );
  return (
    <Page
      title="knowledge"
      description="Product sources, evidence and artifacts with explicit revisions."
      action={
        <div className="inline-actions">
          <RoleSelector />
          <Button disabled={!service.can('operate')} onClick={importFile}>
            <Upload size={13} />
            import source
          </Button>
        </div>
      }
    >
      <div className="list-toolbar">
        <SearchInput
          value={search}
          onChange={setSearch}
          label="search knowledge"
        />
        <select
          aria-label="knowledge kind"
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
        >
          {['all', 'source', 'evidence', 'artifact'].map((value) => (
            <option key={value}>{value}</option>
          ))}
        </select>
      </div>
      <div className="records">
        {sources.map((source) => (
          <button
            className="record-row full-row"
            key={source.id}
            onClick={() => record.open(source.id)}
          >
            <FileText size={17} />
            <span>
              <strong>{source.title}</strong>
              <small>{source.description}</small>
            </span>
            <Badge>{source.kind}</Badge>
            <code>rev.{source.revision}</code>
            <ArrowUpRight size={13} />
          </button>
        ))}
      </div>
      <Modal
        open={!!selected}
        onOpenChange={(open) => {
          if (!open) record.close();
        }}
        title={selected?.title ?? 'source'}
        wide
      >
        {selected && (
          <>
            <div className="list-toolbar">
              <label>
                revision
                <select
                  aria-label="source revision"
                  value={revision}
                  onChange={(event) =>
                    record.setParams({
                      record: selected.id,
                      revision: event.target.value,
                    })
                  }
                >
                  {selected.versions.map((version) => (
                    <option key={version.revision} value={version.revision}>
                      rev.{version.revision}
                    </option>
                  ))}
                </select>
              </label>
              <Button
                disabled={!version || !service.can('operate')}
                onClick={attach}
              >
                <Plus size={13} />
                attach revision
              </Button>
            </div>
            <DataBlock
              title="original content"
              value={version?.content ?? 'revision not found'}
            />
            <Facts
              values={{
                source: selected.id,
                published: 'rev.' + selected.revision,
                viewing: 'rev.' + revision,
              }}
            />
            <p className="panel-note">
              Browsing an older revision does not change existing session
              references.
            </p>
          </>
        )}
      </Modal>
    </Page>
  );
}
export function WorkPage({ sessionId }: PluginViewProps) {
  const { service, state } = usePlatform();
  const { runtime, perform, notify } = useRuntime();
  const navigate = useNavigate();
  const record = useRecord();
  const [creating, setCreating] = useState(false);
  const [goal, setGoal] = useState('');
  const [search, setSearch] = useState('');
  if (!service.can('read')) return <AccessGate />;
  const selected = state.work.find((item) => item.id === record.id);
  return (
    <Page
      title="long-running work"
      description="Durable goals and handoffs, separate from Circle sessions and background jobs."
      action={
        <div className="inline-actions">
          <RoleSelector />
          <Button
            disabled={!service.can('operate')}
            onClick={() => setCreating(true)}
          >
            <Plus size={13} />
            new work
          </Button>
        </div>
      }
    >
      <SearchInput
        value={search}
        onChange={setSearch}
        label="search platform work"
      />
      <div className="records">
        {state.work
          .filter((item) =>
            (item.title + ' ' + item.id)
              .toLowerCase()
              .includes(search.toLowerCase()),
          )
          .map((work) => (
            <button
              className="record-row full-row"
              key={work.id}
              onClick={() => record.open(work.id)}
            >
              <CirclePlay size={18} />
              <span>
                <strong>{work.title}</strong>
                <small>
                  {work.id} · {work.sessionId}
                </small>
              </span>
              {work.request !== 'none' && (
                <Badge>{work.request} requested</Badge>
              )}
              <Status value={work.status} />
            </button>
          ))}
      </div>
      <Modal
        open={creating}
        onOpenChange={setCreating}
        title="new long-running work"
        description="Save a local draft linked to the current conversation."
      >
        <form
          className="form-stack"
          onSubmit={(event) => {
            event.preventDefault();
            perform(() => {
              service.createWork(goal, sessionId);
              setGoal('');
              setCreating(false);
              notify('work draft saved; no service has accepted it');
            });
          }}
        >
          <label>
            goal
            <textarea
              aria-label="work goal"
              value={goal}
              onChange={(event) => setGoal(event.target.value)}
              required
            />
          </label>
          <Button type="submit" className="primary">
            save work draft
          </Button>
        </form>
      </Modal>
      <Modal
        open={!!selected}
        onOpenChange={(open) => {
          if (!open) record.close();
        }}
        title={selected?.title ?? 'work'}
        wide
      >
        {selected && (
          <>
            <p className="dialog-paragraph">{selected.goal}</p>
            <Facts
              values={{
                work: selected.id,
                session: selected.sessionId,
                state: selected.status,
                request: selected.request,
                operations: selected.operations.join(', ') || 'none',
              }}
            />
            <div className="inline-actions">
              <Button
                onClick={() =>
                  perform(() => {
                    runtime.selectSession(selected.sessionId);
                    navigate('/session/' + selected.sessionId);
                  })
                }
              >
                source session
                <ArrowUpRight size={12} />
              </Button>
              {(['pause', 'cancel'] as const).map((request) => (
                <Button
                  key={request}
                  disabled={
                    !service.can('operate') || selected.status === 'completed'
                  }
                  onClick={() =>
                    perform(() => {
                      service.requestWork(selected.id, request);
                      notify(
                        `${request} requested; actual execution has not been confirmed`,
                      );
                    })
                  }
                >
                  request {request}
                </Button>
              ))}
            </div>
            <div className="timeline">
              {selected.events.map((event, index) => (
                <div key={index}>
                  <i />
                  {event}
                </div>
              ))}
            </div>
            <p className="panel-note">
              A local Circle pause does not pause this work or stop its
              operations.
            </p>
          </>
        )}
      </Modal>
    </Page>
  );
}
export function ExecutionPage() {
  const { service, state } = usePlatform();
  const { perform, notify } = useRuntime();
  const record = useRecord();
  const [view, setView] = useState('list');
  const selected = state.resources.find((item) => item.id === record.id);
  return (
    <Page
      title="execution resources"
      description="Workspaces, workers, SSH and browser sessions. Observe and control are separate."
      action={<RoleSelector />}
    >
      <div className="segmented page-tabs">
        <button
          className={view === 'list' ? 'active' : ''}
          onClick={() => setView('list')}
        >
          list
        </button>
        <button
          className={view === 'map' ? 'active' : ''}
          onClick={() => setView('map')}
        >
          resource map
        </button>
      </div>
      <div className={view === 'list' ? 'records' : 'resource-map'}>
        {state.resources.map((resource) => (
          <button
            key={resource.id}
            className={
              view === 'list' ? 'record-row full-row' : 'resource-node'
            }
            onClick={() => record.open(resource.id)}
          >
            {resource.kind === 'ssh' ? (
              <Terminal size={18} />
            ) : resource.kind === 'browser' ? (
              <Globe size={18} />
            ) : (
              <Server size={18} />
            )}
            <span>
              <strong>{resource.name}</strong>
              <small>
                {resource.kind} · {resource.sessionId}
              </small>
            </span>
            <Status value={resource.status} />
          </button>
        ))}
      </div>
      {view === 'map' && (
        <p className="panel-note">
          Resource association preview; no network topology has been probed.
        </p>
      )}
      <Modal
        open={!!selected}
        onOpenChange={(open) => {
          if (!open) record.close();
        }}
        title={selected?.name ?? 'resource'}
        wide
      >
        {selected && (
          <>
            <Facts
              values={{
                resource: selected.id,
                session: selected.sessionId,
                operation: selected.operationId ?? 'none',
                state: selected.status,
                ...selected.facts,
              }}
            />
            <div className="inline-actions">
              <Button
                disabled={!service.can('operate')}
                onClick={() =>
                  perform(() => {
                    service.request('request-control', selected.id);
                    notify(
                      'control requested; no execution connection is attached',
                    );
                  })
                }
              >
                request control
              </Button>
              <Button
                onClick={() =>
                  notify('showing sample observation; no live probe was run')
                }
              >
                view observation
              </Button>
            </div>
            <DataBlock
              title="observation record"
              value={{
                resourceId: selected.id,
                sessionId: selected.sessionId,
                operationId: selected.operationId,
                state: selected.status,
                source: 'frontend sample',
                verifiedEffect: false,
              }}
            />
          </>
        )}
      </Modal>
    </Page>
  );
}
export function MethodsPage({ sessionId }: PluginViewProps) {
  const { service, state } = usePlatform();
  const { runtime, perform, notify } = useRuntime();
  const record = useRecord();
  if (!service.can('read')) return <AccessGate />;
  const selected = state.methods.find((item) => item.id === record.id);
  const bindings = state.bindings[sessionId] ?? [];
  const bind = (id: string, enabled: boolean) =>
    perform(() => {
      service.bindMethod(sessionId, id, enabled);
      const method = state.methods.find((item) => item.id === id)!;
      runtime.change((snapshot) => {
        const target = snapshot.sessions.find((item) => item.id === sessionId);
        if (!target) throw Error('session not found');
        const ref = `method:${method.id}@${method.version}`;
        target.attachments = target.attachments.filter(
          (item) => !item.id.startsWith('method:' + method.id + '@'),
        );
        if (enabled)
          target.attachments.push({
            id: ref,
            name: method.name + ' · ' + method.version,
            kind: 'skill',
            content: method.instructions,
          });
      });
      notify(
        enabled
          ? 'method loaded into the Circle session'
          : 'method removed from this session',
      );
    });
  return (
    <Page
      title="methods"
      description="Versioned product capabilities, with loading and publication kept separate."
      action={<RoleSelector />}
    >
      <div className="connection-banner">
        <BookOpen size={16} />
        <span>current session</span>
        <strong>{currentSession(runtime.getSnapshot()).title}</strong>
      </div>
      <div className="records">
        {state.methods.map((method) => (
          <div className="record-row" key={method.id}>
            <button
              className="record-main"
              onClick={() => record.open(method.id)}
            >
              <Blocks size={18} />
              <span>
                <strong>{method.name}</strong>
                <small>{method.description}</small>
              </span>
              <code>{method.version}</code>
              <Status value={method.status} />
            </button>
            <Switch
              label={`load ${method.name}`}
              checked={bindings.some((binding) => binding.id === method.id)}
              disabled={
                !service.can('operate') || method.status !== 'published'
              }
              onChange={(enabled) => bind(method.id, enabled)}
            />
          </div>
        ))}
      </div>
      <Modal
        open={!!selected}
        onOpenChange={(open) => {
          if (!open) record.close();
        }}
        title={selected?.name ?? 'method'}
        wide
      >
        {selected && (
          <>
            <Facts
              values={{
                version: selected.version,
                status: selected.status,
                scope: selected.scope,
                review: selected.reviewRequested
                  ? 'requested; not published'
                  : 'not requested',
              }}
            />
            <Markdown text={selected.instructions} />
            {selected.status === 'candidate' && (
              <div className="dialog-actions">
                <Button
                  disabled={!service.can('review')}
                  onClick={() =>
                    perform(() => {
                      service.requestReview(selected.id);
                      notify(
                        'review requested; publication state is unchanged',
                      );
                    })
                  }
                >
                  request version review
                </Button>
              </div>
            )}
          </>
        )}
      </Modal>
    </Page>
  );
}
export function WorkWidget({ sessionId }: PluginViewProps) {
  const { state, service } = usePlatform();
  const navigate = useNavigate();
  if (!service.can('read')) return null;
  const work = state.work.filter((item) => item.sessionId === sessionId);
  return (
    <div className="panel-section">
      <h3>linked platform work</h3>
      {work.length ? (
        work.map((item) => (
          <button
            className="activity-row"
            key={item.id}
            onClick={() => navigate('/page/work?record=' + item.id)}
          >
            <CirclePlay size={15} />
            <span>
              <strong>{item.title}</strong>
              <small>{item.id}</small>
            </span>
            <Status value={item.status} />
          </button>
        ))
      ) : (
        <p>no long-running work linked</p>
      )}
    </div>
  );
}
export function MethodsWidget({ sessionId }: PluginViewProps) {
  const { state, service } = usePlatform();
  const navigate = useNavigate();
  if (!service.can('read')) return null;
  const methods = state.bindings[sessionId] ?? [];
  return (
    <div className="panel-section">
      <h3>
        platform methods
        <button
          className="text-button"
          onClick={() => navigate('/page/methods')}
        >
          manage
          <ArrowUpRight size={11} />
        </button>
      </h3>
      {methods.length ? (
        methods.map((binding) => (
          <button
            key={binding.id}
            className="activity-row"
            onClick={() => navigate('/page/methods?record=' + binding.id)}
          >
            <Blocks size={14} />
            <span>
              <strong>
                {state.methods.find((item) => item.id === binding.id)?.name}
              </strong>
              <small>{binding.version}</small>
            </span>
          </button>
        ))
      ) : (
        <p>no platform methods loaded</p>
      )}
    </div>
  );
}
export function KnowledgeAction() {
  const { service } = usePlatform();
  const navigate = useNavigate();
  return (
    <Button
      disabled={!service.can('read')}
      onClick={() => navigate('/page/knowledge')}
    >
      <BookOpen size={12} />
      knowledge
    </Button>
  );
}
