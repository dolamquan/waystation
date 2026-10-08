import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { Icon } from '../components/Icon.tsx';
import {
  appendDictation, commandQuery, matchCommands, parseComposer, parseSpoken, type CommandKind, type ComposerCommand, type WaystationCommand,
} from './commands.ts';
import { useSpeech } from './useSpeech.ts';
import { CommandResultView } from './CommandResultView.tsx';
import type { CommandResult } from '../../../shared/claudeCommands.ts';
import './composer.css';

const HISTORY_MAX = 30;

const KIND_TAG: Readonly<Record<CommandKind, string>> = { native: 'Claude Code', send: 'Claude Code', waystation: 'Waystation', unavailable: 'Terminal only' };
const HELP_GROUPS: ReadonlyArray<{ readonly kinds: readonly CommandKind[]; readonly title: string }> = [
  { kinds: ['native', 'send'], title: 'Claude Code commands' },
  { kinds: ['waystation'], title: 'Waystation controls' },
  { kinds: ['unavailable'], title: 'Only in Claude Code’s terminal' },
];

interface MessageComposerProps {
  readonly commands: readonly ComposerCommand[];
  /** How a message reaches this agent, e.g. "Delivered after the next tool call." */
  readonly hint: string;
  readonly busy: boolean;
  readonly onSend: (text: string) => Promise<boolean>;
  readonly onRun: (name: WaystationCommand, arg: string) => Promise<boolean>;
  /** Claude Code commands Waystation answers (/usage, /mcp, /model…); undefined when the request failed. */
  readonly onNative: (name: string, arg: string) => Promise<CommandResult | undefined>;
  /** Offered next to commands that need Claude Code's terminal. */
  readonly onOpenCli?: () => void;
}

