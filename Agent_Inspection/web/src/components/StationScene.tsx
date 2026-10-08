import { Fragment, useId, type CSSProperties } from 'react';
import type { Agent, PendingInterception } from '../api.ts';
import { characterFor, type WorldTheme } from '../crew.ts';
import { STATUS_LABEL, formatUsd } from '../format.ts';
import { CrewAvatar } from './CrewAvatar.tsx';
import { TeamTable, teamSeatPoint } from './TeamTable.tsx';
import { Backdrop, Floor } from './StationFloor.tsx';
import { StationApproval, type Notify } from './StationApproval.tsx';
import { breakerAlarm, costStep, deskBubble, pendingFor } from './stationEvents.ts';
import {
  SLOTS_PER_DECK, deckRows, rowOf, sceneBox, slotPosition, teamTablePosition, vacantSlots, type Placement,
} from '../stationLayout.ts';

interface StationSceneProps {
  /** Includes other offices, so parent labels can use the current session name. */
  readonly allAgents?: readonly Agent[];
  /** Solo agents, one desk each (used when no deck is given, e.g. the welcome screen). */
  readonly agents?: readonly Agent[];
  /** A packed deck: team tables and solo desks. Takes precedence over `agents`. */
  readonly deck?: readonly Placement[];
  readonly onOpenTeam?: (teamId: string) => void;
  /** Floor rows to draw; defaults to what the deck needs plus a spare row. */
  readonly rows?: number;
  /** On-screen pixels per scene unit. Omit to fit the container width. */
  readonly scale?: number;
  readonly theme: WorldTheme;
  readonly selectedId?: string;
  readonly paused?: boolean;
  readonly onSelect?: (id: string) => void;
  /** Subagents by parent id: drawn as small crew members beside their parent's desk. */
  readonly subagents?: ReadonlyMap<string, readonly Agent[]>;
  /** Held tool calls: a desk with one shows an Approve / Deny bubble. */
  readonly pending?: readonly PendingInterception[];
  readonly notify?: Notify;
  /** Sample crew: bubble buttons only explain themselves, never call the daemon. */
  readonly demo?: boolean;
}

const MAX_SUBAGENT_MINIS = 3;
const HELPER_X = 28;
const HELPER_Y = 12;

/** A parent's subagents stand in a little line to the right of its desk; extras are summed up as "+N". */
function SubagentCrew({ parent, helpers, index, selectedId, onSelect }: { parent: Agent; helpers: readonly Agent[]; index: number; selectedId?: string; onSelect?: (id: string) => void }) {
  const { x, y } = slotPosition(index);
  const shown = helpers.slice(0, MAX_SUBAGENT_MINIS);
  const extra = helpers.length - shown.length;
  return (
    <g className="subagent-crew" transform={`translate(${x + 62} ${y - 6})`} aria-label={`${helpers.length} ${helpers.length === 1 ? 'subagent' : 'subagents'} of ${parent.name}`} role="group">
      {shown.map((helper, i) => {
        const label = `Subagent of ${parent.name}: ${helper.name}, ${STATUS_LABEL[helper.status]}`;
        const activate = () => onSelect?.(helper.id);
        return (
          <g key={helper.id} transform={`translate(${i * HELPER_X} ${i * HELPER_Y})`} className={`subagent-mini station-${helper.status} ${helper.id === selectedId || parent.id === selectedId ? 'station-selected' : ''}`}
            role={onSelect ? 'button' : undefined} tabIndex={onSelect ? 0 : undefined} aria-label={onSelect ? label : undefined}
            onClick={activate} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); activate(); } }}
            style={{ '--crew-color': characterFor(helper.id).color } as CSSProperties}>
            <title>{`${label}\n${helper.currentActivity ?? 'No activity captured yet'}`}</title>
            <ellipse className="station-selection" cx="13" cy="34" rx="17" ry="7" fill="none" stroke="var(--crew-color)" strokeWidth="1.5" strokeDasharray="3 3" />
            <CrewAvatar id={helper.id} status={helper.status} size={32} animated={helper.status === 'busy'} />
          </g>
        );
      })}
      {extra > 0 && <g className="subagent-more" transform={`translate(${shown.length * HELPER_X + 4} ${shown.length * HELPER_Y + 18})`} role={onSelect ? 'button' : undefined} tabIndex={onSelect ? 0 : undefined} aria-label={`View all ${helpers.length} subagents of ${parent.name}`} onClick={() => onSelect?.(parent.id)} onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onSelect?.(parent.id); } }}><title>Open the parent to see every subagent</title><rect x="-5" y="-13" width="27" height="20" rx="6" fill="#f6f2ec" stroke={characterFor(parent.id).color} /><text fontSize="10" fontWeight="600" fill="#5d5470">+{extra}</text></g>}
    </g>
  );
}


