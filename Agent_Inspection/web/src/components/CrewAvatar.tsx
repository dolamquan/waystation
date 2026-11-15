import type { CSSProperties } from 'react';
import type { Agent } from '../api.ts';
import { characterFor, type CrewCharacter } from '../crew.ts';

interface CrewAvatarProps {
  readonly id?: string;
  readonly character?: CrewCharacter;
  readonly status?: Agent['status'];
  readonly size?: number;
  /** Lets a working session's glyph breathe; off in lists. */
  readonly animated?: boolean;
}

/** One geometric mark per character, drawn on a 24-unit grid with a 1.75 stroke. */
function Glyph({ kind }: { kind: CrewCharacter['kind'] }) {
  switch (kind) {
    case 'round': return <circle cx="12" cy="12" r="5.5" className="glyph-fill" />;
    case 'cat': return <path d="M12 6.2 18 16.8H6Z" className="glyph-fill" strokeLinejoin="round" />;
    case 'jelly': return <g><circle cx="12" cy="12" r="5.6" className="glyph-stroke" /><circle cx="17.6" cy="12" r="1.9" className="glyph-fill glyph-orbit" /></g>;
    case 'plant': return <path d="M12 5.8 18.2 12 12 18.2 5.8 12Z" className="glyph-fill" strokeLinejoin="round" />;
    case 'box': return <rect x="7" y="7" width="10" height="10" rx="1.6" className="glyph-fill" />;
    case 'cyclops': return <g><circle cx="12" cy="12" r="6" className="glyph-stroke" /><circle cx="12" cy="12" r="2.2" className="glyph-fill" /></g>;
  }
}

/** A session's identity mark: the same shape and color follow it across every view. */
export function CrewAvatar({ id = 'crew', character = characterFor(id), status = 'idle', size = 64, animated = true }: CrewAvatarProps) {
  const style = { '--bot-color': character.color, '--bot-light': character.light, width: size, height: size } as CSSProperties;
  return (
    <span className={`crew-avatar bot-${character.kind} bot-${status} ${animated && status === 'busy' ? 'bot-animated' : ''}`} style={style} aria-hidden="true">
      <svg viewBox="0 0 24 24" width="100%" height="100%"><Glyph kind={character.kind} /></svg>
      {status === 'waiting' && <span className="bot-attention" />}
    </span>
  );
}