/** A coding-agent style prompt box: slash commands with a menu, Enter to send, ↑ for history, and voice dictation. */
export function MessageComposer({ commands, hint, busy, onSend, onRun, onNative, onOpenCli }: MessageComposerProps) {
  const uid = useId();
  const input = useRef<HTMLTextAreaElement>(null);
  const [text, setText] = useState('');
  const [active, setActive] = useState(0);
  const [menuClosedFor, setMenuClosedFor] = useState<string>();
  const [error, setError] = useState<string>();
  const [showHelp, setShowHelp] = useState(false);
  const [history, setHistory] = useState<readonly string[]>([]);
  const [historyAt, setHistoryAt] = useState<number>();
  const [result, setResult] = useState<{ readonly command: string; readonly result: CommandResult }>();
  const [notice, setNotice] = useState<string>();
  const [running, setRunning] = useState(false);
  const textRef = useRef(text);
  useEffect(() => { textRef.current = text; }, [text]);

  const query = commandQuery(text);
  const matches = useMemo(() => (query === undefined ? [] : matchCommands(query, commands)), [query, commands]);
  const menuOpen = matches.length > 0 && menuClosedFor !== text;
  const selected = matches[Math.min(active, matches.length - 1)];

  const update = (next: string) => {
    setText(next);
    setActive(0);
    setError(undefined);
    setNotice(undefined);
    setHistoryAt(undefined);
  };

  const remember = (value: string) => {
    setHistory(previous => [...previous.filter(item => item !== value.trim()), value.trim()].slice(-HISTORY_MAX));
    update('');
  };

  const runNative = async (value: string, name: string, arg: string): Promise<void> => {
    setRunning(true);
    try {
      const answer = await onNative(name, arg);
      if (!answer) return;
      setResult({ command: value.trim(), result: answer });
      remember(value);
    } finally {
      setRunning(false);
    }
  };

  const submit = async (value: string): Promise<void> => {
    if (busy || running) return;
    const action = parseComposer(value, commands);
    switch (action.kind) {
      case 'none': return;
      case 'error': setError(action.message); setMenuClosedFor(value); return;
      case 'unavailable': setNotice(action.message); setMenuClosedFor(value); return;
      case 'native': await runNative(value, action.name, action.arg); return;
      case 'run':
        if (action.name === 'help') { setShowHelp(open => !open); update(''); return; }
        if (await onRun(action.name, action.arg)) remember(value);
        return;
      case 'send':
        if (await onSend(action.text)) remember(value);
    }
  };

  const speech = useSpeech((phrase) => {
    const spoken = parseSpoken(phrase);
    const next = appendDictation(textRef.current, spoken.text);
    update(next);
    textRef.current = next;
    if (spoken.send) { speech.stop(); void submit(next); }
  });

  const choose = (command: ComposerCommand, run: boolean) => {
    // Optional arguments ("[model]") don't stop Enter from running the command right away.
    const needsMore = command.needsArg || command.args?.startsWith('<') === true;
    if (run && !needsMore) { void submit(`/${command.name}`); return; }
    const completed = `/${command.name}${command.args ? ' ' : ''}`;
    update(completed);
    input.current?.focus();
  };

  const recall = (direction: -1 | 1) => {
    if (!history.length) return false;
    const from = historyAt ?? history.length;
    const to = from + direction;
    if (to < 0) return true;
    if (to >= history.length) { setHistoryAt(undefined); setText(''); return true; }
    setHistoryAt(to);
    setText(history[to]);
    return true;
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (menuOpen) {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        const step = event.key === 'ArrowDown' ? 1 : -1;
        setActive(index => (index + step + matches.length) % matches.length);
        return;
      }
      if ((event.key === 'Tab' || (event.key === 'Enter' && !event.shiftKey)) && selected) {
        event.preventDefault();
        choose(selected, event.key === 'Enter');
        return;
      }
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setMenuClosedFor(text); return; }
    }
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void submit(text); return; }
    const caretAtStart = event.currentTarget.selectionStart === 0 && event.currentTarget.selectionEnd === 0;
    if (event.key === 'ArrowUp' && (caretAtStart || historyAt !== undefined) && recall(-1)) { event.preventDefault(); return; }
    if (event.key === 'ArrowDown' && historyAt !== undefined && recall(1)) event.preventDefault();
  };

  const listId = `${uid}-commands`;
  const optionId = (index: number) => `${uid}-option-${index}`;
  return (
    <form className="detail-composer agent-composer" onSubmit={event => { event.preventDefault(); void submit(text); }}>
      <label htmlFor={`${uid}-input`}>Send a message</label>
      <div className="composer-field">
        {menuOpen && (
          <ul className="composer-menu" role="listbox" id={listId} aria-label="Commands">
            {matches.map((command, index) => (
              <li key={`${command.kind}-${command.name}`} id={optionId(index)} role="option" aria-selected={command === selected}
                className={`${command === selected ? 'composer-option-active' : ''} ${command.kind === 'unavailable' ? 'composer-option-unavailable' : ''}`}
                title={command.reason}
                onMouseDown={event => { event.preventDefault(); choose(command, true); }} onMouseEnter={() => setActive(index)}>
                <span className="composer-command">/{command.name}{command.args && <em> {command.args}</em>}</span>
                <span className="composer-command-desc">{command.description}</span>
                <span className={`composer-command-tag tag-${command.kind}`}>{KIND_TAG[command.kind]}</span>
              </li>
            ))}
          </ul>
        )}
        <textarea ref={input} id={`${uid}-input`} className="text-input" rows={3} value={text} disabled={busy}
          placeholder="Message this agent, or type / for commands"
          onChange={event => update(event.target.value)} onKeyDown={onKeyDown}
          role="combobox" aria-autocomplete="list" aria-expanded={menuOpen} aria-controls={menuOpen ? listId : undefined}
          aria-activedescendant={menuOpen && selected ? optionId(matches.indexOf(selected)) : undefined}
          aria-describedby={`${uid}-hint`} />
        {speech.listening && <div className="composer-listening" aria-live="polite"><span className="composer-rec" aria-hidden="true" />{speech.interim || 'Listening… say “send it” to send'}</div>}
      </div>
      {(error || speech.error) && <p className="composer-error" role="alert">{error ?? speech.error}</p>}
      {notice && (
        <div className="composer-notice" role="status">
          <span>{notice}</span>
          {onOpenCli && <button type="button" className="btn btn-small" onClick={onOpenCli}><Icon name="terminal" size={14} />Open in Claude Code</button>}
        </div>
      )}
      {running && <p className="composer-running" aria-live="polite">Asking the agent…</p>}
      {result && <CommandResultView command={result.command} result={result.result} busy={busy || running} onAction={command => void submit(command)} onClose={() => setResult(undefined)} />}
      {showHelp && (
        <div className="composer-help">
          <div className="composer-help-head"><strong>What you can type</strong><button type="button" className="icon-btn" onClick={() => setShowHelp(false)} aria-label="Close help"><Icon name="close" size={14} /></button></div>
          {HELP_GROUPS.map(group => {
            const items = commands.filter(command => group.kinds.includes(command.kind));
            return items.length > 0 && <div key={group.title}><strong>{group.title}</strong><ul>{items.map(command => <li key={command.name}><code>/{command.name}{command.args ? ` ${command.args}` : ''}</code>{command.description}</li>)}</ul></div>;
          })}
          <p><kbd>Enter</kbd> sends, <kbd>Shift</kbd>+<kbd>Enter</kbd> adds a line, <kbd>↑</kbd> recalls earlier messages. Start with <code>//</code> to send a message that begins with “/”.
            {speech.supported && <> With the microphone on, say “slash compact” for <code>/compact</code>, and end with “send it” to send.</>}</p>
        </div>
      )}
      <div className="composer-footer">
        <span id={`${uid}-hint`}>{hint}</span>
        <div className="composer-actions">
          {speech.supported && (
            <button type="button" className={`icon-btn composer-mic ${speech.listening ? 'composer-mic-on' : ''}`} onClick={speech.toggle} disabled={busy}
              aria-pressed={speech.listening} aria-label={speech.listening ? 'Stop voice input' : 'Start voice input'}
              title="Voice input uses your browser’s speech service (Chrome and Edge send the audio to Google or Microsoft).">
              <Icon name="mic" size={16} />
            </button>
          )}
          <button type="button" className="btn btn-small composer-slash" onClick={() => { update(text.startsWith('/') ? text : '/'); input.current?.focus(); }} aria-label="Show commands" disabled={busy}>/</button>
          <button className="btn btn-go" type="submit" disabled={busy || !text.trim()}><Icon name="send" size={15} />{busy ? 'Sending…' : 'Send'}</button>
        </div>
      </div>
    </form>
  );
}
