export type PlatformRole = 'engineer' | 'viewer' | 'maintainer' | 'expert';
export interface Source {
  id: string;
  title: string;
  kind: 'source' | 'evidence' | 'artifact';
  revision: string;
  versions: { revision: string; content: string }[];
  description: string;
}
export interface Work {
  id: string;
  title: string;
  sessionId: string;
  status: 'running' | 'waiting' | 'completed' | 'draft';
  request: 'none' | 'pause' | 'cancel';
  goal: string;
  operations: string[];
  events: string[];
}
export interface Resource {
  id: string;
  name: string;
  kind: 'workspace' | 'worker' | 'ssh' | 'browser';
  status: 'ready' | 'running' | 'unknown';
  sessionId: string;
  operationId?: string;
  facts: Record<string, string>;
}
export interface Method {
  id: string;
  name: string;
  version: string;
  kind: 'skill' | 'rule' | 'toolkit';
  status: 'published' | 'candidate';
  description: string;
  instructions: string;
  scope: string;
  reviewRequested: boolean;
}
export interface PlatformSnapshot {
  version: 1;
  role: PlatformRole;
  sources: Source[];
  work: Work[];
  resources: Resource[];
  methods: Method[];
  bindings: Record<string, { id: string; version: string }[]>;
  requests: { id: string; kind: string; target: string; at: string }[];
}
export const PLATFORM_KEY = 'circle.workbench.platform-preview.v1';
export function platformFixtures(): PlatformSnapshot {
  return {
    version: 1,
    role: 'engineer',
    sources: [
      {
        id: 'source1',
        title: 'connection lifecycle',
        kind: 'source',
        revision: '4',
        description: 'Product behavior, response ownership and close events.',
        versions: [
          {
            revision: '4',
            content:
              '# connection lifecycle\n\nA reconnect must retain pending responses. Compare both ends before assigning a failure to the network.\n\nSynthetic product documentation for frontend review.',
          },
          {
            revision: '3',
            content:
              '# connection lifecycle · previous revision\n\nTrack the latest close event and response buffer.\n\nThis older sample lacks the two-sided observation requirement.',
          },
        ],
      },
      {
        id: 'evidence1',
        title: 'reconnect observations',
        kind: 'evidence',
        revision: '1',
        description:
          'Client-side trace with an explicitly missing peer observation.',
        versions: [
          {
            revision: '1',
            content:
              'sample observation\nclient: connection closed\npeer: not observed\nconclusion: unverified',
          },
        ],
      },
      {
        id: 'artifact1',
        title: 'regression review',
        kind: 'artifact',
        revision: '1',
        description: 'Checks performed and gaps that still need validation.',
        versions: [
          {
            revision: '1',
            content:
              'covered in sample: normal reconnect\nnot verified: delayed response, interrupted return path\nnot a real test result',
          },
        ],
      },
    ],
    work: [
      {
        id: 'work1',
        title: 'Investigate reconnect behavior',
        sessionId: 'session1',
        status: 'running',
        request: 'none',
        goal: 'Connect code, product knowledge and independent observations before declaring a cause.',
        operations: ['operation1'],
        events: [
          'sample work accepted with source revision 4',
          'waiting for peer-side observation',
        ],
      },
      {
        id: 'work2',
        title: 'Review lifecycle documentation',
        sessionId: 'session2',
        status: 'waiting',
        request: 'none',
        goal: 'Record differences between the guide and the implementation.',
        operations: [],
        events: ['waiting for a source revision'],
      },
    ],
    resources: [
      {
        id: 'resource1',
        name: 'sample workspace',
        kind: 'workspace',
        status: 'ready',
        sessionId: 'workspace1',
        facts: { source: 'synthetic workspace', access: 'read-only sample' },
      },
      {
        id: 'resource2',
        name: 'test-network worker',
        kind: 'worker',
        status: 'ready',
        sessionId: 'worker1',
        facts: { network: 'isolated sample', health: 'not probed' },
      },
      {
        id: 'resource3',
        name: 'LAB-DEVICE-01',
        kind: 'ssh',
        status: 'running',
        sessionId: 'ssh1',
        operationId: 'operation1',
        facts: {
          operation: 'sample log collection',
          stopConfirmation: 'not observed',
        },
      },
      {
        id: 'resource4',
        name: 'management browser',
        kind: 'browser',
        status: 'unknown',
        sessionId: 'browser1',
        facts: {
          controller: 'no connected host',
          view: 'same-session view required',
        },
      },
    ],
    methods: [
      {
        id: 'method1',
        name: 'network investigation',
        version: '0.8.0',
        kind: 'skill',
        status: 'published',
        description:
          'Correlate product behavior with network paths and independent observations.',
        instructions:
          'State the traffic path and observation points. Preserve supporting, conflicting and missing evidence. Do not promote model confidence to verified fact.',
        scope: 'declared product versions and network conditions',
        reviewRequested: false,
      },
      {
        id: 'method2',
        name: 'regression analysis',
        version: '0.5.0',
        kind: 'rule',
        status: 'published',
        description: 'Keep expected behavior separate from observed results.',
        instructions:
          'Check declared rules with scripts. Record other conclusions as judgments and preserve their input and output.',
        scope: 'supported input formats',
        reviewRequested: false,
      },
      {
        id: 'method3',
        name: 'network investigation · candidate',
        version: '0.9.0-rc',
        kind: 'skill',
        status: 'candidate',
        description:
          'Adds return-path observations; requires independent review.',
        instructions:
          'Candidate methods do not become published by loading them into a session.',
        scope: 'not yet independently verified',
        reviewRequested: false,
      },
    ],
    bindings: {},
    requests: [],
  };
}
interface StoragePort {
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
  removeItem: (key: string) => void;
}
/** Separate preview service for B/C/D/E. No Circle conversation or real execution state is owned here. */
export class PlatformPreviewService {
  private snapshot: PlatformSnapshot;
  private listeners = new Set<() => void>();
  private storage?: StoragePort;
  constructor(storage?: StoragePort) {
    this.storage = storage;
    this.snapshot = platformFixtures();
    try {
      const raw = storage?.getItem(PLATFORM_KEY);
      if (raw) {
        const value = JSON.parse(raw);
        if (
          value.version === 1 &&
          ['sources', 'work', 'resources', 'methods', 'requests'].every((key) =>
            Array.isArray(value[key]),
          ) &&
          ['engineer', 'viewer', 'maintainer', 'expert'].includes(value.role) &&
          value.bindings
        )
          this.snapshot = value;
      }
    } catch {
      /* Isolated preview fallback. */
    }
  }
  getSnapshot = () => this.snapshot;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  can = (action: 'read' | 'operate' | 'review') =>
    action === 'read'
      ? this.snapshot.role !== 'maintainer'
      : action === 'review'
        ? this.snapshot.role === 'expert'
        : ['engineer', 'expert'].includes(this.snapshot.role);
  private require(action: 'read' | 'operate' | 'review') {
    if (!this.can(action))
      throw Error('the selected platform role cannot perform this action');
  }
  private update(change: (state: PlatformSnapshot) => void) {
    const next = structuredClone(this.snapshot);
    change(next);
    this.snapshot = next;
    let failed = false;
    try {
      this.storage?.setItem(PLATFORM_KEY, JSON.stringify(next));
    } catch {
      failed = true;
    }
    for (const listener of this.listeners) listener();
    if (failed) throw Error('platform changes are only kept in this tab');
  }
  setRole = (role: PlatformRole) =>
    this.update((state) => {
      state.role = role;
    });
  request = (kind: string, target: string) => {
    this.require('operate');
    this.update((state) => {
      state.requests.unshift({
        id: crypto.randomUUID(),
        kind,
        target,
        at: new Date().toISOString(),
      });
    });
  };
  requestWork = (id: string, request: 'pause' | 'cancel') => {
    this.require('operate');
    this.update((state) => {
      const work = state.work.find((item) => item.id === id);
      if (!work) throw Error('work not found');
      work.request = request;
      work.events.push(request + ' requested; execution remains unverified');
    });
  };
  createWork = (title: string, sessionId: string) => {
    this.require('operate');
    if (!title.trim()) throw Error('describe the work first');
    const id = crypto.randomUUID();
    this.update((state) => {
      state.work.unshift({
        id,
        title: title.trim().slice(0, 80),
        goal: title,
        sessionId,
        status: 'draft',
        request: 'none',
        operations: [],
        events: ['local draft; not accepted by a service'],
      });
    });
    return id;
  };
  addSource = (title: string, content: string) => {
    this.require('operate');
    this.update((state) => {
      state.sources.unshift({
        id: crypto.randomUUID(),
        title,
        kind: 'source',
        revision: '1',
        description: 'Imported into browser preview only.',
        versions: [{ revision: '1', content }],
      });
    });
  };
  bindMethod = (sessionId: string, id: string, enabled: boolean) => {
    this.require('operate');
    const method = this.snapshot.methods.find((item) => item.id === id);
    if (!method || method.status !== 'published')
      throw Error('only a published method can be loaded');
    this.update((state) => {
      const previous = state.bindings[sessionId] ?? [];
      state.bindings[sessionId] = enabled
        ? [
            ...previous.filter((item) => item.id !== id),
            { id, version: method.version },
          ]
        : previous.filter((item) => item.id !== id);
    });
  };
  requestReview = (id: string) => {
    this.require('review');
    this.update((state) => {
      const method = state.methods.find((item) => item.id === id);
      if (!method || method.status !== 'candidate')
        throw Error('candidate method not found');
      method.reviewRequested = true;
    });
  };
  reset = () => {
    this.snapshot = platformFixtures();
    this.storage?.removeItem(PLATFORM_KEY);
    for (const listener of this.listeners) listener();
  };
}
