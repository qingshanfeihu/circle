import { useEffect, useRef, useState } from 'react';
import { Camera, Globe, ArrowUpRight } from 'lucide-react';
import { desktopHost } from '../host';
import { useRuntime } from '../app/context';
import { currentSession } from '../model/state';
import type { BrowserState } from '../../../desktop/src/contracts';
import { Button, IconButton, Status } from '../components/common';
export function NativeBrowser() {
  const { snapshot, notify } = useRuntime();
  const id = currentSession(snapshot).id;
  const [url, setUrl] = useState('');
  const [state, setState] = useState<BrowserState | null>(null);
  const [capture, setCapture] = useState<{
    dataUrl: string;
    sha256: string;
    observedAt: string;
  } | null>(null);
  const viewport = useRef<HTMLDivElement>(null);
  const active = useRef(false);
  const host = desktopHost()!;
  useEffect(() => {
    const update = () => {
      const rect = viewport.current?.getBoundingClientRect();
      if (!rect || rect.width < 1 || rect.height < 1) return;
      const visible =
        active.current && !document.querySelector('[role="dialog"]');
      void host
        .browserBounds(
          id,
          { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
          visible,
        )
        .catch(() => {});
    };
    const observer = new ResizeObserver(update);
    if (viewport.current) observer.observe(viewport.current);
    const dialogs = new MutationObserver(update);
    dialogs.observe(document.body, { childList: true, subtree: true });
    addEventListener('resize', update);
    addEventListener('scroll', update, true);
    void host.browserState(id).then((value) => {
      if (value.url && value.url !== 'about:blank') {
        active.current = true;
        setState(value);
        setUrl(value.url);
        requestAnimationFrame(update);
      }
    });
    return () => {
      observer.disconnect();
      dialogs.disconnect();
      removeEventListener('resize', update);
      removeEventListener('scroll', update, true);
      void host.browserHide(id);
    };
  }, [id]);
  const navigate = async () => {
    try {
      active.current = true;
      const result = await host.browserNavigate(id, url);
      setState(result);
      const rect = viewport.current!.getBoundingClientRect();
      await host.browserBounds(
        id,
        { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
        true,
      );
      setUrl(result.url);
      setCapture(null);
    } catch (error) {
      active.current = false;
      notify(error instanceof Error ? error.message : 'navigation failed');
    }
  };
  return (
    <>
      <div className="browser-address">
        <Globe size={13} />
        <input
          aria-label="browser address"
          value={url}
          placeholder="https://…"
          onChange={(event) => setUrl(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') void navigate();
          }}
        />
        <IconButton label="navigate browser" onClick={() => void navigate()}>
          <ArrowUpRight size={14} />
        </IconButton>
      </div>
      <div className="native-browser-viewport" ref={viewport}>
        {!state && (
          <div className="browser-empty">
            <Globe size={30} />
            <h3>open a page</h3>
            <p>A sandboxed native browser belongs to this Circle session.</p>
          </div>
        )}
      </div>
      <div className="native-browser-footer">
        <Status value={state ? 'native browser' : 'not opened'} />
        <code>{state?.sessionId ?? 'browser:' + id}</code>
        <IconButton
          label="capture browser"
          disabled={!state}
          onClick={() =>
            void host.browserCapture(id).then(
              (value) => setCapture(value),
              (error) => notify(String(error)),
            )
          }
        >
          <Camera size={14} />
        </IconButton>
      </div>
      {capture && (
        <details className="context-source">
          <summary>captured observation</summary>
          <img
            className="attachment-image"
            src={capture.dataUrl}
            alt="browser observation"
          />
          <code>{capture.sha256}</code>
          <p className="panel-note">{capture.observedAt}</p>
        </details>
      )}
      <p className="panel-note">
        The local operator controls this session. Agent control will use the
        same session identity when Circle is connected.
      </p>
    </>
  );
}
