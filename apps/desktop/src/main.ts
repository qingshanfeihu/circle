import { validateBrowserDiagnosticRequest } from './browser-diagnostics-contracts';
import {
  EncryptedCredentialStore,
  nativeHttpsUrl,
} from './encrypted-credentials';
import { BrowserSessions } from './browser';
import { devToolsMenuShortcut } from './menu-shortcuts';
import { RuntimeSupervisor } from './runtime-supervisor';
import { validateRuntimeCommand } from './runtime-protocol';
import {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  ipcMain,
  Menu,
  nativeTheme,
  net,
  Notification,
  protocol,
  shell,
  session,
  safeStorage,
} from 'electron';
import type { IpcMainInvokeEvent, MenuItemConstructorOptions } from 'electron';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import originalFs from 'original-fs';
import { join, dirname, basename } from 'node:path';
import { WorkspaceGrants, nativeFile } from './files';
import { selectedFolder } from './folder-dialog';
import { attention } from './attention';
import {
  isNativeLocale,
  nativeText,
  systemNativeLocale,
  type NativeLocale,
} from './native-text';
import {
  assetPath,
  assetType,
  boundedText,
  MAX_EXPORT_BYTES,
  MAX_FILE_BYTES,
  safeExternalUrl,
  trustedAppUrl,
  validSaveName,
} from './policy';
import type { DesktopAction, DesktopInfo, UpdateAction } from './contracts';
import { installation, Updater } from './updater';
import { circleAppVersion } from './circle-version';
import { releaseTag, updateCheckEnabled } from '../../../src/update.js';
import { channelOf } from './channel';
// A release, or a beta that package:beta wrote into the packaged package.json
const channel = channelOf(
  (() => {
    try {
      return JSON.parse(
        readFileSync(join(app.getAppPath(), 'package.json'), 'utf8'),
      );
    } catch {
      return undefined;
    }
  })(),
);
app.setName(channel.name);
// Older XDG portals turn a directory chooser into a file chooser, or return no
// path when a folder is confirmed. GTK and KDE dialogs return the folder.
if (process.platform === 'linux')
  app.commandLine.appendSwitch('xdg-portal-required-version', '4');
// Windows shows notifications for the id the installer's Start menu shortcut carries.
if (process.platform === 'win32') app.setAppUserModelId(channel.id);
const dataPath =
  process.env.CIRCLE_WORKBENCH_DATA_DIR ??
  (channel.beta
    ? join(app.getPath('appData'), channel.folder)
    : existsSync(join(app.getPath('appData'), 'Circle Workbench'))
      ? join(app.getPath('appData'), 'Circle Workbench')
      : join(app.getPath('appData'), channel.folder));
app.setPath('userData', dataPath);
// --no-sandbox contradicts enableSandbox(): the main process then crashes
// with an access violation when the first child process starts
// (https://github.com/electron/electron/issues/54838).
if (app.commandLine.hasSwitch('no-sandbox')) {
  process.stderr.write(
    'circle: cannot start with --no-sandbox because the sandbox is required\n',
  );
  process.exit(1);
}
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
let browserClosePending: Promise<void> = Promise.resolve();
// Certificate exceptions live only in this application process, across window recreation.
const browserCertificates = new Map<string, Set<string>>();
let runtime: RuntimeSupervisor | undefined;
let runtimeSessions = new Set<string>();
const workspaceSelections = new Map<string, string>();
const previewMode = process.env.CIRCLE_WORKBENCH_MODE === 'preview';
const rendererRoot = join(__dirname, 'renderer');
const fixtureProfile = process.env.CIRCLE_WORKBENCH_TEST_PROFILE
  ? JSON.parse(process.env.CIRCLE_WORKBENCH_TEST_PROFILE)
  : undefined;
// The window follows the system language; checks read it in English on any machine.
// (Chromium's --lang does not change the languages a page sees on macOS.)
const forcedLanguage: NativeLocale | undefined = process.env
  .CIRCLE_WORKBENCH_LANGUAGE
  ? systemNativeLocale([process.env.CIRCLE_WORKBENCH_LANGUAGE])
  : fixtureProfile
    ? 'en'
    : undefined;
