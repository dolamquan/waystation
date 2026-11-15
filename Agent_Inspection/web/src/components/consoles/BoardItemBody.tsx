import type { AgentEvent } from '../../api.ts';
import { AgentFeed } from './AgentFeed.tsx';
import type { BoardItem } from './boardItems.ts';
import { TerminalPane } from './TerminalPane.tsx';

/** What fills a tile under its header: a real terminal for a console, the live feed for an agent session. */
export function BoardItemBody({ item, lastEvent, notify, scale }: {
  readonly item: BoardItem;
  readonly lastEvent: AgentEvent | undefined;
  readonly notify: (text: string, kind?: 'ok' | 'error') => void;
  /** The canvas zoom, when the tile sits on the canvas; the terminal's text scales with it. An agent feed scales through CSS. */
  readonly scale?: number;
}) {
  if (item.console) return <TerminalPane consoleId={item.console.id} label={item.console.name} kind={item.console.kind} scale={scale} />;
  if (item.agent) return <AgentFeed agent={item.agent} lastEvent={lastEvent} notify={notify} />;
  return null;
}