/** Runaway guard stepped in: a flashing beacon on the monitor, amber for a warning, red once it constrains or stops. */
function BreakerBeacon({ breaker }: { breaker: NonNullable<Agent['breaker']> }) {
  return (
    <g className={`station-alarm station-alarm-${breaker.level === 'warned' ? 'warn' : 'stop'}`} transform="translate(22 -90)" role="img" aria-label={`Runaway guard: ${breaker.reason}`}>
      <title>{`Runaway guard (${breaker.level}): ${breaker.reason}`}</title>
      <circle className="station-alarm-glow" r="11" />
      <path d="M-5 3v-5a5 5 0 0 1 10 0v5Z" className="station-alarm-lamp" stroke="#48455d" strokeWidth="1.2" /><rect x="-7" y="3" width="14" height="3.5" rx="1" fill="#625976" />
    </g>
  );
}

/** Spend so far as a coin stack on the desk: one to four coins (<$0.10, <$1, <$5, $5+). */
function CostMeter({ costUsd }: { costUsd?: number }) {
  const step = costStep(costUsd);
  if (!step) return null;
  return (
    <g className={`station-cost station-cost-${step}`} transform="translate(30 -27)" role="img" aria-label={`Cost so far ${formatUsd(costUsd)}`}>
      <title>{`Cost so far: ${formatUsd(costUsd)}`}</title>
      {Array.from({ length: step }, (_, i) => <g key={i} transform={`translate(0 ${-i * 3.2})`}><path d="M-6 0v2.2a6 2.4 0 0 0 12 0V0" fill="#c9962f" stroke="#8a6420" strokeWidth=".8" /><ellipse rx="6" ry="2.4" fill="#f1c95a" stroke="#8a6420" strokeWidth=".8" /></g>)}
    </g>
  );
}

