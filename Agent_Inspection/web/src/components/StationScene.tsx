import { useId, type CSSProperties } from 'react';
import type { Agent } from '../api.ts';
import { characterFor, type WorldTheme } from '../crew.ts';
import { STATUS_LABEL } from '../format.ts';
import { CrewAvatar } from './CrewAvatar.tsx';

interface StationSceneProps {
  readonly agents: readonly Agent[];
  readonly theme: WorldTheme;
  readonly selectedId?: string;
  readonly paused?: boolean;
  readonly onSelect?: (id: string) => void;
}

function Plant({ x, y, scale = 1 }: { x: number; y: number; scale?: number }) {
  return <g transform={`translate(${x} ${y}) scale(${scale})`}><ellipse cy="8" rx="18" ry="5" fill="#202d43" opacity=".16" /><path d="M-11-9h22L8 8H-8Z" fill="#b29a8c" stroke="#715d62" strokeWidth="2" /><ellipse cy="-9" rx="11" ry="4" fill="#dac4a2" stroke="#715d62" strokeWidth="2" /><path d="M0-8v-37" stroke="#587857" strokeWidth="3" /><path d="M0-18q-25 0-22-19Q-2-34 0-18M0-25q21 0 22-21Q2-45 0-25M0-35q-14-3-8-20Q9-48 0-35" fill="#86b887" stroke="#547857" strokeWidth="2" /></g>;
}

function Workstation({ agent, index, selected, onSelect }: { agent?: Agent; index: number; selected: boolean; onSelect?: (id: string) => void }) {
  const col = index % 4;
  const row = Math.floor(index / 4);
  const x = 220 + col * 188 + row * 130;
  const y = 274 - col * 23 + row * 160;
  const character = agent ? characterFor(agent.id) : undefined;
  const label = agent ? `${character!.name}: ${agent.name}, ${STATUS_LABEL[agent.status]}` : 'Unoccupied workstation';
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
      {agent && <g className="station-nameplate" transform="translate(-57 61)"><rect width="146" height="40" rx="8" fill="#f6f2ec" stroke="#b9afcb" strokeWidth="1" /><circle cx="12" cy="13" r="3" fill={agent.status === 'waiting' ? '#c98f3e' : agent.status === 'busy' ? '#6da184' : '#aaa5b4'} /><text x="22" y="16" fill="#454056" fontSize="10" fontWeight="600">{agent.name.length > 19 ? `${agent.name.slice(0, 18)}…` : agent.name}</text><text x="12" y="30" fill="#8b8299" fontSize="8">{character?.name} · {STATUS_LABEL[agent.status]}</text><circle cx="131" cy="21" r="6" fill={character?.color} opacity=".6" /></g>}
      {agent?.status === 'waiting' && <g className="station-ask" transform="translate(15 -100)"><rect x="-45" y="-15" width="92" height="24" rx="7" fill="#ffe4b4" stroke="#b98d52" /><path d="m-5 9 5 6 5-6" fill="#ffe4b4" /><text textAnchor="middle" y="1" fill="#7a5634" fontSize="9" fontWeight="600">A little help?</text></g>}
      {agent && <g className="station-hover-card" transform="translate(-78 -134)"><rect width="190" height="40" rx="8" fill="#fbf8f1" stroke="#b5a5d3" /><text x="12" y="17" fill="#4d425f" fontSize="10" fontWeight="600">{character?.name} · {agent.project.slice(0, 22)}</text><text x="12" y="31" fill="#7d708d" fontSize="9">Click to open this agent’s controls</text></g>}
    </g>
  );
}

