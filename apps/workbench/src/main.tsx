import { desktopHost } from './host';
import React from 'react';
import ReactDOM from 'react-dom/client';
import { CircleWorkbench } from './workbench';
import { PreviewRuntime } from './model/state';
import { LiveRuntime } from './model/live';
import type { RuntimePort } from './model/types';
import { circlePlugins } from './plugins/builtins';
import { applyTheme } from './theme';
import { loadLanguage, locale, subscribeLanguage } from './i18n';
// How far start-up got, for a window that stays blank: each step names
// what it waits for.
const boot = (step: string) => {
  document.documentElement.dataset.boot = step;
};
async function start() {
  boot('host');
  const host = desktopHost();
  let runtime: RuntimePort;
  const info = host ? await host.info() : undefined;
  boot('runtime');
  if (host && info) {
    document.documentElement.dataset.desktop = info.platform;
    document.documentElement.dataset.host = 'desktop';
    runtime = info.frontendOnly
      ? new PreviewRuntime(localStorage)
      : new LiveRuntime(host, await host.runtimeState(), localStorage);
    if (runtime.mode === 'live') {
      boot('subscribe');
      // Subscribe before reading again so updates during bootstrap cannot be missed.
      await host.runtimeCommand({
        id: crypto.randomUUID(),
        name: 'state',
        payload: {},
      });
    }
  } else runtime = new PreviewRuntime(localStorage);
  applyTheme(
    runtime.getSnapshot().settings.theme,
    runtime.getSnapshot().settings.textSize,
  );
  loadLanguage(localStorage, info?.language);
  // Menus, system dialogs and notifications follow the window's language.
  void host?.setLanguage(locale());
  subscribeLanguage(() => void host?.setLanguage(locale()));
  boot('render');
  ReactDOM.createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
      <CircleWorkbench runtime={runtime} plugins={circlePlugins} />
    </React.StrictMode>,
  );
}
void start();
