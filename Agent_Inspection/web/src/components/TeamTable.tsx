import type { CSSProperties } from 'react';
import type { TeamView } from '../api.ts';
import { characterFor } from '../crew.ts';
import { STATUS_LABEL } from '../format.ts';
import { COL_AXIS, ROW_AXIS, type Seat } from '../stationLayout.ts';
import { CrewAvatar } from './CrewAvatar.tsx';

interface TeamTableProps {
  readonly team: TeamView;
  readonly seats: readonly Seat[];
  readonly x: number;
  readonly y: number;
  readonly index: number;
  readonly selectedId?: string;
  readonly onSelectAgent?: (id: string) => void;
  readonly onOpenTeam?: (teamId: string) => void;
}

/* Table geometry, in the station's isometric axes: L runs along a row of desks, D runs toward the viewer. */
const L = { x: COL_AXIS.x * 1.38, y: COL_AXIS.y * 1.38 };
const D = { x: ROW_AXIS.x * 0.24, y: ROW_AXIS.y * 0.24 };
// Pushed toward the viewer so back-row members stand where desk workers do, clear of the wall.
const TOP = { x: -(L.x + D.x) / 2, y: -(L.y + D.y) / 2 + 22 };
/** The nameplate sits where slot 0's desk nameplate would, so it clears the desks in the next row. */
const PLATE = { x: -COL_AXIS.x / 2 - 57, y: -COL_AXIS.y / 2 + 61, width: 160 };
const at = (along: number, across: number) => ({ x: TOP.x + L.x * along + D.x * across, y: TOP.y + L.y * along + D.y * across });
const pt = (p: { x: number; y: number }) => `${p.x.toFixed(1)} ${p.y.toFixed(1)}`;
const AVATAR = 58;
const STATUS_TEXT: Record<TeamView['status'], string> = {
  running: 'Working', paused: 'Paused', done: 'Ready to merge', stopped: 'Stopped', disbanded: 'Disbanded',
};
const STICKY: Record<'open' | 'in_progress' | 'blocked' | 'done', string> = {
  open: '#f3e3a4', in_progress: '#bfd7f2', blocked: '#f2c1b3', done: '#c4e2b9',
};
const MAX_STICKIES = 9;

/** Seats sit along the far edge (behind the table) or the near edge (in front), spread evenly. */
export function teamSeatPoint(seat: Seat) {
  const along = (seat.index + 1) / (seat.ofSide + 1);
  return seat.side === 'back' ? at(along, -0.35) : at(along, 1.25);
}

function SeatFigure({ seat, teamId, selected, onSelect }: { seat: Seat; teamId: string; selected: boolean; onSelect?: (id: string) => void }) {
  const { member, agent } = seat;
  const p = teamSeatPoint(seat);
  const id = agent?.id ?? `${teamId}:${member.name}`;
  const status = agent?.status ?? 'stopped';
  const character = characterFor(id);
  const vendor = member.vendor === 'claude' ? 'Claude' : 'Codex';
  const label = `${member.name} (${member.role}, ${vendor}${member.model ? ` ${member.model}` : ''}): ${agent ? STATUS_LABEL[status] : 'not started yet'}`;
  const interactive = !!agent && !!onSelect;
  const open = () => { if (agent) onSelect?.(agent.id); };
  return (
    <g
      className={`team-seat ${agent ? `seat-${status}` : 'seat-waiting-to-join'} ${selected ? 'seat-selected' : ''}`}
      transform={`translate(${pt(p)})`}
      role={interactive ? 'button' : undefined}
      tabIndex={interactive ? 0 : undefined}
      aria-label={interactive ? label : undefined}
      onClick={(e) => { e.stopPropagation(); open(); }}
      onKeyDown={(e) => { if (interactive && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); e.stopPropagation(); open(); } }}
      style={{ '--crew-color': character.color } as CSSProperties}
    >
      <title>{agent?.currentActivity ? `${label}\n${agent.currentActivity}` : label}</title>
      <ellipse className="seat-selection" cy="4" rx="30" ry="11" fill="none" stroke="var(--crew-color)" strokeWidth="2" strokeDasharray="4 4" />
      <ellipse cy="4" rx="21" ry="7" fill="#252238" opacity=".16" />
      <g transform={`translate(${-AVATAR / 2} ${-AVATAR * 1.12 + 6})`}>
        <CrewAvatar id={id} status={status} size={AVATAR} animated={!!agent} />
      </g>
      {member.role === 'lead' && (
        <g className="seat-lead" transform="translate(16 -62)" aria-hidden="true">
          <circle r="7.5" fill="#fff4d6" stroke="#c99a4a" strokeWidth="1.5" />
          <path d="m0-4 1.2 2.6 2.8.3-2.1 1.9.6 2.8L0 2.2-2.5 3.6l.6-2.8L-4-1.1l2.8-.3Z" fill="#d9a441" />
        </g>
      )}
      <g transform="translate(-16 -66)" aria-hidden="true">
        <rect x="-8" y="-6" width="16" height="12" rx="3" fill={member.vendor === 'claude' ? 'var(--claude)' : 'var(--codex)'} opacity=".92" />
        <text textAnchor="middle" y="3.2" fill="#fff" fontSize="7.5" fontWeight="700">{member.vendor === 'claude' ? 'C' : 'X'}</text>
      </g>
      {status === 'waiting' && (
        <g transform="translate(0 -84)" aria-hidden="true">
          <g className="seat-ask">
            <rect x="-34" y="-12" width="68" height="19" rx="6" fill="#ffe4b4" stroke="#b98d52" />
            <text textAnchor="middle" y="1" fill="#7a5634" fontSize="8" fontWeight="600">Needs you</text>
          </g>
        </g>
      )}
      <text className="seat-name" textAnchor="middle" y="-76" fontSize="8" fontWeight="600" fill="#5d5470">{member.name}</text>
    </g>
  );
}