/** The floor is vector art; only the crew represents live daemon sessions. */
export function StationScene({ agents, theme, selectedId, paused = false, onSelect }: StationSceneProps) {
  const uid = useId().replace(/:/g, '');
  return (
    <svg viewBox="0 0 1100 630" className={`station-scene theme-${theme} ${paused ? 'motion-paused' : ''}`} role="group" aria-label="Animated agent station">
      <defs>
        <linearGradient id={`${uid}-sky`} x2="0" y2="1"><stop stopColor="var(--sky-top)" /><stop offset="1" stopColor="var(--sky-bottom)" /></linearGradient>
        <linearGradient id={`${uid}-window`} x2="0" y2="1"><stop stopColor="var(--window-top)" stopOpacity=".85" /><stop offset="1" stopColor="var(--window-bottom)" stopOpacity=".8" /></linearGradient>
        <linearGradient id={`${uid}-floor`} x1="0" y1="0" x2="1" y2="1"><stop stopColor="var(--floor-top)" /><stop offset="1" stopColor="var(--floor-bottom)" /></linearGradient>
        <radialGradient id={`${uid}-halo`}><stop stopColor="var(--world-glow)" stopOpacity=".35" /><stop offset="1" stopColor="var(--world-glow)" stopOpacity="0" /></radialGradient>
      </defs>
      <g aria-hidden="true">
        <rect width="1100" height="630" fill={`url(#${uid}-sky)`} />
        <ellipse cx="590" cy="285" rx="560" ry="290" fill={`url(#${uid}-halo)`} />
        {Array.from({ length: 52 }, (_, i) => <circle key={i} className="world-star" cx={(i * 137 + 41) % 1100} cy={(i * i * 31 + 17) % 280} r={i % 6 === 0 ? 1.7 : .8} fill="var(--star-color)" opacity={.25 + i % 4 * .14} style={{ animationDelay: `${i % 8}s` }} />)}
        {theme === 'moonbase' && <g><circle cx="920" cy="99" r="50" fill="#b4a9d8" opacity=".85" /><circle cx="933" cy="87" r="46" fill="#595070" /><circle cx="959" cy="77" r="7" fill="#827392" opacity=".45" /><ellipse cx="191" cy="114" rx="56" ry="14" fill="none" stroke="#8f819e" strokeWidth="4" transform="rotate(-18 191 114)" /><circle cx="191" cy="114" r="30" fill="#a997b1" /><path d="M0 384q97-64 188-38t182-23q180-48 287 16t214-40q106-46 229 7v324H0Z" fill="#69617e" opacity=".26" /><path d="M0 480q93-42 200-19t141-18q179-54 337 28t248-45q78-56 174-22v226H0Z" fill="#3b354e" opacity=".55" /><ellipse cx="58" cy="512" rx="38" ry="9" fill="#7d718d" opacity=".2" /><ellipse cx="1016" cy="536" rx="48" ry="11" fill="#7d718d" opacity=".25" /></g>}
        {theme === 'greenhouse' && <g><circle cx="894" cy="95" r="46" fill="#f6d590" opacity=".8" /><path d="M0 280Q66 88 140 170T292 174 457 176 650 152 883 141 1100 199v431H0Z" fill="#6a8779" opacity=".52" /><path d="M0 345q140-168 240-35t240-34q100-103 233 43t225-18q79-92 162-4v333H0Z" fill="#4d7266" opacity=".55" /><path d="M82 304V127m-37 66q-23-40 37-40t40-51m851 223V106m-38 59q-15-43 38-43t45-35" fill="none" stroke="#425f52" strokeWidth="13" strokeLinecap="round" /><g fill="#9ebd7d" opacity=".7"><ellipse cx="70" cy="128" rx="90" ry="37" /><ellipse cx="983" cy="102" rx="101" ry="41" /></g><path className="world-cloud" d="M364 73q-2-19 23-18 5-25 34-13 17-12 32 9 32-1 30 22Z" fill="#fff2cf" opacity=".22" /></g>}
        {theme === 'deepsea' && <g><path d="M420-20 210 450h65L566-20M710-20 590 400h38L819-20" fill="#86dddb" opacity=".045" /><path className="world-fish" d="M800 97q59-33 132 0l31-23-9 27 9 24-31-21q-72 34-132-7Z" fill="#72b3b8" opacity=".25" /><path d="M0 467q76-45 178-11t191-25q129-64 271-6t231-23q130-91 229 38v190H0Z" fill="#236469" opacity=".4" />{Array.from({ length: 13 }, (_, i) => <circle key={i} className="world-bubble" cx={40 + i * 86} cy={450 - i % 4 * 90} r={3 + i % 3 * 3} fill="none" stroke="#87d0c9" opacity=".3" style={{ animationDelay: `${i * -1.4}s` }} />)}<path className="world-kelp" d="M60 503q48-60 4-118t8-76m957 210q-50-62-12-100t-9-93" fill="none" stroke="#549e89" strokeWidth="14" strokeLinecap="round" /></g>}
        <ellipse cx="552" cy="498" rx="426" ry="96" fill="#151a2c" opacity=".26" />
        {/* Rear wall, panoramic windows, and the station's solid foundation. */}
        <path d="m122 256 616-81 246 223-616 86Z" fill="var(--floor-edge)" stroke="#67607b" strokeWidth="3" strokeLinejoin="round" />
        <path d="m122 256 246 228v22L122 278ZM368 484l616-86v22l-616 86Z" fill="var(--floor-edge)" stroke="#67607b" strokeWidth="3" strokeLinejoin="round" />
        <path d="m93 210 630-84v49l-630 84Z" fill="var(--wall-color)" stroke="#6e6684" strokeWidth="3" strokeLinejoin="round" />
        <path d="m93 210 630-84 11 10-630 84Z" fill="#d4ccdf" stroke="#8d83a0" strokeWidth="2" />
        {[0, 1, 2, 3].map(i => <g key={i} transform={`translate(${127 + i * 149} ${206 - i * 20})`}><path d="m0 0 125-17v34L0 34Z" fill={`url(#${uid}-window)`} stroke="#78708a" strokeWidth="2" /><path d="m15 5 23-3-13 26-22 3Z" fill="#f3e9ff" opacity=".1" /><path d="m63-8v33" stroke="#8b8398" strokeWidth="2" /></g>)}
        <path d="m104 260 626-83 235 215-598 82Z" fill={`url(#${uid}-floor)`} stroke="#aaa1b9" strokeWidth="2" />
        {[0, 1, 2, 3, 4].map(i => <path key={i} d={`m${135 + i * 121} ${256 - i * 16} 227 209`} fill="none" stroke="var(--floor-line)" strokeWidth="1" />)}
        {[0, 1, 2, 3].map(i => <path key={i} d={`m${154 + i * 56} ${307 + i * 51} 604-81`} fill="none" stroke="var(--floor-line)" strokeWidth="1" />)}
        <path d="m316 296 358-47 33 31-358 47Z" fill="var(--walkway-color)" opacity=".58" />
        <path d="m348 326 207-28" stroke="#f5e8ca" strokeWidth="2" strokeDasharray="7 14" opacity=".42" />
        {/* Lounge, station clock, a little terrarium, and exterior antenna. */}
        <g transform="translate(870 264)"><path d="m-15-26 47-6 28 29-47 6Z" fill="#a89aaa" stroke="#6f627e" strokeWidth="2" /><path d="m13 3 47-6v23l-47 6Z" fill="#82758e" stroke="#6f627e" strokeWidth="2" /><path d="m-15-26 28 29v23l-28-29Z" fill="#91829d" stroke="#6f627e" strokeWidth="2" /><path d="M-4-31 34-36l10 12-38 5Z" fill="#cab2b8" stroke="#817185" strokeWidth="2" /><path d="m19-3 23-3" stroke="#dac4bf" strokeWidth="4" /></g>
        <Plant x={141} y={273} scale={.85} /><Plant x={750} y={209} scale={1.1} /><Plant x={951} y={430} scale={.9} />
        {theme === 'greenhouse' && <g><Plant x={323} y={444} scale={1.3} /><Plant x={765} y={455} scale={1.15} /><Plant x={542} y={258} scale={.75} /></g>}
        <g transform="translate(809 440)"><path d="m0 0 67-9 22 22-67 9Z" fill="#b5a6be" stroke="#83748e" strokeWidth="2" /><path d="m22 22 67-9v19l-67 9Z" fill="#887993" stroke="#83748e" strokeWidth="2" /><path d="m11-22 45-6 19 22-45 6Z" fill="#7ca79b" opacity=".65" stroke="#96c2ba" strokeWidth="2" /><path d="M11-22v22M56-28v20M75-6v10" stroke="#9ccec1" strokeWidth="2" /><path d="m31-3 4-20 9 16 10-12 2 12" fill="none" stroke="#b8d5a2" strokeWidth="4" /></g>
        <g transform="translate(75 389)"><ellipse cy="30" rx="36" ry="10" fill="#28243b" opacity=".25" /><path d="M0-44v64m-18 12 18-12 18 7" fill="none" stroke="#a098b1" strokeWidth="5" strokeLinecap="round" /><path d="M-18-72q31-2 49 24-31 15-54-7Z" fill="#beb3cb" stroke="#746b89" strokeWidth="3" /><path d="m-10-60 26 17 5-37" fill="none" stroke="#8d7b9f" strokeWidth="3" /><circle className="antenna-light" cx="21" cy="-80" r="4" fill="#eeb8a2" /></g>
        <path d="m356 510 100-14 51 47-100 14Z" fill="#9187a0" stroke="#6d627f" strokeWidth="2" /><path d="m371 525 100-13m-84 28 100-13" stroke="#c3b8d0" strokeWidth="3" />
        <text x="422" y="425" transform="rotate(-7 422 425)" fill="var(--floor-label)" fontSize="12" fontFamily="var(--mono)" letterSpacing="5" opacity=".55">WAYSTATION / 01</text>
      </g>
      {Array.from({ length: 8 }, (_, i) => <Workstation key={agents[i]?.id ?? `vacant-${i}`} agent={agents[i]} index={i} selected={!!agents[i] && agents[i]?.id === selectedId} onSelect={onSelect} />)}
      <g aria-hidden="true"><text x="42" y="590" fill="var(--scene-caption)" fontSize="9" fontFamily="var(--mono)" letterSpacing="2">A SMALL STATION. A BIG MISSION.</text><path d="M910 584h108m-8-6 8 6-8 6" fill="none" stroke="var(--scene-caption)" strokeWidth="1" opacity=".5" /></g>
    </svg>
  );
}
