import type { CSSProperties } from 'react';

const paths = {
  tower: 'M4 20h16M8 20V9l4-5 4 5v11M8 12h8M8 16h8M12 4V2',
  grid: 'M3 3h7v7H3zM14 3h7v7h-7zM3 14h7v7H3zM14 14h7v7h-7z',
  activity: 'M3 12h4l3-8 4 16 3-8h4',
  alert: 'M12 3 2 21h20L12 3ZM12 9v5M12 17h.01',
  plus: 'M12 5v14M5 12h14',
  search: 'M21 21l-5-5M18 10a8 8 0 1 1-16 0 8 8 0 0 1 16 0',
  arrow: 'M5 12h14M13 6l6 6-6 6',
  power: 'M12 2v10M6 5a9 9 0 1 0 12 0',
  link: 'M10 13a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-2 2M14 11a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l2-2',
  folder: 'M3 7V4h6l3 3h9v13H3V7Z',
  terminal: 'm5 7 5 5-5 5M13 17h6',
  check: 'm5 12 4 4L19 6',
  close: 'm6 6 12 12M6 18 18 6',
  list: 'M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01',
  shield: 'M12 2 3 6v6c0 5 9 10 9 10s9-5 9-10V6l-9-4Zm-4 10 3 3 5-6',
  planet: 'M20 12a8 8 0 1 1-16 0 8 8 0 0 1 16 0M3 15c-5 5 3 6 11 1S26 4 20 7',
  crew: 'M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M17 4a4 4 0 0 1 0 8M22 21v-2a4 4 0 0 0-3-4M13 7a4 4 0 1 1-8 0 4 4 0 0 1 8 0',
  sparkle: 'm12 2 3 7 7 3-7 3-3 7-3-7-7-3 7-3 3-7Z',
  cursor: 'm4 3 7 18 3-7 7-3L4 3Z',
  play: 'm8 5 12 7-12 7V5Z',
  pause: 'M8 4v16M16 4v16',
  chevronLeft: 'm15 6-6 6 6 6',
  chevronRight: 'm9 6 6 6-6 6',
  zoom: 'M21 21l-5-5M18 10a8 8 0 1 1-16 0 8 8 0 0 1 16 0M10 6v8M6 10h8',
  fit: 'M8 3H3v5M16 3h5v5M3 16v5h5M21 16v5h-5',
  message: 'M21 11a8 8 0 0 1-8 8H7l-5 3 2-6a8 8 0 0 1-1-5 8 8 0 0 1 8-8h2a8 8 0 0 1 8 8ZM7 9h10M7 13h6',
  send: 'm22 2-7 20-4-9L2 9l20-7ZM11 13 22 2',
  chevronDown: 'm6 9 6 6 6-6',
  copy: 'M9 9h12v12H9zM15 9V3H3v12h6',
  book: 'M12 5v16M12 5Q7 2 2 5v15q5-3 10 1 5-4 10-1V5q-5-3-10 0',
  refresh: 'M20 7V2M20 7h-5M4 17v5M4 17h5M20 7a9 9 0 0 0-15-3M4 17a9 9 0 0 0 15 3',
  info: 'M12 11v6M12 7h.01M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0',
} as const;

export function Icon({ name, size = 18, style }: { readonly name: keyof typeof paths; readonly size?: number; readonly style?: CSSProperties }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={style}><path d={paths[name]} /></svg>;
}