/** Shared task board on a stand: one sticky note per task, coloured by status. */
function TaskBoard({ team }: { team: TeamView }) {
  const shown = team.tasks.slice(0, MAX_STICKIES);
  const done = team.tasks.filter((t) => t.status === 'done').length;
  return (
    <g className="team-board-stand" transform={`translate(${pt(at(1.04, 0.15))})`} aria-hidden="true">
      <path d="M8 6v40M40 2v40" stroke="#8a7f9c" strokeWidth="3" strokeLinecap="round" />
      <path d="m0-58 50-6v54L0-4Z" fill="#fbf9f4" stroke="#7d7392" strokeWidth="2" strokeLinejoin="round" />
      <path d="m0-58 50-6v7L0-51Z" fill="#d9cfe6" />
      <g transform="skewY(-7)">
        {shown.map((task, i) => {
          const col = i % 3;
          const row = Math.floor(i / 3);
          return <rect key={task.id} x={5 + col * 15} y={-46 + row * 13} width="11" height="10" rx="1" fill={STICKY[task.status]} stroke="#00000014" />;
        })}
        {team.tasks.length === 0 && <text x="25" y="-27" textAnchor="middle" fontSize="6.5" fill="#9a8fab">planning…</text>}
        <text x="25" y="-8" textAnchor="middle" fontSize="7" fontWeight="700" fill="#6e6383">{done}/{team.tasks.length}</text>
      </g>
    </g>
  );
}

