import { Icon } from '../Icon.tsx';
import { EditableName } from './EditableName.tsx';
import { folderName, itemCwd, itemName, canOpenAsTerminal, type BoardItem } from './boardItems.ts';
import { statusLabel, type Status } from './consoleStatus.ts';

const ORIGIN_BADGE = { managed: 'Waystation agent', observed: 'Observed' } as const;

/** The title strip of a tile; shared by the tiles, focus and canvas layouts so they never drift apart. */
export function ConsoleHeader({ item, status, focused, onFocus, onClose, onDetails, onOpenAsTerminal, onRename }: {
  readonly item: BoardItem;
  readonly status: Status;
  readonly focused: boolean;
  readonly onFocus: () => void;
  readonly onClose: () => void;
  /** Open the agent drawer; only agent items have one. */
  readonly onDetails: (agentId: string) => void;
  readonly onOpenAsTerminal: (agentId: string) => void;
  /** Renames the console or agent; without it the name is plain text. */
  readonly onRename?: (item: BoardItem, name: string) => void | Promise<void>;
}) {
  const name = itemName(item);
  const cwd = itemCwd(item);
  const info = item.console;
  const agent = item.agent;
  const badge = item.origin === 'console' ? undefined : ORIGIN_BADGE[item.origin];
  const statusText = info && status === 'exited' ? `exited (${info.exitCode ?? 0})` : agent && status === 'exited' ? agent.status : statusLabel(status);
  return <header className="console-head">
    <span className={`console-dot console-dot-${status}`} title={statusLabel(status)} aria-label={statusLabel(status)} />
    {onRename ? <EditableName value={name} label={name} className="console-name" onRename={(next) => onRename(item, next)} /> : <strong className="console-name">{name}</strong>}
    {badge && <span className={`console-badge console-badge-${item.origin}`}>{badge}</span>}
    <span className="console-meta" title={cwd}>{folderName(cwd)}</span>
    <span className="console-status">{statusText}</span>
    {agent && <button className="console-action" onClick={() => onDetails(agent.id)} title="Open the details drawer">Details</button>}
    {agent && canOpenAsTerminal(item) && <button className="console-action" onClick={() => onOpenAsTerminal(agent.id)} title="Continue this session in a real terminal">Open as terminal</button>}
    <button className="icon-btn" onClick={onFocus} aria-label={focused ? 'Show all sessions' : `Focus ${name}`} title={focused ? 'Back to tiles' : 'Focus'}>
      <Icon name={focused ? 'collapse' : 'expand'} size={15} />
    </button>
    {info && <button className="icon-btn" onClick={onClose} aria-label={`Close ${name}`} title="Close console"><Icon name="close" size={15} /></button>}
  </header>;
}