// GTK file dialogs take their button labels from the process locale at init, which is
// before the window can say which language it shows. A Chinese start asks for zh_CN now.
function startupLocale(): NativeLocale {
  if (forcedLanguage) return forcedLanguage;
  try {
    return systemNativeLocale(app.getPreferredSystemLanguages());
  } catch {
    return systemNativeLocale([
      Intl.DateTimeFormat().resolvedOptions().locale ?? '',
    ]);
  }
}
if (startupLocale() === 'zh-CN') {
  app.commandLine.appendSwitch('lang', 'zh-CN');
  if (!/^zh/i.test(process.env.LANG ?? '')) {
    process.env.LANG = 'zh_CN.UTF-8';
    process.env.LC_MESSAGES = 'zh_CN.UTF-8';
  }
  // gettext reads LANGUAGE when the dialog is built, including under the C locale.
  // It does not create the catalog: Recent and Home stay English until gtk30.mo exists.
  if (!process.env.LANGUAGE) process.env.LANGUAGE = 'zh_CN';
}
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
// The window says which language it shows; until it does, the system's.
let interfaceLocale: NativeLocale = 'en';
const text = (value: string) => nativeText(interfaceLocale)(value);
// Electron names role items in English; in Chinese the menu names them itself.
const role = (
  name: NonNullable<MenuItemConstructorOptions['role']>,
  english: string,
): MenuItemConstructorOptions =>
  interfaceLocale === 'en'
    ? { role: name }
    : { role: name, label: text(english) };