/** A team's meeting pod: a tinted zone, a shared table with a laptop per seat, the task board, and its members. */
export function TeamTable({ team, seats, x, y, index, selectedId, onSelectAgent, onOpenTeam }: TeamTableProps) {
  const accent = characterFor(team.id);
  const back = seats.filter((s) => s.side === 'back');
  const front = seats.filter((s) => s.side === 'front');
  const corners = [at(0, 0), at(1, 0), at(1, 1), at(0, 1)];
  const zone = [at(-0.06, -0.5), at(1.22, -0.5), at(1.22, 1.62), at(-0.06, 1.62)];
  const done = team.tasks.filter((t) => t.status === 'done').length;
  const vendors = [...new Set(team.members.map((m) => (m.vendor === 'claude' ? 'Claude' : 'Codex')))].join(' + ');
  const open = () => onOpenTeam?.(team.id);
  const legs = [at(0.03, 0.15), at(0.97, 0.15), at(0.03, 0.9), at(0.97, 0.9)];
  const edge = (a: { x: number; y: number }, b: { x: number; y: number }) =>
    `M${pt(a)}L${pt(b)}L${pt({ x: b.x, y: b.y + 10 })}L${pt({ x: a.x, y: a.y + 10 })}Z`;
  return (
    <g
      className={`team-pod team-pod-${team.status}`}
      transform={`translate(${x} ${y})`}
      style={{ '--team-accent': accent.color, '--crew-delay': `${index * -1.3}s` } as CSSProperties}
    >
      <path className="team-zone" d={`M${zone.map(pt).join('L')}Z`} />
      {back.map((seat) => <SeatFigure key={seat.member.id} seat={seat} teamId={team.id} selected={!!seat.agent && seat.agent.id === selectedId} onSelect={onSelectAgent} />)}
      <g aria-hidden="true">
        {legs.map((leg, i) => <path key={i} d={`M${pt(leg)}v26`} stroke="#655e7e" strokeWidth="5" strokeLinecap="round" />)}
        <path d={edge(corners[3], corners[2])} fill="var(--desk-edge)" stroke="#7b718b" strokeWidth="2" strokeLinejoin="round" />
        <path d={edge(corners[0], corners[3])} fill="var(--desk-edge)" stroke="#7b718b" strokeWidth="2" strokeLinejoin="round" />
        <path d={`M${corners.map(pt).join('L')}Z`} fill="var(--desk-top)" stroke="#7b718b" strokeWidth="2" strokeLinejoin="round" />
        <path d={`M${pt(at(0.06, 0.5))}L${pt(at(0.94, 0.5))}`} stroke="var(--team-accent)" strokeWidth="3" strokeLinecap="round" opacity=".5" />
        {seats.map((seat) => {
          const along = (seat.index + 1) / (seat.ofSide + 1);
          const p = at(along, seat.side === 'back' ? 0.18 : 0.62);
          const lit = !!seat.agent && seat.agent.status !== 'stopped';
          return (
            <g key={`laptop-${seat.member.id}`} transform={`translate(${pt(p)})`}>
              <path d="m-11 3 17-2 6 5-17 2Z" fill="#bbb4ca" stroke="#8d819e" strokeWidth="1" />
              {seat.side === 'back' && <path d="m-11 3 17-2v-12l-17 2Z" fill={lit ? '#2f4150' : '#55596c'} stroke="#48455d" strokeWidth="1.2" />}
              {seat.side === 'back' && lit && <path className="monitor-code" d="m-8-2 6-1m2 0 5-.6m-13 4 9-1" stroke={characterFor(seat.agent!.id).light} strokeWidth="1.3" strokeLinecap="round" />}
            </g>
          );
        })}
        <g transform={`translate(${pt(at(0.5, 0.42))})`}><path d="M-6-2q6-4 12 0v4q-6 4-12 0Z" fill="#e9bb85" stroke="#a1766c" strokeWidth="1.2" /></g>
      </g>
      <TaskBoard team={team} />
      {front.map((seat) => <SeatFigure key={seat.member.id} seat={seat} teamId={team.id} selected={!!seat.agent && seat.agent.id === selectedId} onSelect={onSelectAgent} />)}
      <g
        className="team-plate"
        transform={`translate(${PLATE.x} ${PLATE.y})`}
        role={onOpenTeam ? 'button' : undefined}
        tabIndex={onOpenTeam ? 0 : undefined}
        aria-label={onOpenTeam ? `Open team ${team.name}: ${STATUS_TEXT[team.status]}, ${done} of ${team.tasks.length} tasks done` : undefined}
        onClick={open}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); } }}
      >
        <title>{`${team.name}\n${team.goal}\nClick to open the team`}</title>
        <rect width={PLATE.width} height="42" rx="9" fill="#f6f2ec" stroke="var(--team-accent)" strokeWidth="1.5" />
        <rect x="8" y="9" width="6" height="24" rx="3" fill="var(--team-accent)" />
        <text x="21" y="17" fill="#454056" fontSize="10.5" fontWeight="700">{team.name.length > 19 ? `${team.name.slice(0, 18)}…` : team.name}</text>
        <text x="21" y="31" fill="#8b8299" fontSize="8">{STATUS_TEXT[team.status]} · {done}/{team.tasks.length} tasks · {vendors}</text>
        <circle className={`team-plate-dot plate-${team.status}`} cx={PLATE.width - 12} cy="13" r="4" />
      </g>
    </g>
  );
}
