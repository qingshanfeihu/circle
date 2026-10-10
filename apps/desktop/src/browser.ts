import { BrowserWindow, WebContentsView } from 'electron';
import { createHash } from 'node:crypto';
import { safeExternalUrl } from './policy';
import { captureFrame } from './capture';
import type { BrowserState, BrowserBounds } from './contracts';
/** One sandboxed native browser per Circle session; UI and future tools share its identity. */
export class BrowserSessions {
  private views = new Map<string, WebContentsView>();
  constructor(private window: BrowserWindow) {}
  private validId(id: unknown): string {
    if (typeof id !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(id))
      throw Error('invalid browser session');
    return id;
  }
  private view(id: string) {
    let view = this.views.get(id);
    if (!view) {
      view = new WebContentsView({
        webPreferences: {
          partition: 'circle-browser-' + id,
          sandbox: true,
          contextIsolation: true,
          nodeIntegration: false,
          webSecurity: true,
        },
      });
      view.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
      view.webContents.on('will-navigate', (event, url) => {
        if (!safeExternalUrl(url)) event.preventDefault();
      });
      view.webContents.on('will-redirect', (event, url) => {
        if (!safeExternalUrl(url)) event.preventDefault();
      });
      view.webContents.session.setPermissionRequestHandler(
        (_contents, _permission, callback) => callback(false),
      );
      view.webContents.session.setPermissionCheckHandler(() => false);
      view.webContents.session.on('will-download', (_event, item) =>
        item.cancel(),
      );
      this.window.contentView.addChildView(view);
      view.setVisible(false);
      this.views.set(id, view);
    }
    return view;
  }
  state(idValue: unknown): BrowserState {
    const id = this.validId(idValue);
    const view = this.views.get(id);
    return {
      sessionId: 'browser:' + id,
      url: view?.webContents.getURL() ?? '',
      title: view?.webContents.getTitle() ?? '',
      loading: view?.webContents.isLoading() ?? false,
      canGoBack: view?.webContents.navigationHistory.canGoBack() ?? false,
      canGoForward: view?.webContents.navigationHistory.canGoForward() ?? false,
    };
  }
  bounds(idValue: unknown, value: unknown, visible: unknown) {
    const id = this.validId(idValue);
    if (!value || typeof value !== 'object')
      throw Error('invalid browser bounds');
    const bounds = value as BrowserBounds;
    const [width, height] = this.window.getContentSize();
    if (
      !['x', 'y', 'width', 'height'].every((key) =>
        Number.isFinite(bounds[key as keyof BrowserBounds]),
      ) ||
      bounds.x < 0 ||
      bounds.y < 0 ||
      bounds.width < 1 ||
      bounds.height < 1 ||
      bounds.x + bounds.width > width + 2 ||
      bounds.y + bounds.height > height + 2
    )
      throw Error('browser bounds exceed the window');
    const view = this.view(id);
    view.setBounds({
      x: Math.round(bounds.x),
      y: Math.round(bounds.y),
      width: Math.round(bounds.width),
      height: Math.round(bounds.height),
    });
    view.setVisible(visible === true);
    return this.state(id);
  }
  async navigate(idValue: unknown, urlValue: unknown) {
    const id = this.validId(idValue);
    if (typeof urlValue !== 'string' || urlValue.length > 4096)
      throw Error('invalid browser URL');
    const url = safeExternalUrl(urlValue);
    if (!url) throw Error('only http or https navigation is supported');
    await this.view(id).webContents.loadURL(url);
    return this.state(id);
  }
  hide(idValue: unknown) {
    const id = this.validId(idValue);
    this.views.get(id)?.setVisible(false);
  }
  async capture(idValue: unknown) {
    const id = this.validId(idValue);
    const view = this.views.get(id);
    if (!view) throw Error('browser session not created');
    const before = this.state(id);
    const { image, attempts, retryErrors } = await captureFrame(() =>
      view.webContents.capturePage(undefined, {
        stayAwake: true,
        stayHidden: !view.getVisible(),
      }),
    );
    if (this.views.get(id) !== view || this.state(id).url !== before.url)
      throw Error('browser changed during capture');
    const bytes = image.toPNG();
    return {
      ...before,
      dataUrl: image.toDataURL(),
      sha256: createHash('sha256').update(bytes).digest('hex'),
      observedAt: new Date().toISOString(),
      attempts,
      retryErrors,
    };
  }
  close() {
    for (const view of this.views.values()) {
      this.window.contentView.removeChildView(view);
      view.webContents.close();
    }
    this.views.clear();
  }
}
