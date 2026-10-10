import { desktopHost } from './host';
import React from 'react';
import ReactDOM from 'react-dom/client';
import { CircleWorkbench } from './workbench';
import { PreviewRuntime } from './model/state';
import { PlatformPreviewService } from './plugins/platform/store';
import { defaultPlugins } from './plugins/builtins';
import { applyTheme } from './theme';
const runtime = new PreviewRuntime(localStorage);
const services = { platform: new PlatformPreviewService(localStorage) };
applyTheme(runtime.getSnapshot().settings.theme);
async function start() {
  const host = desktopHost();
  if (host) {
    const info = await host.info();
    document.documentElement.dataset.desktop = info.platform;
    document.documentElement.dataset.host = 'desktop';
  }
  ReactDOM.createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
      <CircleWorkbench
        runtime={runtime}
        plugins={defaultPlugins}
        services={services}
      />
    </React.StrictMode>,
  );
}
void start();