function configureMenu() {
  const settingsItem = (): MenuItemConstructorOptions => ({
    label: text('settings'),
    accelerator: 'CmdOrCtrl+,',
    click: () => sendAction('settings'),
  });
  const menu: MenuItemConstructorOptions[] = [];
  if (process.platform === 'darwin')
    menu.push({
      label: app.name,
      submenu: [
        role('about', 'About Circle'),
        { type: 'separator' },
        settingsItem(),
        { type: 'separator' },
        role('hide', 'Hide Circle'),
        role('hideOthers', 'Hide Others'),
        role('unhide', 'Show All'),
        { type: 'separator' },
        role('quit', 'Quit Circle'),
      ],
    });
  menu.push(
    {
      label: text('file'),
      submenu: [
        {
          label: text('new session'),
          accelerator: 'CmdOrCtrl+N',
          click: () => {
            // The menu takes the key. Hand the window back before the
            // renderer focuses the composer, or the typed message is lost.
            window?.webContents.focus();
            sendAction('new');
          },
        },
        {
          label: text('open folder'),
          accelerator: 'CmdOrCtrl+O',
          click: () => sendAction('open-folder'),
        },
        { type: 'separator' },
        { label: text('import session'), click: () => sendAction('import') },
        { label: text('export session'), click: () => sendAction('export') },
        { type: 'separator' },
        // macOS already owns this accelerator on the app menu. One item per
        // platform, or Electron drops the chord.
        ...(process.platform === 'darwin'
          ? []
          : [settingsItem(), { type: 'separator' as const }]),
        process.platform === 'darwin'
          ? role('close', 'Close Window')
          : role('quit', 'Quit Circle'),
      ],
    },
    {
      label: text('edit'),
      submenu: [
        role('undo', 'Undo'),
        role('redo', 'Redo'),
        { type: 'separator' },
        role('cut', 'Cut'),
        role('copy', 'Copy'),
        role('paste', 'Paste'),
        role('selectAll', 'Select All'),
      ],
    },
    {
      label: text('view'),
      submenu: [
        { label: text('session tree'), click: () => sendAction('tree') },
        { type: 'separator' },
        {
          label: text('reload window'),
          accelerator: 'CmdOrCtrl+Shift+R',
          click: () => window?.webContents.reload(),
        },
        {
          ...role('toggleDevTools', 'Toggle Developer Tools'),
          ...devToolsMenuShortcut(process.platform),
        },
        { type: 'separator' },
        role('resetZoom', 'Actual Size'),
        role('zoomIn', 'Zoom In'),
        role('zoomOut', 'Zoom Out'),
        role('togglefullscreen', 'Toggle Full Screen'),
      ],
    },
    {
      label: text('window'),
      submenu: [
        role('minimize', 'Minimize'),
        role('zoom', 'Zoom'),
        ...(process.platform === 'darwin'
          ? [role('front', 'Bring All to Front')]
          : []),
      ],
    },
    {
      label: text('help'),
      submenu: [
        { label: text('Circle help'), click: () => sendAction('help') },
      ],
    },
  );
  Menu.setApplicationMenu(Menu.buildFromTemplate(menu));
}
// Outside the window: a dock badge for the requests that wait, a busy bar on Windows and
// Linux, and a notification for a new request or an ended turn while you are elsewhere.
const announced = new Set<string>();
// Where a release link leads. Chromium's network stack applies the system's proxy settings,
// and net.fetch does not report the address a redirect reached, so the redirect is read here.
function redirectTarget(url: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const request = net.request({ url, method: 'HEAD', redirect: 'manual' });
    const timer = setTimeout(() => {
      request.abort();
      reject(Error('the release check timed out'));
    }, 15000);
    const done = (value: string) => {
      clearTimeout(timer);
      request.abort();
      resolve(value);
    };
    request.on('redirect', (_status, _method, location) =>
      done(new URL(location, url).href),
    );
    request.on('response', () => done(url));
    request.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    request.end();
  });
}
// The about page shows Circle's version. app.getVersion() is 0.1.0 in a
// checkout, which is older than every release, so a check would offer the
// version already installed. A packaged copy uses the version it was built as.
const circleVersion = circleAppVersion(app.isPackaged, app.getVersion());
const updater = new Updater({
  version: circleVersion,
  home: join(dataPath, 'runtime-home'),
  folder: join(dataPath, 'updates'),
  // A beta does not replace itself: the release would take its place
  installation:
    app.isPackaged && !channel.beta
      ? installation(
          process.platform,
          process.arch,
          process.execPath,
          process.env.ProgramFiles,
        )
      : undefined,
  platform: process.platform,
  request: (input, init) => net.fetch(input as string, init),
  latest: async (releases) =>
    releaseTag(await redirectTarget(`${releases}/latest`)),
  // On macOS the installer runs on its own at once. On Windows it starts itself again apart
  // from Circle and returns; Circle waits for that before it quits.
  launch: (command, args) =>
    new Promise<void>((resolve, reject) => {
      const windows = process.platform === 'win32';
      // In the data folder: a working folder inside the application would keep Windows from
      // moving it
      const installer = spawn(command, args, {
        cwd: dataPath,
        detached: !windows,
        stdio: 'ignore',
        windowsHide: true,
      });
      installer.once('error', reject);
      if (!windows) {
        installer.once('spawn', () => resolve());
        installer.unref();
        return;
      }
      const timer = setTimeout(() => {
        installer.kill();
        reject(Error('it did not answer within a minute'));
      }, 60000);
      installer.once('exit', (code) => {
        clearTimeout(timer);
        if (code === 0) resolve();
        else reject(Error(`it exited with ${code}`));
      });
    }),
  quit: () => app.quit(),
  remove: (path) =>
    originalFs.promises.rm(path, {
      recursive: true,
      force: true,
      maxRetries: 3,
    }),
  args: process.argv.slice(1),
});
// The daily check, as the terminal's: the packaged application, unless it is turned off.
function dailyUpdateCheck() {
  if (!app.isPackaged || fixtureProfile || previewMode) return;
  let settings: { update_check?: unknown } = {};
  try {
    settings = JSON.parse(
      readFileSync(join(dataPath, 'runtime-home', 'settings.json'), 'utf8'),
    );
  } catch {
    /* no settings yet: the check is on */
  }
  if (updateCheckEnabled(settings)) void updater.check(false);
}
function showAttention(update: Parameters<typeof attention>[0]) {
  const state = attention(update, announced, text);
  if (process.platform !== 'win32') app.setBadgeCount(state.badge);
  if (process.platform !== 'darwin')
    window?.setProgressBar(state.busy && !state.badge ? 2 : -1);
  if (!window || window.isFocused() || fixtureProfile) return;
  if (state.badge && process.platform === 'darwin')
    app.dock?.bounce('informational');
  if (!Notification.isSupported()) return;
  for (const notice of state.notices) {
    const note = new Notification({ title: notice.title, body: notice.body });
    note.on('click', () => {
      window?.show();
      window?.focus();
    });
    note.show();
  }
}
async function createWindow() {
  window = new BrowserWindow({
    width: 1440,
    height: 960,
    minWidth: 760,
    minHeight: 560,
    title: app.name,
    icon: join(
      __dirname,
      process.platform === 'darwin'
        ? 'assets/circle-macos.png'
        : 'assets/circle.png',
    ),
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
  browsers = new BrowserSessions(
    window,
    (state) => window?.webContents.send('circle:browser-event', state),
    () => interfaceLocale,
    join(dataPath, 'browser-certificates.json'),
    browserCertificates,
    // A browser keeps downloads in the system's Downloads folder; an isolated data folder
    // (development, tests) keeps its own
    process.env.CIRCLE_WORKBENCH_DATA_DIR
      ? join(dataPath, 'downloads')
      : app.getPath('downloads'),
    // How the person handed over the browser: auto mode takes it back by itself
    (id) =>
      runtime?.state().snapshot.sessions.find((row) => row.id === id)?.mode,
    (event) => {
      if (window && !window.isDestroyed())
        window.webContents.send('circle:browser-diagnostic-event', event);
    },
    join(dataPath, 'browser-diagnostics'),
  );
  browsers.sendKey = (event) => {
    if (window && !window.isDestroyed())
      window.webContents.send('circle:browser-key', event);
  };
  // The system's menu takes some of the browser's keys (⌘W closes the window) before
  // the window sees them: while the browser panel has the keyboard, they are its.
  window.webContents.on('before-input-event', (event, input) =>
    browsers?.windowKey(event, input),
  );
  window.webContents.on('did-start-loading', () =>
    browsers?.clearDiagnosticSubscriptions(),
  );
  window.webContents.on('render-process-gone', () =>
    browsers?.clearDiagnosticSubscriptions(),
  );
  runtime?.onSessionCleanup(async (id) => {
    await browsers?.deleteSession(id);
    browserCertificates.delete(id);
  });
  runtime?.onBrowser((request, signal) => {
    if (!browsers) throw Error('the browser is closed');
    return browsers.agent(request, signal);
  });
  window.webContents.setWindowOpenHandler(({ url }) => {
    const allowed = safeExternalUrl(url);
    if (allowed && !fixtureProfile) void shell.openExternal(allowed);
    return { action: 'deny' };
  });
  window.webContents.on('will-navigate', (event, url) => {
    if (!trustedAppUrl(url)) event.preventDefault();
  });
  window.once('ready-to-show', () => window?.show());
  window.on('close', () => {
    if (!browsers) return;
    browserClosePending = Promise.all([
      browserClosePending,
      browsers.close(),
    ]).then(() => {});
    void browserClosePending.catch((error) => {
      void dialog.showMessageBox({
        type: 'error',
        message: text('Circle could not stop its runtime'),
        detail: String(error),
      });
    });
  });
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
    // The packaged app's icon is in its bundle; this one is for running from a build. A
    // missing picture must not keep the app from starting.
    if (process.platform === 'darwin')
      try {
        app.dock?.setIcon(join(__dirname, 'assets/circle-macos.png'));
      } catch (error) {
        process.stderr.write('circle: no dock icon: ' + String(error) + '\n');
      }
    // The window's own files, read whole by Node, which also reads them from
    // the application archive, rather than streamed through Chromium's file
    // loader: the window's start must never wait on a stream of its files.
    protocol.handle('circle', async (request) => {
      try {
        const path = assetPath(rendererRoot, request.url);
        if (!(await stat(path)).isFile())
          return new Response('not found', { status: 404 });
        return new Response(await readFile(path), {
          status: 200,
          headers: {
            'Content-Type': assetType(path),
            'Content-Security-Policy':
              "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self'; connect-src 'self'; object-src 'none'; frame-src 'none'; base-uri 'none'; form-action 'none'",
          },
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
      version: circleVersion,
      platform: process.platform,
      packaged: app.isPackaged,
      dataPath,
      runtimeConnected: runtime?.connected ?? false,
      frontendOnly: previewMode,
      language: forcedLanguage,
    }));
    if (!previewMode) {
      runtime = new RuntimeSupervisor(
        join(dataPath, 'runtime-home'),
        __dirname,
        (url) => {
          // The window opens the link in its browser panel. Without a window, the system
          // browser does, after the same check as links the window opens.
          if (window && !window.isDestroyed()) return;
          const allowed = safeExternalUrl(url);
          if (allowed && !fixtureProfile) void shell.openExternal(allowed);
        },
      );
      runtime.onCredentials(
        new EncryptedCredentialStore(join(dataPath, 'private-credentials'), {
          isEncryptionAvailable: () => safeStorage.isEncryptionAvailable(),
          encryptString: (value) => safeStorage.encryptString(value),
          decryptString: (value) => safeStorage.decryptString(value),
          ...(process.platform === 'linux'
            ? {
                getSelectedStorageBackend: () =>
                  safeStorage.getSelectedStorageBackend(),
              }
            : {}),
        }),
      );
      runtime.onWorkspaceEvent((event) => {
        if (window && !window.isDestroyed())
          window.webContents.send('circle:workspace-event', event);
      });
      runtime.onTokenDelta((delta) => {
        if (window && !window.isDestroyed())
          window.webContents.send('circle:runtime-token-delta', delta);
      });
      runtime.subscribe((update) => {
        const current = new Set(
          update.snapshot.sessions.map((session) => session.id),
        );
        for (const id of runtimeSessions)
          if (!current.has(id)) {
            void browsers?.deleteSession(id).catch(() => {});
            browserCertificates.delete(id);
          }
        runtimeSessions = current;
        window?.webContents.send('circle:runtime-update', update);
        showAttention(update);
      });
      await runtime.start();
    }
    handle('circle:runtime-state', () => {
      if (!runtime) throw Error('runtime not enabled');
      return runtime.state();
    });
    handle('circle:runtime-command', (value) => {
      if (!runtime) throw Error('runtime not enabled');
      const command = validateRuntimeCommand(value);
      if (
        command.name === 'open-workspace' ||
        command.name === 'set-default-workspace'
      ) {
        const path = workspaceSelections.get(
          String(command.payload.workspaceGrant),
        );
        if (!path)
          throw Error('workspace was not selected through the native dialog');
        command.payload = { path };
      }
      if (command.name === 'close')
        throw Error('use the application quit action');
      // A message to Circle hands back the browser the person had
      if (command.name === 'prompt') browsers?.personWrote(command.sessionId);
      return runtime.command(command);
    });
    handle('circle:choose-files', async (purpose) => {
      if (!['attach', 'import', 'source'].includes(String(purpose)))
        throw Error('invalid file selection purpose');
      const paths: string[] =
        fixtureProfile?.files ??
        (
          await dialog.showOpenDialog(window!, {
            title:
              purpose === 'import'
                ? text('import a session')
                : text('choose files'),
            properties:
              purpose === 'attach'
                ? ['openFile', 'multiSelections']
                : ['openFile'],
            filters:
              purpose === 'import'
                ? [
                    {
                      name: text('session or text'),
                      extensions: ['json', 'jsonl', 'md', 'txt'],
                    },
                  ]
                : [
                    {
                      name: text('supported files'),
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
      if (fixtureProfile?.workspace) {
        const selected = await grants.open(fixtureProfile.workspace);
        workspaceSelections.set(selected.id, selected.path);
        return selected;
      }
      // The click that opened the chooser is still in the GTK queue and would
      // cancel it before a folder can be confirmed.
      if (process.platform === 'linux')
        await new Promise((resolve) => setTimeout(resolve, 100));
      const path = selectedFolder(
        await dialog.showOpenDialog(window!, {
          title: text('open folder'),
          properties: ['openDirectory'],
        }),
      );
      if (!path) return null;
      const selected = await grants.open(path);
      workspaceSelections.set(selected.id, selected.path);
      return selected;
    });
    handle('circle:reveal-workspace', (workspaceId) => {
      if (!runtime || typeof workspaceId !== 'string')
        throw Error('invalid workspace');
      const workspace = runtime
        .state()
        .snapshot.workspaces.find((row) => row.id === workspaceId);
      if (!workspace) throw Error('workspace not found');
      if (!fixtureProfile) shell.showItemInFolder(workspace.path);
    });
    // The files of the folder the runtime works in, when it is trusted: the app's own
    // workspace, or one you opened and trusted. Reads still go through granted handles.
    handle('circle:list-workspace', async (workspaceId) => {
      if (!runtime || typeof workspaceId !== 'string')
        throw Error('invalid workspace');
      const snapshot = runtime.state().snapshot;
      const active = snapshot.sessions.find(
        (row) => row.id === snapshot.activeSessionId,
      );
      const workspace = snapshot.workspaces.find(
        (row) => row.id === workspaceId,
      );
      if (
        !workspace ||
        active?.workspaceId !== workspaceId ||
        !workspace.trusted
      )
        return null;
      const listed = await grants.open(workspace.path);
      workspaceSelections.set(listed.id, listed.path);
      return listed;
    });
    let accessibilityRevision = 0;
    const nativeAccessibility = () => ({
      supported: process.platform === 'darwin' || process.platform === 'win32',
      enabled:
        process.platform === 'darwin' || process.platform === 'win32'
          ? app.isAccessibilitySupportEnabled()
          : true,
      revision: accessibilityRevision,
    });
    handle('circle:native-accessibility', () => nativeAccessibility());
    app.on('accessibility-support-changed', () => {
      accessibilityRevision++;
      if (window && !window.isDestroyed())
        window.webContents.send(
          'circle:native-accessibility-changed',
          nativeAccessibility(),
        );
    });
    handle('circle:set-language', (value) => {
      if (!isNativeLocale(value)) throw Error('invalid language');
      interfaceLocale = value;
      configureMenu();
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
            title: text('export session'),
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
      return clipboard.writeText(boundedText(value, MAX_EXPORT_BYTES));
    });
    handle('circle:open-external', async (value) => {
      const url = nativeHttpsUrl(value);
      if (!fixtureProfile) await shell.openExternal(url);
    });
    handle('circle:browser-diagnostics', (id, value) => {
      if (!browsers || !runtime) throw Error('window not ready');
      if (typeof id !== 'string') throw Error('invalid browser session');
      const snapshot = runtime.state().snapshot;
      const session = snapshot.sessions.find((row) => row.id === id);
      if (!session) throw Error('browser session not found');
      const request = validateBrowserDiagnosticRequest(value);
      if (
        !['read', 'watch', 'log'].includes(request.action) &&
        !snapshot.workspaces.find((row) => row.id === session.workspaceId)
          ?.trusted
      )
        throw Error('trust the workspace before changing page diagnostics');
      return browsers.diagnostics(id, request);
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
    handle('circle:set-theme', (dark) => browsers?.setDark(dark === true));
    handle('circle:browser-tabs', (id, action, tab) => {
      if (!browsers) throw Error('window not ready');
      return browsers.tabs(id, action, tab);
    });
    handle('circle:browser-dialog', (id, dialog, accept, text, password) => {
      if (!browsers) throw Error('window not ready');
      return browsers.dialog(id, dialog, accept, text, password);
    });
    handle('circle:browser-dialog-screen', (id, dialog) => {
      if (!browsers) throw Error('window not ready');
      return browsers.dialogScreen(id, dialog);
    });
    handle('circle:browser-choose', (id, chooser) => {
      if (!browsers) throw Error('window not ready');
      return browsers.choose(id, chooser);
    });
    handle('circle:browser-keep-download', (id, download, keep) => {
      if (!browsers) throw Error('window not ready');
      return browsers.keepDownload(id, download, keep);
    });
    handle('circle:browser-certificate', (id, choice, index) => {
      if (!browsers) throw Error('window not ready');
      return browsers.certificate(id, choice, index);
    });
    handle('circle:browser-permission', (id, request, allow) => {
      if (!browsers) throw Error('window not ready');
      return browsers.permission(id, request, allow);
    });
    handle('circle:browser-control', (id, action) => {
      if (!browsers) throw Error('window not ready');
      return browsers.control(id, action);
    });
    handle('circle:browser-page', (id, action, value) => {
      if (!browsers) throw Error('window not ready');
      return browsers.page(id, action, value);
    });
    handle('circle:browser-reveal', (id, download) => {
      if (!browsers) throw Error('window not ready');
      shell.showItemInFolder(browsers.downloadPath(id, download));
    });
    updater.subscribe((state) =>
      window?.webContents.send('circle:update', state),
    );
    handle('circle:update-state', () => updater.state);
    handle('circle:update', (action) => {
      if (!['check', 'download', 'install'].includes(String(action)))
        throw Error('invalid update action');
      return updater.command(action as UpdateAction);
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
    interfaceLocale = systemNativeLocale(app.getPreferredSystemLanguages());
    configureMenu();
    // An update folder it cannot read or clear never keeps the application from starting
    const updated = await updater.start().then(
      (state) => state.phase === 'current',
      () => false,
    );
    await createWindow();
    // Started by the installer, which macOS does not bring to the front by itself
    if (updated) app.focus({ steal: true });
    dailyUpdateCheck();
    app.on('activate', () => {
      if (!BrowserWindow.getAllWindows().length) void createWindow();
    });
  })
  .catch(async (error) => {
    process.stderr.write('desktop startup failed: ' + String(error) + '\n');
    // A failed start exits with an error, after the runtime it may have started has stopped
    await runtime?.close().catch(() => {});
    app.exit(1);
  });
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
let quitting = false;
app.on('before-quit', (event) => {
  if (quitting || !runtime) return;
  event.preventDefault();
  void runtime
    .close()
    .then(async () => {
      await browsers?.close();
      await browserClosePending;
    })
    .then(() => {
      quitting = true;
      app.quit();
    })
    .catch((error) => {
      void dialog.showMessageBox({
        type: 'error',
        message: text('Circle could not stop its runtime'),
        detail: String(error),
      });
    });
});
