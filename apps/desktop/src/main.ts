import { BrowserSessions } from './browser';
import {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  ipcMain,
  Menu,
  nativeTheme,
  net,
  protocol,
  shell,
  session,
} from 'electron';
import type { IpcMainInvokeEvent, MenuItemConstructorOptions } from 'electron';
import { mkdir, stat, writeFile } from 'node:fs/promises';
import { join, dirname, basename } from 'node:path';
import { pathToFileURL } from 'node:url';
import { WorkspaceGrants, nativeFile } from './files';
import {
  assetPath,
  boundedText,
  MAX_EXPORT_BYTES,
  MAX_FILE_BYTES,
  safeExternalUrl,
  trustedAppUrl,
  validSaveName,
} from './policy';
import type { DesktopAction, DesktopInfo } from './contracts';
app.setName('Circle Workbench');
const dataPath =
  process.env.CIRCLE_WORKBENCH_DATA_DIR ??
  join(app.getPath('appData'), 'Circle Workbench');
app.setPath('userData', dataPath);
app.enableSandbox();
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'circle',
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
      stream: true,
    },
  },
]);
const grants = new WorkspaceGrants();
let window: BrowserWindow | null = null;
let browsers: BrowserSessions | null = null;
const rendererRoot = join(__dirname, 'renderer');
const fixtureProfile = process.env.CIRCLE_WORKBENCH_TEST_PROFILE
  ? JSON.parse(process.env.CIRCLE_WORKBENCH_TEST_PROFILE)
  : undefined;
function checkSender(event: IpcMainInvokeEvent) {
  if (
    !window ||
    event.sender !== window.webContents ||
    event.senderFrame?.routingId !== window.webContents.mainFrame.routingId ||
    event.senderFrame?.processId !== window.webContents.mainFrame.processId ||
    !trustedAppUrl(event.senderFrame.url)
  )
    throw Error('untrusted IPC sender');
}
function handle(channel: string, handler: (...args: unknown[]) => unknown) {
  ipcMain.handle(channel, (event, ...args) => {
    checkSender(event);
    return handler(...args);
  });
}
const sendAction = (action: DesktopAction) =>
  window?.webContents.send('circle:action', action);