function Workstation({ agent, index, selected, helperCount = 0, parentName, held = false, onSelect }: { agent?: Agent; index: number; selected: boolean; helperCount?: number; parentName?: string; held?: boolean; onSelect?: (id: string) => void }) {
  const { x, y } = slotPosition(index);
  const character = agent ? characterFor(agent.id) : undefined;
  const alarm = agent && breakerAlarm(agent);
  const label = agent ? `${agent.name}, ${STATUS_LABEL[agent.status]}` : 'Unoccupied workstation';
  const activate = () => { if (agent) onSelect?.(agent.id); };
  return (
    <g transform={`translate(${x} ${y})`} className={`workstation ${agent ? `station-${agent.status}` : 'station-vacant'} ${selected ? 'station-selected' : ''}`}
      role={agent && onSelect ? 'button' : undefined} tabIndex={agent && onSelect ? 0 : undefined} aria-label={agent && onSelect ? label : undefined}
      onClick={activate} onKeyDown={(e) => { if (agent && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); activate(); } }}
      style={{ '--crew-color': character?.color ?? '#9f9bb9', '--crew-delay': `${index * -.7}s` } as CSSProperties}>
      <title>{agent ? `${label}\n${agent.currentActivity ?? 'No activity captured yet'}\n${agent.project}` : label}</title>
      <ellipse className="station-selection" cx="8" cy="33" rx="74" ry="30" fill="none" stroke="var(--crew-color)" strokeWidth="2" strokeDasharray="5 5" />
      <ellipse cx="-8" cy="20" rx="61" ry="18" fill="#252238" opacity=".18" />
      <path d="M-49-14v39l9 5V-9M37-24v37l9 5v-37" fill="#9d98ac" stroke="#655e7e" strokeWidth="2" />
      <path d="m-57-30 87-11 25 24-87 12Z" fill="var(--desk-top)" stroke="#7b718b" strokeWidth="2" strokeLinejoin="round" />
      <path d="m-57-30 25 25v9l-25-23ZM-32-5l87-12v9L-32 4Z" fill="var(--desk-edge)" stroke="#7b718b" strokeWidth="2" strokeLinejoin="round" />
      <path d="m-14-34 19-3 5 5-19 3Z" fill="#7d7499" />
      <path d="M-4-37v-11" stroke="#736887" strokeWidth="4" />
      <path d="m-30-77 57-7v37l-57 7Z" fill="#625976" stroke="#48455d" strokeWidth="3" strokeLinejoin="round" />
      <path d="m-25-72 47-6v27l-47 6Z" fill={agent?.status === 'stopped' || !agent ? '#4b5065' : '#283846'} />
      {agent && agent.status !== 'stopped' && <g className="monitor-code" stroke={character?.light} strokeWidth="2" strokeLinecap="round"><path d="m-18-64 9-1m5-1 15-2m-29 11 22-3m-22 10 10-1m5-1 10-1" /><path className="monitor-cursor" d="m-18-45 7-1" /></g>}
      <path d="m-17-23 34-4 11 9-34 4Z" fill="#bbb4ca" stroke="#8d819e" strokeWidth="1.5" />
      <path d="m-11-21 26-3m-20 6 26-3" stroke="#8a7e9f" strokeWidth="1.5" />
      <path d="M-42-27v-10q8-5 14-1v9q-8 5-14 2Z" fill="#e9bb85" stroke="#a1766c" strokeWidth="1.5" /><path d="M-28-34q8-2 6 3t-6 3" fill="none" stroke="#a1766c" strokeWidth="2" />
      {agent ? <g className={`station-bot station-bot-${agent.status}`} transform="translate(5 -36)"><CrewAvatar id={agent.id} status={agent.status} size={68} /><g className="station-footsteps" fill="var(--crew-color)" opacity=".45"><ellipse cx="18" cy="92" rx="4" ry="2" /><ellipse cx="34" cy="98" rx="4" ry="2" /></g></g> : <g opacity=".55"><ellipse cx="24" cy="13" rx="19" ry="8" fill="#9690aa" /><path d="M24 13v19M10 35l14-5 14 2" stroke="#756c8b" strokeWidth="3" /></g>}
      {agent && <g className="station-nameplate" transform="translate(-57 61)">
        <rect width="146" height={40 + (agent.parentId ? 14 : 0) + (helperCount ? 14 : 0)} rx="8" fill="#f6f2ec" stroke="#b9afcb" strokeWidth="1" />
        <circle cx="12" cy="13" r="3" fill={agent.status === 'waiting' ? '#c98f3e' : agent.status === 'busy' ? '#6da184' : '#aaa5b4'} />
        <text x="22" y="16" fill="#454056" fontSize="10" fontWeight="600">{agent.name.length > 19 ? `${agent.name.slice(0, 18)}…` : agent.name}</text>
        <text x="12" y="30" fill="#8b8299" fontSize="8">{STATUS_LABEL[agent.status]}</text>
        {agent.parentId && <text className="station-parent-label" x="12" y="44" fill="#705789" fontSize="7.5">Spawned by {(parentName ?? agent.subagent?.parentName ?? 'parent session').slice(0, 21)}</text>}
        {helperCount > 0 && <text className="station-subagent-badge" x="12" y={agent.parentId ? 58 : 44} fontSize="8" fontWeight="600" fill="#705789">↳ {helperCount} {helperCount === 1 ? 'subagent' : 'subagents'}</text>}
        <circle cx="131" cy="21" r="6" fill={character?.color} opacity=".6" />
      </g>}
      {agent && <CostMeter costUsd={agent.usage?.costUsd} />}
      {alarm && <BreakerBeacon breaker={alarm} />}
      {agent?.status === 'waiting' && !held && <g className="station-ask" transform="translate(15 -100)"><rect x="-45" y="-15" width="92" height="24" rx="7" fill="#ffe4b4" stroke="#b98d52" /><path d="m-5 9 5 6 5-6" fill="#ffe4b4" /><text textAnchor="middle" y="1" fill="#7a5634" fontSize="9" fontWeight="600">A little help?</text></g>}
      {agent && <g className="station-hover-card" transform="translate(-78 -134)"><rect width="190" height="40" rx="8" fill="#fbf8f1" stroke="#b5a5d3" /><text x="12" y="17" fill="#4d425f" fontSize="10" fontWeight="600">{agent.project.slice(0, 22)}</text><text x="12" y="31" fill="#7d708d" fontSize="9">Click to open this session’s controls</text></g>}
    </g>
  );
}

