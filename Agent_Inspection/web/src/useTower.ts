import { useEffect, useState } from 'react';
import { uniqueAgents } from '../../daemon/domain/agentIdentity.ts';
import {
  isRemote, socketProtocols, token, type Agent, type AgentEvent, type FileContention, type PendingInterception, type TeamLogEntry, type TeamView,
} from './api.ts';
import { EMPTY_TURN_WATCH, watchAgents, watchEvent, type TurnWatch } from './readyToLook.ts';
import type { CanvasReveal } from '../../shared/canvasReveal.ts';

export interface TeamLogItem {
  readonly seq: number;
  readonly entry: TeamLogEntry;
}

const TEAM_LOG_FEED_MAX = 200;
let teamLogSeq = 0;

export interface TowerState {
  readonly canvasReveal?: CanvasReveal;
  readonly connected: boolean;
  readonly snapshotReady: boolean;
  readonly agents: Agent[];
  readonly pending: PendingInterception[];
  readonly hooksInstalled: boolean;
  readonly lastEvent?: AgentEvent;
  readonly teams: TeamView[];
  /** Recent team log entries, numbered so bursts arriving between renders are never dropped. */
  readonly teamLogFeed: readonly TeamLogItem[];
  readonly authError: boolean;
  /** Agents that just finished a turn that changed files ("Ready to look"). */
  readonly turns: TurnWatch;
  /** Files that agents in one checkout both wrote in the last few minutes. */
  readonly contention: readonly FileContention[];
}

type Message =
  | { type: 'canvas_reveal'; reveal: CanvasReveal }
  | { type: 'snapshot'; agents: Agent[]; pending: PendingInterception[]; hooks: { installed: boolean }; teams?: TeamView[]; contention?: FileContention[] }
  | { type: 'contention'; contention: FileContention[] }
  | { type: 'agents'; agents: Agent[]; hooks: { installed: boolean } }
  | { type: 'pending'; pending: PendingInterception[] }
  | { type: 'event'; event: AgentEvent }
  | { type: 'teams'; teams: TeamView[] }
  | { type: 'team_log'; entry: TeamLogEntry };

const RECONNECT_MS = 1500;
const INITIAL: TowerState = { connected: false, snapshotReady: false, agents: [], pending: [], hooksInstalled: false, authError: false, teams: [], teamLogFeed: [], turns: EMPTY_TURN_WATCH, contention: [] };

function withAgents(state: TowerState, incoming: Agent[]): Pick<TowerState, 'agents' | 'turns'> {
  const agents = uniqueAgents(incoming);
  return { agents, turns: watchAgents(state.turns, state.agents, agents, Date.now()) };
}

function reduce(state: TowerState, msg: Message): TowerState {
  switch (msg.type) {
    case 'canvas_reveal': return { ...state, canvasReveal: msg.reveal };
    case 'snapshot':
      return { ...state, snapshotReady: true, ...withAgents(state, msg.agents), pending: msg.pending, hooksInstalled: msg.hooks.installed, teams: msg.teams ?? [], contention: msg.contention ?? [] };
    case 'agents':
      return { ...state, snapshotReady: true, ...withAgents(state, msg.agents), hooksInstalled: msg.hooks.installed };
    case 'pending':
      return { ...state, pending: msg.pending };
    case 'event':
      return { ...state, lastEvent: msg.event, turns: watchEvent(state.turns, msg.event) };
    case 'teams':
      return { ...state, teams: msg.teams };
    case 'contention':
      return { ...state, contention: msg.contention };
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
    if (!token() && !isRemote()) {
      setState({ ...INITIAL, authError: true });
      return undefined;
    }
    let closed = false;
    let socket: WebSocket | undefined;
    let retry: ReturnType<typeof setTimeout> | undefined;

    const connect = () => {
      const scheme = location.protocol === 'https:' ? 'wss' : 'ws';
      const ws = new WebSocket(`${scheme}://${location.host}/ws`, socketProtocols());
      socket = ws;
      ws.onopen = () => setState((s) => ({ ...s, connected: true, snapshotReady: false, authError: false }));
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
