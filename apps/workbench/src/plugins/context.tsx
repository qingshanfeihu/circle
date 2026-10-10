import {
  createContext,
  useContext,
  useMemo,
  useSyncExternalStore,
} from 'react';
import type { ReactNode } from 'react';
import { useRuntime } from '../app/context';
import { PluginRegistry } from './registry';
import type { ServiceRegistry, WorkbenchPlugin, PluginService } from './types';
interface Value {
  registry: PluginRegistry;
  services: ServiceRegistry;
  enabled: string[];
  toggle: (id: string, enabled: boolean) => void;
}
const Context = createContext<Value | null>(null);
export function PluginProvider({
  plugins,
  services,
  children,
}: {
  plugins: WorkbenchPlugin[];
  services: ServiceRegistry;
  children: ReactNode;
}) {
  const { snapshot, runtime, perform } = useRuntime();
  const registry = useMemo(() => new PluginRegistry(plugins), [plugins]);
  return (
    <Context.Provider
      value={{
        registry,
        services,
        enabled: snapshot.uiPlugins,
        toggle: (id, enabled) =>
          perform(() =>
            runtime.change((state) => {
              state.uiPlugins = registry.change(state.uiPlugins, id, enabled);
            }),
          ),
      }}
    >
      {children}
    </Context.Provider>
  );
}
export function usePlugins() {
  const value = useContext(Context);
  if (!value) throw Error('PluginProvider is required');
  return value;
}
export function usePluginService<T extends PluginService>(id: string): T {
  const { services } = usePlugins();
  const service = services[id];
  if (!service) throw Error('service not supplied: ' + id);
  return service as T;
}
