import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent, type PointerEvent } from 'react';
import type { CSSProperties } from 'react';
import { Icon } from '../Icon.tsx';
import { browserUrl, urlLabel } from './canvasTiles.ts';
import { keyRoute } from './browserKeys.ts';
import { useBrowserTile } from './useBrowserTile.ts';

/** A real, isolated Chromium page. Websites never run inside the app document. */
export function BrowserTile({ id, url }: { readonly id: string; readonly url: string }) {
  const browser = useBrowserTile(id);
  const address = browser.state?.url && browser.state.url !== 'about:blank' ? browser.state.url : url;
  const [draft, setDraft] = useState(address);
  const [prompt, setPrompt] = useState('');
  const heldKeys = useRef(new Set<string>());
  const lastClick = useRef({ time: 0, x: 0, y: 0, count: 0 });
  const tile = useRef<HTMLDivElement>(null);
  /** Receives typing so input methods (Unikey, IMEs) work; a canvas cannot take text. */
  const keys = useRef<HTMLTextAreaElement>(null);
  const [caret, setCaret] = useState({ left: 0, top: 0 });
  useEffect(() => setDraft(address), [address]);
  useEffect(() => setPrompt(browser.dialog?.defaultValue ?? ''), [browser.dialog]);

  const go = (event: FormEvent) => {
    event.preventDefault();
    const checked = browserUrl(draft, location.origin);
    if (!checked.ok) { browser.setError(checked.reason); return; }
    browser.setError(undefined); setDraft(checked.url);
    browser.send({ type: 'navigate', url: checked.url });
    keys.current?.focus({ preventScroll: true });
  };

  const pointer = (event: PointerEvent<HTMLCanvasElement>, action: 'move' | 'down' | 'up') => {
    if (!browser.connected) return;
    event.stopPropagation();
    const canvas = event.currentTarget, rect = canvas.getBoundingClientRect();
    if (action === 'down') {
      const last = lastClick.current;
      const repeated = Date.now() - last.time < 500 && Math.hypot(event.clientX - last.x, event.clientY - last.y) < 5;
      lastClick.current = { time: Date.now(), x: event.clientX, y: event.clientY, count: repeated ? last.count % 3 + 1 : 1 };
    }
    if (action === 'down') {
      event.preventDefault(); canvas.setPointerCapture(event.pointerId);
      // The input method's candidate window opens where the user clicked.
      setCaret({ left: event.clientX - rect.left, top: event.clientY - rect.top });
      keys.current?.focus({ preventScroll: true });
    }
    if (action === 'up' && canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
    browser.send({ type: 'pointer', action, x: Math.max(0, Math.min(canvas.width - 1, (event.clientX - rect.left) * canvas.width / rect.width)),
      y: Math.max(0, Math.min(canvas.height - 1, (event.clientY - rect.top) * canvas.height / rect.height)),
      button: event.button === 1 ? 'middle' : event.button === 2 ? 'right' : 'left', clicks: action === 'move' ? 1 : lastClick.current.count || 1 });
  };
  const key = (event: KeyboardEvent<HTMLTextAreaElement>, action: 'down' | 'up') => {
    event.stopPropagation();
    if (event.key === 'Escape' && action === 'down' && !event.nativeEvent.isComposing) {
      // A page's full screen (a video player) fills only this tile; Esc leaves it first, then leaves the page.
      if (browser.pageFullscreen) { event.preventDefault(); browser.send({ type: 'exitFullscreen' }); return; }
      event.currentTarget.blur(); return;
    }
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'l') {
      event.preventDefault(); tile.current?.querySelector<HTMLInputElement>('.browser-bar input')?.focus(); return;
    }
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'v') return; // The paste event sends it.
    const value = event.key === ' ' ? 'Space' : event.key;
    if (action === 'up') {
      if (heldKeys.current.delete(value)) { event.preventDefault(); browser.send({ type: 'key', action, key: value }); }
      return;
    }
    const route = keyRoute({ key: event.key, ctrlKey: event.ctrlKey, metaKey: event.metaKey, altKey: event.altKey,
      isComposing: event.nativeEvent.isComposing, altGraph: event.getModifierState('AltGraph') });
    if (route === 'text') return; // The text box receives it; typed() sends the result.
    event.preventDefault();
    heldKeys.current.add(value);
    browser.send({ type: 'key', action, key: value });
  };
  /** Sends whatever the input method put in the text box, then empties it. */
  const typed = (box: HTMLTextAreaElement) => {
    const text = box.value;
    box.value = '';
    if (text) browser.send({ type: 'text', text: text.slice(0, 16000) });
  };
  const caretStyle: CSSProperties = { left: caret.left, top: caret.top };

  return <div className="browser-tile" ref={tile}>
    <form className="browser-bar" onSubmit={go}>
      <button type="button" className="icon-btn" disabled={!browser.connected || !browser.state?.back} onClick={() => browser.send({ type: 'back' })} aria-label="Back" title="Back"><Icon name="chevronLeft" size={14} /></button>
      <button type="button" className="icon-btn" disabled={!browser.connected || !browser.state?.forward} onClick={() => browser.send({ type: 'forward' })} aria-label="Forward" title="Forward"><Icon name="chevronRight" size={14} /></button>
      <button type="button" className="icon-btn" disabled={!browser.connected} onClick={() => browser.send({ type: 'reload' })} aria-label="Reload page" title="Reload"><Icon name="refresh" size={14} /></button>
      <input value={draft} spellCheck={false} aria-label="Page address" placeholder="Website address" onChange={(event) => setDraft(event.target.value)} />
      <button type="submit" className="icon-btn" disabled={!browser.connected} aria-label="Go to address" title="Go"><Icon name="arrow" size={14} /></button>
      <button type="button" className="icon-btn" onClick={() => window.open(address, '_blank', 'noopener,noreferrer')} aria-label="Open in your browser" title="Open in your browser">
        <Icon name="expand" size={14} />
      </button>
    </form>
    {browser.error && <div className="browser-error" role="alert">{browser.error}
      {!browser.connected && <button type="button" className="btn" onClick={browser.reconnect}>Reconnect</button>}
    </div>}
    <div className="browser-viewport" aria-busy={!browser.hasFrame || browser.state?.loading}>
      <canvas ref={browser.canvas} className="browser-page" aria-hidden="true"
        onPointerDown={(event) => pointer(event, 'down')} onPointerMove={(event) => pointer(event, 'move')}
        onPointerUp={(event) => pointer(event, 'up')} onPointerCancel={(event) => pointer(event, 'up')}
        onContextMenu={(event) => event.preventDefault()} onDoubleClick={(event) => event.stopPropagation()} />
      <textarea ref={keys} className="browser-keys" style={caretStyle} role="application" rows={1}
        autoComplete="off" autoCorrect="off" autoCapitalize="off" spellCheck={false}
        aria-label={`Browser: ${browser.state?.title || urlLabel(address)}. Press Escape to leave the page or Control+L for its address.`}
        onKeyDown={(event) => key(event, 'down')} onKeyUp={(event) => key(event, 'up')}
        onInput={(event) => { if (!(event.nativeEvent as InputEvent).isComposing) typed(event.currentTarget); }}
        onCompositionEnd={(event) => typed(event.currentTarget)}
        onBlur={() => { for (const key of heldKeys.current) browser.send({ type: 'key', action: 'up', key }); heldKeys.current.clear(); }}
        onPaste={(event) => { event.preventDefault(); browser.send({ type: 'text', text: event.clipboardData.getData('text/plain').slice(0, 16000) }); }} />
      {!browser.hasFrame && !browser.error && <p className="browser-starting" role="status">Opening browser…</p>}
      {browser.dialog && <form className="browser-dialog" role="dialog" aria-label="Website message" onSubmit={(event) => {
        event.preventDefault(); browser.send({ type: 'dialog', accept: true, text: prompt }); browser.setDialog(undefined);
      }}>
        <p>{browser.dialog.message}</p>
        {browser.dialog.kind === 'prompt' && <input className="text-input" aria-label="Reply to website" value={prompt} onChange={(event) => setPrompt(event.target.value)} autoFocus />}
        <div>
          {browser.dialog.kind !== 'alert' && <button type="button" className="btn" onClick={() => { browser.send({ type: 'dialog', accept: false }); browser.setDialog(undefined); }}>Cancel</button>}
          <button type="submit" className="btn btn-go">OK</button>
        </div>
      </form>}
    </div>
    <p className="browser-status" role="status">{!browser.connected ? 'Disconnected' : browser.state?.loading ? 'Loading page…' : browser.state?.title || 'Browser'}<span>Esc leaves page · Ctrl+L address</span></p>
  </div>;
}
