import { useEffect, useLayoutEffect, useRef } from 'react';
import { FitAddon } from '@xterm/addon-fit';
import { Terminal } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';
import type { ConsoleServerMessage } from '../../../../daemon/pty/types.ts';
import { consoleSocket, type ConsoleKind } from '../../api.ts';
import { AGENT_NEWLINE, isAgentShiftEnter } from './terminalKeys.ts';

const SCROLLBACK_LINES = 5000;
const THEME = { background: '#0b0b0d', foreground: '#e6e6ea', cursor: '#e6e6ea', selectionBackground: '#2c3a55' };
/** The daemon accepts at most 64 KiB per message; a big paste goes up in pieces well under that. */
const INPUT_CHUNK_CHARS = 16 * 1024;
const CLOSE_NO_SUCH_CONSOLE = 4404;
const BASE_FONT_PX = 13;
/** xterm cannot measure a cell much smaller than this; far-out overview zooms stop shrinking the text here. */
const MIN_FONT_PX = 2;
/** Refitting waits for a resize or zoom gesture to settle, so the program in the terminal is not redrawn on every frame. */
const FIT_DELAY_MS = 120;

const fontFor = (scale: number): number => Math.max(MIN_FONT_PX, BASE_FONT_PX * scale);

const dim = (text: string): string => `\r\n\x1b[2m[${text}]\x1b[0m\r\n`;

function parseMessage(raw: unknown): ConsoleServerMessage | undefined {
  try {
    return JSON.parse(String(raw)) as ConsoleServerMessage;
  } catch {
    return undefined;
  }
}

/**
 * One live terminal: xterm.js drawing the output of a console's real pseudo-terminal, and sending keystrokes back.
 * `scale` is the canvas zoom: the font grows and shrinks with the tile, so the same columns and rows stay in view at
 * any zoom. (A CSS transform would do that too, but it breaks xterm's mouse selection and FitAddon's measuring.)
 */
export function TerminalPane({ consoleId, label, kind, scale = 1 }: {
  readonly consoleId: string;
  readonly label: string;
  /** Agent consoles (Claude Code, Codex) get Shift+Enter as "new line"; a shell keeps xterm's default. */
  readonly kind?: ConsoleKind;
  readonly scale?: number;
}) {
  const host = useRef<HTMLDivElement>(null);
  const kindRef = useRef(kind);
  kindRef.current = kind;
  const live = useRef<{ readonly terminal: Terminal; readonly refit: () => void } | undefined>(undefined);
  const scaleRef = useRef(scale);
  scaleRef.current = scale;

  // Before paint, so the text and the tile change size in the same frame.
  useLayoutEffect(() => {
    const current = live.current;
    if (!current) return;
    current.terminal.options.fontSize = fontFor(scale);
    current.refit();
  }, [scale]);

  useEffect(() => {
    const element = host.current;
    if (!element) return undefined;
    const terminal = new Terminal({
      fontFamily: '"Cascadia Mono", Consolas, "SF Mono", Menlo, monospace',
      fontSize: fontFor(scaleRef.current),
      cursorBlink: true,
      scrollback: SCROLLBACK_LINES,
      theme: THEME,
    });
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    terminal.open(element);
    const socket = consoleSocket(consoleId);
    /** Replaying old output makes xterm answer its terminal queries again; those answers are not keystrokes. */
    let replayed = false;
    const send = (message: unknown) => { if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message)); };
    /** The size the daemon last heard, so zooming (same columns and rows, different font) sends nothing. */
    let sentSize = '';
    const sync = () => {
      if (!element.clientWidth || !element.clientHeight) return;
      // Zoomed out past the smallest font, the text no longer shrinks with the tile. Refitting there would squeeze the
      // real terminal down to a few columns, so its size is left as it was until the zoom comes back.
      if (BASE_FONT_PX * scaleRef.current < MIN_FONT_PX) return;
      fit.fit();
      const size = `${terminal.cols}x${terminal.rows}`;
      if (size === sentSize || socket.readyState !== WebSocket.OPEN) return;
      send({ type: 'resize', cols: terminal.cols, rows: terminal.rows });
      sentSize = size;
    };
    let fitTimer: ReturnType<typeof setTimeout> | undefined;
    const refit = () => {
      clearTimeout(fitTimer);
      fitTimer = setTimeout(sync, FIT_DELAY_MS);
    };
    live.current = { terminal, refit };
    socket.onopen = sync;
    socket.onmessage = (event) => {
      const message = parseMessage(event.data);
      if (!message) return;
      if (message.type === 'replay') terminal.write(message.data, () => { replayed = true; });
      else if (message.type === 'output') terminal.write(message.data);
      else if (message.type === 'exit') terminal.write(dim(`process exited with code ${message.code}`));
      else terminal.write(dim('this console was closed'));
    };
    socket.onclose = (event) => {
      terminal.write(dim(event.code === CLOSE_NO_SUCH_CONSOLE ? 'this console was closed' : 'disconnected'));
    };
    // xterm sends Shift+Enter as a bare carriage return, which submits the prompt. Every phase of the key
    // (keydown, keypress, keyup) is swallowed so xterm adds no "\r" of its own; keydown sends the newline once.
    terminal.attachCustomKeyEventHandler((event) => {
      if (!isAgentShiftEnter(event, kindRef.current)) return true;
      if (event.type === 'keydown') {
        event.preventDefault();
        if (replayed) send({ type: 'input', data: AGENT_NEWLINE });
      }
      return false;
    });
    const typing = terminal.onData((data) => {
      if (!replayed) return;
      for (let start = 0; start < data.length; start += INPUT_CHUNK_CHARS) {
        send({ type: 'input', data: data.slice(start, start + INPUT_CHUNK_CHARS) });
      }
    });
    const observer = new ResizeObserver(refit);
    observer.observe(element);
    return () => {
      live.current = undefined;
      clearTimeout(fitTimer);
      observer.disconnect();
      typing.dispose();
      socket.onopen = null;
      socket.onmessage = null;
      socket.onclose = null;
      socket.close();
      terminal.dispose();
    };
  }, [consoleId]);

  return <div className="terminal-pane" ref={host} role="group" aria-label={`Terminal: ${label}`} />;
}