/** The floor is vector art; only the crew represents live daemon sessions. */
export function StationScene({ agents = [], allAgents = agents, deck, rows: rowsOverride, scale, theme, selectedId, paused = false, onSelect, onOpenTeam, subagents, pending = [], notify, demo = false }: StationSceneProps) {
  const uid = useId().replace(/:/g, '');
  const placements: readonly Placement[] = deck ?? agents.slice(0, SLOTS_PER_DECK).map((agent, slot) => ({ kind: 'agent', slot, agent }));
  const rows = rowsOverride ?? deckRows(placements);
  const box = sceneBox(rows);
  const positions = new Map<string, { agent: Agent; x: number; y: number }>();
  for (const placement of placements) {
    if (placement.kind === 'team') {
      const table = teamTablePosition(placement.slot);
      for (const seat of placement.seats) if (seat.agent) {
        const point = teamSeatPoint(seat);
        positions.set(seat.agent.id, { agent: seat.agent, x: table.x + point.x, y: table.y + point.y + 4 });
      }
    } else {
      const point = slotPosition(placement.slot);
      positions.set(placement.agent.id, { agent: placement.agent, x: point.x + 8, y: point.y + 33 });
      (subagents?.get(placement.agent.id) ?? []).slice(0, MAX_SUBAGENT_MINIS).forEach((helper, i) => {
        positions.set(helper.id, { agent: helper, x: point.x + 75 + i * HELPER_X, y: point.y + 28 + i * HELPER_Y });
      });
    }
  }
  // Draw far rows first so nearer rows overlap them, as in the isometric art.
  const items = [
    ...placements.map((p) => ({ slot: p.slot, placement: p as Placement | undefined })),
    ...vacantSlots(placements, rows).map((slot) => ({ slot, placement: undefined })),
  ].sort((a, b) => rowOf(a.slot) - rowOf(b.slot) || a.slot - b.slot);
  // With a scale, the office keeps a constant on-screen size (bigger offices scroll); without, it fits its container.
  const size = scale ? { width: `${Math.round(box.width * scale)}px`, height: `${Math.round(box.height * scale)}px` } : {};
  return (
    <svg
      viewBox={`${box.x} ${box.y} ${box.width} ${box.height}`}
      style={{ aspectRatio: `${box.width} / ${box.height}`, ...size }}
      className={`station-scene theme-${theme} ${scale ? 'station-scaled' : ''} ${paused ? 'motion-paused' : ''}`}
      role="group"
      aria-label={`Animated agent station, ${rows} rows of desks`}
    >
      <defs>
        <marker id={`${uid}-family-arrow`} viewBox="0 0 6 6" refX="5" refY="3" markerWidth="5" markerHeight="5" orient="auto"><path d="M0 0L6 3L0 6Z" fill="context-stroke" /></marker>
        <linearGradient id={`${uid}-sky`} x2="0" y2="1"><stop stopColor="var(--sky-top)" /><stop offset="1" stopColor="var(--sky-bottom)" /></linearGradient>
        <linearGradient id={`${uid}-window`} x2="0" y2="1"><stop stopColor="var(--window-top)" stopOpacity=".85" /><stop offset="1" stopColor="var(--window-bottom)" stopOpacity=".8" /></linearGradient>
        <linearGradient id={`${uid}-floor`} x1="0" y1="0" x2="1" y2="1"><stop stopColor="var(--floor-top)" /><stop offset="1" stopColor="var(--floor-bottom)" /></linearGradient>
        <radialGradient id={`${uid}-halo`}><stop stopColor="var(--world-glow)" stopOpacity=".35" /><stop offset="1" stopColor="var(--world-glow)" stopOpacity="0" /></radialGradient>
      </defs>
      <Backdrop theme={theme} box={box} uid={uid} />
      <Floor theme={theme} rows={rows} box={box} uid={uid} />
      <g className="station-family-links" aria-hidden="true">{[...positions.values()].map(child => {
        const parent = positions.get(child.agent.parentId ?? '');
        if (!parent) return null;
        const selected = child.agent.id === selectedId || parent.agent.id === selectedId;
        return <path key={child.agent.id} className={`station-family-link ${selected ? 'family-link-selected' : ''}`} d={`M${parent.x} ${parent.y}Q${(parent.x + child.x) / 2} ${(parent.y + child.y) / 2 + 25} ${child.x} ${child.y}`} stroke={characterFor(parent.agent.id).color} markerEnd={`url(#${uid}-family-arrow)`} />;
      })}</g>
      {items.map(({ slot, placement }) => {
        if (placement?.kind === 'team') {
          const { x, y } = teamTablePosition(slot);
          return <TeamTable key={`team-${placement.team.id}`} team={placement.team} seats={placement.seats} x={x} y={y} index={slot} selectedId={selectedId} onSelectAgent={onSelect} onOpenTeam={onOpenTeam} />;
        }
        const agent = placement?.agent;
        const helpers = agent ? subagents?.get(agent.id) : undefined;
        return (
          <Fragment key={agent?.id ?? `vacant-${slot}`}>
            <Workstation agent={agent} index={slot} held={!!agent && !!pendingFor(agent.id, pending)} helperCount={helpers?.length} parentName={agent?.parentId ? allAgents.find(parent => parent.id === agent.parentId)?.name ?? positions.get(agent.parentId)?.agent.name : undefined} selected={!!agent && (agent.id === selectedId || !!helpers?.some(helper => helper.id === selectedId))} onSelect={onSelect} />
            {agent && helpers && helpers.length > 0 && <SubagentCrew parent={agent} helpers={helpers} index={slot} selectedId={selectedId} onSelect={onSelect} />}
          </Fragment>
        );
      })}
      {/* Approval bubbles sit above every row so nearer desks never cover their buttons. */}
      <g className="station-approvals">{items.map(({ slot, placement }) => {
        if (placement?.kind !== 'agent') return null;
        const bubble = deskBubble(placement.agent, pending);
        if (!bubble || bubble.kind === 'ask') return null;
        const { x, y } = slotPosition(slot);
        return <StationApproval key={bubble.item.id} agent={placement.agent} item={bubble.item} question={bubble.kind === 'question'} x={x + 15} y={y - 85} demo={demo} notify={notify} onSelect={onSelect} />;
      })}</g>
    </svg>
  );
}
