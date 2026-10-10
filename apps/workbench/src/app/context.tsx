import {
  createContext,
  useContext,
  useState,
  useSyncExternalStore,
} from 'react';
import type { ReactNode } from 'react';
import type {
  CommandResult,
  RuntimePort,
  WorkbenchSnapshot,
} from '../model/types';
interface ContextValue {
  runtime: RuntimePort;
  snapshot: WorkbenchSnapshot;
  notice: string;
  notify: (message: string) => void;
  perform: (action: () => void) => void;
  act: (action: () => CommandResult) => void;
  setRouter: (handler: (result: CommandResult) => void) => void;
}
const Context = createContext<ContextValue | null>(null);
export function RuntimeProvider({
  runtime,
  children,
}: {
  runtime: RuntimePort;
  children: ReactNode;
}) {
  const snapshot = useSyncExternalStore(runtime.subscribe, runtime.getSnapshot);
  const [notice, setNotice] = useState('');
  const [router] = useState(() => ({
    handler: (_result: CommandResult) => {},
  }));
  const notify = (message: string) => {
    setNotice(message);
    setTimeout(
      () => setNotice((current) => (current === message ? '' : current)),
      4200,
    );
  };
  const perform = (action: () => void) => {
    try {
      action();
    } catch (error) {
      notify(error instanceof Error ? error.message : 'action failed');
    }
  };
  const act = (action: () => CommandResult) =>
    perform(() => {
      const result = action();
      if (result.notice) notify(result.notice);
      router.handler(result);
    });
  return (
    <Context.Provider
      value={{
        runtime,
        snapshot,
        notice,
        notify,
        perform,
        act,
        setRouter: (handler) => {
          router.handler = handler;
        },
      }}
    >
      {children}
    </Context.Provider>
  );
}
export function useRuntime() {
  const value = useContext(Context);
  if (!value) throw Error('RuntimeProvider is required');
  return value;
}
