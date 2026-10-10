import { contextBridge, ipcRenderer } from 'electron';
import type { DesktopAction, DesktopBridge } from './contracts';
const actions = new Set<DesktopAction>([
  'new',
  'tree',
  'import',
  'export',
  'settings',
  'open-folder',
  'help',
]);
const bridge: DesktopBridge = {
  apiVersion: 1,
  info: () => ipcRenderer.invoke('circle:info'),
  chooseFiles: (purpose) => ipcRenderer.invoke('circle:choose-files', purpose),
  chooseWorkspace: () => ipcRenderer.invoke('circle:choose-workspace'),
  readWorkspaceFile: (workspaceId, fileId) =>
    ipcRenderer.invoke('circle:read-workspace-file', workspaceId, fileId),
  saveFile: (options) => ipcRenderer.invoke('circle:save-file', options),
  copyText: (text) => ipcRenderer.invoke('circle:copy-text', text),
  windowControl: (action) =>
    ipcRenderer.invoke('circle:window-control', action),
  browserState: (id) => ipcRenderer.invoke('circle:browser-state', id),
  browserNavigate: (id, url) =>
    ipcRenderer.invoke('circle:browser-navigate', id, url),
  browserBounds: (id, bounds, visible) =>
    ipcRenderer.invoke('circle:browser-bounds', id, bounds, visible),
  browserHide: (id) => ipcRenderer.invoke('circle:browser-hide', id),
  browserCapture: (id) => ipcRenderer.invoke('circle:browser-capture', id),
  onAction: (listener) => {
    const handler = (_event: unknown, value: DesktopAction) => {
      if (actions.has(value)) listener(value);
    };
    ipcRenderer.on('circle:action', handler);
    return () => ipcRenderer.removeListener('circle:action', handler);
  },
};
contextBridge.exposeInMainWorld('circleDesktop', Object.freeze(bridge));
