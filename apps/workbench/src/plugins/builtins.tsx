import {
  Folder,
  FileDiff,
  Activity,
  Globe,
  BookOpen,
  CirclePlay,
  Server,
  Blocks,
} from 'lucide-react';
import {
  FilesPanel,
  ChangesPanel,
  ActivityPanel,
  BrowserPanel,
} from '../features/Panels';
import {
  KnowledgePage,
  WorkPage,
  ExecutionPage,
  MethodsPage,
  WorkWidget,
  MethodsWidget,
  KnowledgeAction,
} from './platform/views';
import type { WorkbenchPlugin } from './types';
export const circlePlugins: WorkbenchPlugin[] = [
  {
    id: 'files',
    apiVersion: 1,
    version: '0.1.0',
    title: 'file and diff inspector',
    description:
      'Workspace files, local preview buffers and change comparison.',
    icon: Folder,
    panels: [
      {
        id: 'files',
        title: 'files',
        icon: Folder,
        component: (props) => (
          <FilesPanel selection={props.selection} onFile={props.onFile} />
        ),
      },
      {
        id: 'changes',
        title: 'changes',
        icon: FileDiff,
        component: (props) => <ChangesPanel onFile={props.onFile} />,
      },
    ],
  },
  {
    id: 'activity',
    apiVersion: 1,
    version: '0.1.0',
    title: 'activity inspector',
    description: 'Circle background jobs, subagents and pending interactions.',
    icon: Activity,
    panels: [
      {
        id: 'activity',
        title: 'activity',
        icon: Activity,
        component: (props) => <ActivityPanel {...props} />,
      },
    ],
  },
  {
    id: 'browser',
    apiVersion: 1,
    version: '0.1.0',
    title: 'browser pane',
    description:
      'The same browser session shared with the future desktop host.',
    icon: Globe,
    panels: [
      { id: 'browser', title: 'browser', icon: Globe, component: BrowserPanel },
    ],
  },
];
export const platformPlugins: WorkbenchPlugin[] = [
  {
    id: 'knowledge',
    apiVersion: 1,
    version: '0.1.0',
    title: 'knowledge',
    description:
      'B · product sources, evidence and artifacts with pinned revisions.',
    icon: BookOpen,
    recordPage: 'knowledge',
    pages: [
      {
        id: 'knowledge',
        title: 'knowledge',
        icon: BookOpen,
        component: KnowledgePage,
      },
    ],
    composerActions: [{ id: 'attach-knowledge', component: KnowledgeAction }],
  },
  {
    id: 'work',
    apiVersion: 1,
    version: '0.1.0',
    title: 'long-running work',
    description:
      'C · durable goals, waiting items, handoffs and completion records.',
    icon: CirclePlay,
    recordPage: 'work',
    pages: [
      {
        id: 'work',
        title: 'long-running work',
        icon: CirclePlay,
        component: WorkPage,
      },
    ],
    widgets: [{ id: 'linked-platform-work', component: WorkWidget }],
  },
  {
    id: 'execution',
    apiVersion: 1,
    version: '0.1.0',
    title: 'execution resources',
    description:
      'D · workspace, worker, SSH and browser observation and control.',
    icon: Server,
    recordPage: 'execution',
    pages: [
      {
        id: 'execution',
        title: 'execution resources',
        icon: Server,
        component: ExecutionPage,
      },
    ],
  },
  {
    id: 'methods',
    apiVersion: 1,
    version: '0.1.0',
    title: 'methods',
    description: 'E · versioned skills, toolkits and product rules.',
    icon: Blocks,
    recordPage: 'methods',
    pages: [
      { id: 'methods', title: 'methods', icon: Blocks, component: MethodsPage },
    ],
    widgets: [{ id: 'session-methods', component: MethodsWidget }],
  },
];
export const defaultPlugins = [...circlePlugins, ...platformPlugins];
