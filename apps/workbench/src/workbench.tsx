import { HashRouter } from 'react-router-dom';
import { App } from './app/App';
import { RuntimeProvider } from './app/context';
import { PluginProvider } from './plugins/context';
import type { RuntimePort } from './model/types';
import type { WorkbenchPlugin, ServiceRegistry } from './plugins/types';
import './styles/app.css';
/** Hosts inject the Circle session port and independent, versioned component plugins. */
export function CircleWorkbench({
  runtime,
  plugins,
  services = {},
}: {
  runtime: RuntimePort;
  plugins: WorkbenchPlugin[];
  services?: ServiceRegistry;
}) {
  return (
    <RuntimeProvider runtime={runtime}>
      <PluginProvider plugins={plugins} services={services}>
        <HashRouter>
          <App />
        </HashRouter>
      </PluginProvider>
    </RuntimeProvider>
  );
}
export type { RuntimePort } from './model/types';
export type { WorkbenchPlugin, ServiceRegistry } from './plugins/types';
