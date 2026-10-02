import type { CSSProperties } from 'react';
import type { Agent } from '../api.ts';
import { characterFor, type CrewCharacter } from '../crew.ts';

interface CrewAvatarProps {
  readonly id?: string;
  readonly character?: CrewCharacter;
  readonly status?: Agent['status'];
  readonly size?: number;
  readonly animated?: boolean;
}

/** Original vector characters; the same identity follows a session across views. */
export function CrewAvatar({ id = 'crew', character = characterFor(id), status = 'idle', size = 64, animated = true }: CrewAvatarProps) {
  const style = { '--bot-color': character.color, '--bot-light': character.light } as CSSProperties;
  const asleep = status === 'stopped';
  return (
    <svg viewBox="0 0 100 112" width={size} height={size * 1.12}
      className={`crew-avatar bot-${character.kind} bot-${status} ${animated ? 'bot-animated' : ''}`}
      style={style} aria-hidden="true">
      <ellipse cx="50" cy="103" rx="27" ry="6" fill="#162139" opacity=".16" />
      <g className="bot-character">
        <g className="bot-legs" fill="#555167" stroke="#393546" strokeWidth="2.5">
          <path className="bot-leg-left" d="M31 82h13v16q0 5-7 5H26q-3-7 5-9Z" />
          <path className="bot-leg-right" d="M56 82h13v12q8 2 5 9H63q-7 0-7-5Z" />
        </g>
        <g className="bot-arm bot-arm-left" stroke="#393546" strokeWidth="2.5" fill="var(--bot-color)">
          <path d="M28 56q-15 4-15 18l2 8q6 3 10-2l-2-7 10-8Z" />
          <circle cx="19" cy="80" r="6" fill="var(--bot-light)" />
        </g>
        <path d="M27 55q23-8 46 0l-3 30q-20 12-40 0Z" fill="var(--bot-color)" stroke="#393546" strokeWidth="2.5" />
        <rect x="36" y="68" width="28" height="15" rx="4" fill="var(--bot-light)" opacity=".7" />
        <path d="M43 75h14M50 71v8" stroke="#716257" strokeWidth="2" strokeLinecap="round" />
        <g className="bot-head">
          {character.kind === 'cat' && <path d="m25 25-3-20 19 13M58 17 77 5l-3 21" fill="var(--bot-color)" stroke="#393546" strokeWidth="2.5" strokeLinejoin="round" />}
          {character.kind === 'plant' && <g className="bot-leaves"><path d="M50 20V7" stroke="#506849" strokeWidth="3" /><path d="M50 12Q31 12 34 0q17-1 16 12M51 10Q53-4 67 2q-2 13-16 8" fill="#9fc979" stroke="#506849" strokeWidth="2" /></g>}
          {(character.kind === 'round' || character.kind === 'box') && <g><path d="M50 19V6" stroke="#393546" strokeWidth="2.5" /><circle className="bot-antenna" cx="50" cy="5" r="4" fill="var(--bot-light)" stroke="#393546" strokeWidth="2" /></g>}
          {character.kind === 'jelly' ? <path d="M15 45q0-31 35-31t35 31q0 17-12 14l-7 5-9-5-7 5-8-5-8 5-8-5q-11 3-11-14Z" fill="var(--bot-color)" stroke="#393546" strokeWidth="2.5" /> :
            <rect x="19" y="17" width="62" height="43" rx={character.kind === 'box' ? 10 : character.kind === 'cyclops' ? 22 : 18} fill="var(--bot-color)" stroke="#393546" strokeWidth="2.5" />}
          <path d="M28 26q21-10 43 1" fill="none" stroke="var(--bot-light)" strokeWidth="4" strokeLinecap="round" opacity=".8" />
          <rect x="26" y="31" width="48" height="23" rx="10" fill="#353347" />
          <g className="bot-eyes" fill="var(--bot-light)">
            {asleep ? <path d="M35 44h8M57 44h8" stroke="var(--bot-light)" strokeWidth="2.5" strokeLinecap="round" /> : character.kind === 'cyclops' ? <g><circle cx="50" cy="42" r="8" /><circle cx="52" cy="41" r="3.5" fill="#353347" /><circle cx="54" cy="39" r="1.5" fill="#fff" /></g> : <g><rect x="35" y="37" width="6" height="10" rx="3" /><rect x="59" y="37" width="6" height="10" rx="3" /></g>}
          </g>
          {!asleep && character.kind !== 'cyclops' && <path d="M46 47q4 4 8 0" fill="none" stroke="var(--bot-light)" strokeWidth="1.7" strokeLinecap="round" />}
          {character.kind === 'cat' && <path d="m22 45 8 1m-8 5 8-2m48-4-8 1m8 5-8-2" stroke="var(--bot-light)" strokeWidth="2" />}
        </g>
        <g className="bot-arm bot-arm-right" stroke="#393546" strokeWidth="2.5" fill="var(--bot-color)">
          <path d="M73 55q14 4 14 18l-2 8q-6 3-10-2l2-7-10-8Z" />
          <circle cx="81" cy="80" r="6" fill="var(--bot-light)" />
        </g>
      </g>
      {status === 'waiting' && <g className="bot-attention"><circle cx="85" cy="13" r="11" fill="#f8c56c" stroke="#705237" strokeWidth="2" /><path d="M85 7v7m0 4h.01" stroke="#705237" strokeWidth="2.5" strokeLinecap="round" /></g>}
      {asleep && <text className="bot-sleep" x="79" y="15" fill="#848497" fontSize="12" fontWeight="700">z z</text>}
    </svg>
  );
}
