export interface NativeFile {
  id: string;
  name: string;
  mime: string;
  size: number;
  content: string;
  kind: 'file' | 'image' | 'document';
  truncated: boolean;
}
export interface NativeWorkspace {
  id: string;
  name: string;
  path: string;
  files: { id: string; path: string; language: string }[];
  truncated: boolean;
}
export interface DesktopInfo {
  kind: 'desktop';
  name: string;
  version: string;
  platform: string;
  packaged: boolean;
  dataPath: string;
  runtimeConnected: false;
  frontendOnly: true;
}
export type DesktopAction =
  'new' | 'tree' | 'import' | 'export' | 'settings' | 'open-folder' | 'help';
export interface DesktopBridge {
  apiVersion: 1;
  info: () => Promise<DesktopInfo>;
  chooseFiles: (
    purpose: 'attach' | 'import' | 'source',
  ) => Promise<NativeFile[]>;
  chooseWorkspace: () => Promise<NativeWorkspace | null>;
  readWorkspaceFile: (
    workspaceId: string,
    fileId: string,
  ) => Promise<NativeFile>;
  saveFile: (options: {
    name: string;
    content: string;
    mime?: string;
  }) => Promise<{ saved: boolean; name?: string }>;
  copyText: (text: string) => Promise<void>;
  windowControl: (
    action: 'minimize' | 'maximize' | 'close' | 'quit',
  ) => Promise<void>;
  browserState: (sessionId: string) => Promise<BrowserState>;
  browserNavigate: (sessionId: string, url: string) => Promise<BrowserState>;
  browserBounds: (
    sessionId: string,
    bounds: BrowserBounds,
    visible: boolean,
  ) => Promise<BrowserState>;
  browserHide: (sessionId: string) => Promise<void>;
  browserCapture: (
    sessionId: string,
  ) => Promise<
    BrowserState & { dataUrl: string; sha256: string; observedAt: string }
  >;
  onAction: (listener: (action: DesktopAction) => void) => () => void;
}

export interface BrowserBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}
export interface BrowserState {
  sessionId: string;
  url: string;
  title: string;
  loading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
}