function configureMenu() {
  const menu: MenuItemConstructorOptions[] = [];
  if (process.platform === 'darwin')
    menu.push({
      label: app.name,
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        {
          label: 'settings',
          accelerator: 'CmdOrCtrl+,',
          click: () => sendAction('settings'),
        },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    });
  menu.push(
    {
      label: 'file',
      submenu: [
        {
          label: 'new session',
          accelerator: 'CmdOrCtrl+N',
          click: () => sendAction('new'),
        },
        {
          label: 'open folder',
          accelerator: 'CmdOrCtrl+O',
          click: () => sendAction('open-folder'),
        },
        { type: 'separator' },
        { label: 'import session', click: () => sendAction('import') },
        { label: 'export session', click: () => sendAction('export') },
        { type: 'separator' },
        { role: process.platform === 'darwin' ? 'close' : 'quit' },
      ],
    },
    {
      label: 'edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' },
      ],
    },
    {
      label: 'view',
      submenu: [
        { label: 'session tree', click: () => sendAction('tree') },
        { type: 'separator' },
        {
          label: 'reload window',
          accelerator: 'CmdOrCtrl+Shift+R',
          click: () => window?.webContents.reload(),
        },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { role: 'togglefullscreen' },
      ],
    },
    {
      label: 'window',
      submenu: [
        { role: 'minimize' },
        { role: 'zoom' },
        ...(process.platform === 'darwin'
          ? [{ role: 'front' } as MenuItemConstructorOptions]
          : []),
      ],
    },
    {
      label: 'help',
      submenu: [{ label: 'Circle help', click: () => sendAction('help') }],
    },
  );
  Menu.setApplicationMenu(Menu.buildFromTemplate(menu));
}
async function createWindow() {
  window = new BrowserWindow({
    width: 1440,
    height: 960,
    minWidth: 760,
    minHeight: 560,
    title: app.name,
    icon: join(__dirname, 'assets/circle.png'),
    show: false,
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    trafficLightPosition:
      process.platform === 'darwin' ? { x: 16, y: 15 } : undefined,
    autoHideMenuBar: process.platform !== 'darwin',
    webPreferences: {
      preload: join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    },
  });
  browsers = new BrowserSessions(window);
  window.webContents.setWindowOpenHandler(({ url }) => {
    const allowed = safeExternalUrl(url);
    if (allowed && !fixtureProfile) void shell.openExternal(allowed);
    return { action: 'deny' };
  });
  window.webContents.on('will-navigate', (event, url) => {
    if (!trustedAppUrl(url)) event.preventDefault();
  });
  window.once('ready-to-show', () => window?.show());
  window.on('close', () => browsers?.close());
  window.on('closed', () => {
    browsers = null;
    window = null;
  });
  await window.loadURL('circle://workbench/index.html');
}
app
  .whenReady()
  .then(async () => {
    await mkdir(dataPath, { recursive: true, mode: 0o700 });
    protocol.handle('circle', async (request) => {
      try {
        const path = assetPath(rendererRoot, request.url);
        if (!(await stat(path)).isFile())
          return new Response('not found', { status: 404 });
        const response = await net.fetch(pathToFileURL(path).href);
        const headers = new Headers(response.headers);
        headers.set(
          'Content-Security-Policy',
          "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self'; connect-src 'self'; object-src 'none'; frame-src 'none'; base-uri 'none'; form-action 'none'",
        );
        return new Response(response.body, {
          status: response.status,
          headers,
        });
      } catch {
        return new Response('not found', { status: 404 });
      }
    });
    session.defaultSession.setPermissionRequestHandler(
      (_contents, _permission, callback) => callback(false),
    );
    session.defaultSession.setPermissionCheckHandler(() => false);
    handle('circle:info', (): DesktopInfo => ({
      kind: 'desktop',
      name: app.name,
      version: app.getVersion(),
      platform: process.platform,
      packaged: app.isPackaged,
      dataPath,
      runtimeConnected: false,
      frontendOnly: true,
    }));
    handle('circle:choose-files', async (purpose) => {
      if (!['attach', 'import', 'source'].includes(String(purpose)))
        throw Error('invalid file selection purpose');
      const paths: string[] =
        fixtureProfile?.files ??
        (
          await dialog.showOpenDialog(window!, {
            title: purpose === 'import' ? 'import a session' : 'choose files',
            properties:
              purpose === 'attach'
                ? ['openFile', 'multiSelections']
                : ['openFile'],
            filters:
              purpose === 'import'
                ? [
                    {
                      name: 'session or text',
                      extensions: ['json', 'jsonl', 'md', 'txt'],
                    },
                  ]
                : [
                    {
                      name: 'supported files',
                      extensions: [
                        'txt',
                        'md',
                        'ts',
                        'tsx',
                        'js',
                        'json',
                        'jsonl',
                        'py',
                        'log',
                        'csv',
                        'yaml',
                        'yml',
                        'png',
                        'jpg',
                        'jpeg',
                        'gif',
                        'webp',
                        'pdf',
                      ],
                    },
                  ],
          })
        ).filePaths;
      return Promise.all(
        paths
          .slice(0, 16)
          .map((path) =>
            nativeFile(
              path,
              purpose === 'import'
                ? MAX_FILE_BYTES
                : purpose === 'source'
                  ? 1_000_000
                  : 256_000,
            ),
          ),
      );
    });
    handle('circle:choose-workspace', async () => {
      const paths: string[] = fixtureProfile?.workspace
        ? [fixtureProfile.workspace]
        : (
            await dialog.showOpenDialog(window!, {
              title: 'open a workspace',
              properties: ['openDirectory'],
            })
          ).filePaths;
      return paths[0] ? grants.open(paths[0]) : null;
    });
    handle('circle:read-workspace-file', async (workspaceId, fileId) => {
      if (typeof workspaceId !== 'string' || typeof fileId !== 'string')
        throw Error('invalid workspace file handle');
      return grants.read(workspaceId, fileId);
    });
    handle('circle:save-file', async (value) => {
      if (!value || typeof value !== 'object' || Array.isArray(value))
        throw Error('invalid export');
      const options = value as Record<string, unknown>;
      const name = validSaveName(options.name);
      const content = boundedText(options.content, MAX_EXPORT_BYTES);
      const result = fixtureProfile?.exportPath
        ? { canceled: false, filePath: fixtureProfile.exportPath }
        : await dialog.showSaveDialog(window!, {
            title: 'export preview',
            defaultPath: name,
          });
      if (result.canceled || !result.filePath) return { saved: false };
      await writeFile(result.filePath, content, {
        encoding: 'utf8',
        mode: 0o600,
      });
      return { saved: true, name: basename(result.filePath) };
    });
    handle('circle:copy-text', (value) => {
      clipboard.writeText(boundedText(value, MAX_EXPORT_BYTES));
    });
    handle('circle:browser-state', (id) => {
      if (!browsers) throw Error('window not ready');
      return browsers.state(id);
    });
    handle('circle:browser-navigate', (id, url) => {
      if (!browsers) throw Error('window not ready');
      return browsers.navigate(id, url);
    });
    handle('circle:browser-bounds', (id, bounds, visible) => {
      if (!browsers) throw Error('window not ready');
      return browsers.bounds(id, bounds, visible);
    });
    handle('circle:browser-hide', (id) => browsers?.hide(id));
    handle('circle:browser-capture', (id) => {
      if (!browsers) throw Error('window not ready');
      return browsers.capture(id);
    });
    handle('circle:window-control', (action) => {
      if (!window) return;
      switch (action) {
        case 'minimize':
          window.minimize();
          break;
        case 'maximize':
          window.isMaximized() ? window.unmaximize() : window.maximize();
          break;
        case 'close':
          window.close();
          break;
        case 'quit':
          app.quit();
          break;
        default:
          throw Error('invalid window action');
      }
    });
    configureMenu();
    await createWindow();
    app.on('activate', () => {
      if (!BrowserWindow.getAllWindows().length) void createWindow();
    });
  })
  .catch((error) => {
    process.stderr.write('desktop startup failed: ' + String(error) + '\n');
    app.quit();
  });
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
