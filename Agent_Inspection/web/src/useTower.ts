import { useEffect, useState } from 'react';
import {
  WS_PROTOCOL, token, type Agent, type AgentEvent, type PendingInterception, type TeamLogEntry, type TeamView,
} from './api.ts';

export interface TeamLogItem {
  readonly seq: number;
  readonly entry: TeamLogEntry;
}

const TEAM_LOG_FEED_MAX = 200;
let teamLogSeq = 0;

export interface TowerState {
  readonly connected: boolean;
  readonly agents: Agent[];
  readonly pending: PendingInterception[];
  readonly hooksInstalled: boolean;
  readonly lastEvent?: AgentEvent;
  readonly teams: TeamView[];
  /** Recent team log entries, numbered so bursts arriving between renders are never dropped. */
  readonly teamLogFeed: readonly TeamLogItem[];
  readonly authError: boolean;
}

type Message =
  | { type: 'snapshot'; agents: Agent[]; pending: PendingInterception[]; hooks: { installed: boolean }; teams?: TeamView[] }
  | { type: 'agents'; agents: Agent[]; hooks: { installed: boolean } }
  | { type: 'pending'; pending: PendingInterception[] }
  | { type: 'event'; event: AgentEvent }
  | { type: 'teams'; teams: TeamView[] }
  | { type: 'team_log'; entry: TeamLogEntry };

const RECONNECT_MS = 1500;
const INITIAL: TowerState = { connected: false, agents: [], pending: [], hooksInstalled: false, authError: false, teams: [], teamLogFeed: [] };

function reduce(state: TowerState, msg: Message): TowerState {
  switch (msg.type) {
    case 'snapshot':
      return { ...state, agents: msg.agents, pending: msg.pending, hooksInstalled: msg.hooks.installed, teams: msg.teams ?? [] };
    case 'agents':
      return { ...state, agents: msg.agents, hooksInstalled: msg.hooks.installed };
    case 'pending':
      return { ...state, pending: msg.pending };
    case 'event':
      return { ...state, lastEvent: msg.event };
    case 'teams':
      return { ...state, teams: msg.teams };
    case 'team_log':
      return { ...state, teamLogFeed: [...state.teamLogFeed, { seq: ++teamLogSeq, entry: msg.entry }].slice(-TEAM_LOG_FEED_MAX) };
    default:
      return state;
  }
}

/** Live connection to the daemon. Reconnects automatically. */
export function useTower(enabled: boolean): TowerState {
  const [state, setState] = useState<TowerState>(INITIAL);

  useEffect(() => {
    if (!enabled) return undefined;
    if (!token()) {
      setState({ ...INITIAL, authError: true });
      return undefined;
    }
    let closed = false;
    let socket: WebSocket | undefined;
    let retry: ReturnType<typeof setTimeout> | undefined;

    const connect = () => {
      const scheme = location.protocol === 'https:' ? 'wss' : 'ws';
      const ws = new WebSocket(`${scheme}://${location.host}/ws`, [WS_PROTOCOL, token()]);
      socket = ws;
      ws.onopen = () => setState((s) => ({ ...s, connected: true, authError: false }));
      ws.onclose = () => {
        if (closed) return;
        setState((s) => ({ ...s, connected: false }));
        retry = setTimeout(connect, RECONNECT_MS);
      };
      ws.onmessage = (raw) => {
        try {
          const msg = JSON.parse(String(raw.data)) as Message;
          setState((s) => reduce(s, msg));
        } catch {
          // ignore malformed frames
        }
      };
    };
    connect();
    return () => {
      closed = true;
      if (retry) clearTimeout(retry);
      if (socket) {
        socket.onopen = null;
        socket.onclose = null;
        socket.onmessage = null;
        socket.close();
      }
      setState(INITIAL);
    };
  }, [enabled]);

  return state;
}
