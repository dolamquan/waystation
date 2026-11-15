import { motion } from 'framer-motion';
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { matchCommands, SHORTCUTS, type PaletteEntry } from '../triage.ts';
import { Icon } from './Icon.tsx';

export interface PaletteCommand extends PaletteEntry {
  readonly run: () => void;
}

interface CommandPaletteProps {
  readonly commands: readonly PaletteCommand[];
  readonly onClose: () => void;
}

/** Ctrl+K: jump to any agent, team, view or action by typing a few letters. */
export function CommandPalette({ commands, onClose }: CommandPaletteProps) {
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const list = useRef<HTMLUListElement>(null);
  const [previousFocus] = useState(() => document.activeElement as HTMLElement | null);
  const results = useMemo(() => matchCommands(commands, query), [commands, query]);
  const current = results[Math.min(active, results.length - 1)];

  useEffect(() => { setActive(0); }, [query]);
  useEffect(() => {
    list.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [active]);
  // Hand focus back unless the chosen command moved it somewhere on purpose.
  useEffect(() => () => {
    if (previousFocus?.isConnected && (document.activeElement === document.body || !document.activeElement)) previousFocus.focus();
  }, [previousFocus]);

  const choose = (command: PaletteCommand | undefined) => {
    if (!command) return;
    onClose();
    command.run();
  };

  const onKeyDown = (event: KeyboardEvent) => {
    const move = (delta: number) => { event.preventDefault(); setActive((index) => (results.length ? (index + delta + results.length) % results.length : 0)); };
    if (event.key === 'ArrowDown') move(1);
    else if (event.key === 'ArrowUp') move(-1);
    else if (event.key === 'Enter') { event.preventDefault(); choose(current); }
    else if (event.key === 'Escape') { event.preventDefault(); onClose(); }
    else if (event.key === 'Tab') event.preventDefault();
  };

  let lastGroup = '';
  return (
    <motion.div className="modal-backdrop workbench-content palette-backdrop" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.12 }} onClick={onClose}>
      <motion.div
        className="palette"
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
        initial={{ opacity: 0, y: -8 }}
        animate={{ opacity: 1, y: 0 }}
        exit={{ opacity: 0, y: -4 }}
        transition={{ duration: 0.14 }}
        onClick={(event) => event.stopPropagation()}
        onKeyDown={onKeyDown}
      >
        <label className="palette-search">
          <Icon name="search" size={16} />
          <input
            autoFocus
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Jump to an agent, team or action…"
            aria-label="Search commands"
            role="combobox"
            aria-expanded="true"
            aria-controls="palette-results"
            aria-activedescendant={current ? `palette-${current.id}` : undefined}
          />
          <kbd>Esc</kbd>
        </label>
        <ul className="palette-results" id="palette-results" role="listbox" ref={list} aria-label="Commands">
          {results.length === 0 && <li className="palette-empty">Nothing matches “{query.trim()}”.</li>}
          {results.map((command, index) => {
            const heading = command.group !== lastGroup ? command.group : undefined;
            lastGroup = command.group;
            return [
              heading && <li key={`group-${heading}`} className="palette-group" role="presentation">{heading}</li>,
              <li
                key={command.id}
                id={`palette-${command.id}`}
                role="option"
                aria-selected={command === current}
                className={command === current ? 'palette-item palette-item-on' : 'palette-item'}
                onMouseMove={() => setActive(index)}
                onClick={() => choose(command)}
              >
                <span className="palette-label">{command.label}</span>
                {command.hint && <span className="palette-hint">{command.hint}</span>}
              </li>,
            ];
          })}
        </ul>
        <footer className="palette-foot" aria-label="Keyboard shortcuts">
          {SHORTCUTS.slice(0, 5).map(([keys, action]) => <span key={keys}><kbd>{keys}</kbd>{action}</span>)}
        </footer>
      </motion.div>
    </motion.div>
  );
}
