import type { WorldTheme } from '../crew.ts';
import { COLUMNS, floorCorners, gridPoint, type Point, type SceneBox } from '../stationLayout.ts';

/* The original art was drawn for a 1100×630 scene; sky decor keeps that scale and is pinned to the box edges. */
const ART_WIDTH = 1100;
const ART_HEIGHT = 630;
const SLAB = 22;
const WALL = 49;

const pt = (p: Point) => `${p.x.toFixed(1)} ${p.y.toFixed(1)}`;
const poly = (points: readonly Point[]) => `M${points.map(pt).join('L')}Z`;
const add = (p: Point, dx: number, dy: number): Point => ({ x: p.x + dx, y: p.y + dy });
const lerp = (a: Point, b: Point, t: number): Point => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });

export function Plant({ x, y, scale = 1 }: { x: number; y: number; scale?: number }) {
  return <g transform={`translate(${x} ${y}) scale(${scale})`}><ellipse cy="8" rx="18" ry="5" fill="#202d43" opacity=".16" /><path d="M-11-9h22L8 8H-8Z" fill="#b29a8c" stroke="#715d62" strokeWidth="2" /><ellipse cy="-9" rx="11" ry="4" fill="#dac4a2" stroke="#715d62" strokeWidth="2" /><path d="M0-8v-37" stroke="#587857" strokeWidth="3" /><path d="M0-18q-25 0-22-19Q-2-34 0-18M0-25q21 0 22-21Q2-45 0-25M0-35q-14-3-8-20Q9-48 0-35" fill="#86b887" stroke="#547857" strokeWidth="2" /></g>;
}

/** Sky, stars and the theme's scenery, stretched to whatever size the office has grown to. */
export function Backdrop({ theme, box, uid }: { theme: WorldTheme; box: SceneBox; uid: string }) {
  const left = `translate(${box.x} ${box.y})`;
  const right = `translate(${box.x + box.width - ART_WIDTH} ${box.y})`;
  // Ground-level scenery is stretched sideways only, and sits on the bottom edge.
  const ground = `translate(${box.x} ${box.y + box.height - ART_HEIGHT}) scale(${box.width / ART_WIDTH} 1)`;
  const groundLeft = `translate(${box.x} ${box.y + box.height - ART_HEIGHT})`;
  const groundRight = `translate(${box.x + box.width - ART_WIDTH} ${box.y + box.height - ART_HEIGHT})`;
  const stars = Math.round(box.width / 21);
  return (
    <g aria-hidden="true">
      <rect x={box.x} y={box.y} width={box.width} height={box.height} fill={`url(#${uid}-sky)`} />
      <ellipse cx={box.x + box.width * 0.53} cy={box.y + box.height * 0.45} rx={box.width * 0.5} ry={box.height * 0.47} fill={`url(#${uid}-halo)`} />
      {Array.from({ length: stars }, (_, i) => <circle key={i} className="world-star" cx={box.x + ((i * 137 + 41) % box.width)} cy={box.y + ((i * i * 31 + 17) % (box.height * 0.36))} r={i % 6 === 0 ? 1.7 : .8} fill="var(--star-color)" opacity={.25 + i % 4 * .14} style={{ animationDelay: `${i % 8}s` }} />)}
      {theme === 'moonbase' && <g>
        <g transform={right}><circle cx="920" cy="99" r="50" fill="#b4a9d8" opacity=".85" /><circle cx="933" cy="87" r="46" fill="#595070" /><circle cx="959" cy="77" r="7" fill="#827392" opacity=".45" /></g>
        <g transform={left}><ellipse cx="191" cy="114" rx="56" ry="14" fill="none" stroke="#8f819e" strokeWidth="4" transform="rotate(-18 191 114)" /><circle cx="191" cy="114" r="30" fill="#a997b1" /></g>
        <g transform={ground}><path d="M0 384q97-64 188-38t182-23q180-48 287 16t214-40q106-46 229 7v324H0Z" fill="#69617e" opacity=".26" /><path d="M0 480q93-42 200-19t141-18q179-54 337 28t248-45q78-56 174-22v226H0Z" fill="#3b354e" opacity=".55" /></g>
      </g>}
      {theme === 'greenhouse' && <g>
        <g transform={right}><circle cx="894" cy="95" r="46" fill="#f6d590" opacity=".8" /></g>
        <g transform={ground}><path d="M0 280Q66 88 140 170T292 174 457 176 650 152 883 141 1100 199v431H0Z" fill="#6a8779" opacity=".52" /><path d="M0 345q140-168 240-35t240-34q100-103 233 43t225-18q79-92 162-4v333H0Z" fill="#4d7266" opacity=".55" /></g>
        <g transform={left}><path d="M82 304V127m-37 66q-23-40 37-40t40-51" fill="none" stroke="#425f52" strokeWidth="13" strokeLinecap="round" /><ellipse cx="70" cy="128" rx="90" ry="37" fill="#9ebd7d" opacity=".7" /><path className="world-cloud" d="M364 73q-2-19 23-18 5-25 34-13 17-12 32 9 32-1 30 22Z" fill="#fff2cf" opacity=".22" /></g>
        <g transform={right}><path d="M973 329V106m-38 59q-15-43 38-43t45-35" fill="none" stroke="#425f52" strokeWidth="13" strokeLinecap="round" /><ellipse cx="983" cy="102" rx="101" ry="41" fill="#9ebd7d" opacity=".7" /></g>
      </g>}
      {theme === 'deepsea' && <g>
        <g transform={`translate(${box.x + box.width / 2 - 550} ${box.y})`}><path d="M420-20 210 450h65L566-20M710-20 590 400h38L819-20" fill="#86dddb" opacity=".045" /></g>
        <g transform={right}><path className="world-fish" d="M800 97q59-33 132 0l31-23-9 27 9 24-31-21q-72 34-132-7Z" fill="#72b3b8" opacity=".25" /></g>
        <g transform={ground}><path d="M0 467q76-45 178-11t191-25q129-64 271-6t231-23q130-91 229 38v190H0Z" fill="#236469" opacity=".4" /></g>
        {Array.from({ length: Math.round(box.width / 85) }, (_, i) => <circle key={i} className="world-bubble" cx={box.x + 40 + i * 86} cy={box.y + box.height - 180 - i % 4 * 90} r={3 + i % 3 * 3} fill="none" stroke="#87d0c9" opacity=".3" style={{ animationDelay: `${i * -1.4}s` }} />)}
        <g transform={groundLeft}><path className="world-kelp" d="M60 503q48-60 4-118t8-76" fill="none" stroke="#549e89" strokeWidth="14" strokeLinecap="round" /></g>
        <g transform={groundRight}><path className="world-kelp" d="M1029 519q-50-62-12-100t-9-93" fill="none" stroke="#549e89" strokeWidth="14" strokeLinecap="round" /></g>
      </g>}
    </g>
  );
}

/** The station deck for `rows` rows: slab, back wall with windows, floor grid, aisles and furniture. */
export function Floor({ theme, rows, box, uid }: { theme: WorldTheme; rows: number; box: SceneBox; uid: string }) {
  const { u0, u1, v0, v1, backLeft: bl, backRight: br, frontRight: fr, frontLeft: fl } = floorCorners(rows);
  const P = gridPoint;
  const wallBottomLeft = add(bl, -11, -1);
  const wallBottomRight = add(br, -7, -2);
  const wallTopLeft = add(wallBottomLeft, 0, -WALL);
  const wallTopRight = add(wallBottomRight, 0, -WALL);
  const windows = COLUMNS + 1;
  const wallSpan = { x: wallTopRight.x - wallTopLeft.x, y: wallTopRight.y - wallTopLeft.y };
  const windowSpan = { x: wallSpan.x * 0.78 / windows, y: wallSpan.y * 0.78 / windows };
  const antenna = add(lerp(bl, fl, 0.5), -95, 10);
  const stairs = add(P((u0 + u1) / 2 - 0.45, v1), 0, SLAB - 4);
  const terrarium = add(P(COLUMNS - 1 - 0.15, v1 - 0.24), -30, 0);
  const label = P(0.05, v1 - 0.16);
  const lounge = P(u1 - 0.3, v0 + 0.62);
  return (
    <g aria-hidden="true">
      <ellipse cx={(fl.x + br.x) / 2} cy={(fl.y + fr.y) / 2 + 24} rx={(fr.x - bl.x) / 2} ry={110} fill="#151a2c" opacity=".26" />
      {/* Solid foundation, rear wall and panoramic windows. */}
      <path d={poly([bl, fl, add(fl, 0, SLAB), add(bl, 0, SLAB)])} fill="var(--floor-edge)" stroke="#67607b" strokeWidth="3" strokeLinejoin="round" />
      <path d={poly([fl, fr, add(fr, 0, SLAB), add(fl, 0, SLAB)])} fill="var(--floor-edge)" stroke="#67607b" strokeWidth="3" strokeLinejoin="round" />
      <path d={poly([wallTopLeft, wallTopRight, wallBottomRight, wallBottomLeft])} fill="var(--wall-color)" stroke="#6e6684" strokeWidth="3" strokeLinejoin="round" />
      <path d={poly([wallTopLeft, wallTopRight, add(wallTopRight, 11, 10), add(wallTopLeft, 11, 10)])} fill="#d4ccdf" stroke="#8d83a0" strokeWidth="2" />
      {Array.from({ length: windows }, (_, i) => {
        const start = add(lerp(wallTopLeft, wallTopRight, (i + 0.11) / windows), 0, 6);
        const end = add(start, windowSpan.x, windowSpan.y);
        const middle = lerp(start, end, 0.5);
        return (
          <g key={i}>
            <path d={poly([start, end, add(end, 0, 34), add(start, 0, 34)])} fill={`url(#${uid}-window)`} stroke="#78708a" strokeWidth="2" />
            <path d={poly([add(start, 15, 5), add(start, 38, 2), add(start, 25, 28), add(start, 3, 31)])} fill="#f3e9ff" opacity=".1" />
            <path d={`M${pt(middle)}v34`} stroke="#8b8398" strokeWidth="2" />
          </g>
        );
      })}
      <path d={poly([bl, br, fr, fl])} fill={`url(#${uid}-floor)`} stroke="#aaa1b9" strokeWidth="2" />
      {Array.from({ length: COLUMNS + 1 }, (_, k) => <path key={`c${k}`} d={`M${pt(P(k - 0.5, v0))}L${pt(P(k - 0.5, v1))}`} fill="none" stroke="var(--floor-line)" strokeWidth="1" />)}
      {Array.from({ length: rows + 1 }, (_, k) => <path key={`r${k}`} d={`M${pt(P(u0, k - 0.5))}L${pt(P(u1, k - 0.5))}`} fill="none" stroke="var(--floor-line)" strokeWidth="1" />)}
      {/* An aisle between every two rows of desks, and a walkway along the front. */}
      {Array.from({ length: rows }, (_, r) => {
        const near = r === rows - 1;
        const a = near ? v1 - 0.3 : r + 0.6;
        const b = near ? v1 - 0.16 : r + 0.72;
        return (
          <g key={`aisle${r}`}>
            <path d={poly([P(u0 + 0.15, a), P(u1 - 0.15, a), P(u1 - 0.15, b), P(u0 + 0.15, b)])} fill="var(--walkway-color)" opacity=".42" />
            <path d={`M${pt(P(u0 + 0.35, (a + b) / 2))}L${pt(P(u1 - 0.35, (a + b) / 2))}`} stroke="#f5e8ca" strokeWidth="2" strokeDasharray="7 14" opacity=".35" />
          </g>
        );
      })}
      {/* Lounge, plants, a little terrarium, the exterior antenna and the stairs down. */}
      <g transform={`translate(${pt(lounge)})`}><path d="m-15-26 47-6 28 29-47 6Z" fill="#a89aaa" stroke="#6f627e" strokeWidth="2" /><path d="m13 3 47-6v23l-47 6Z" fill="#82758e" stroke="#6f627e" strokeWidth="2" /><path d="m-15-26 28 29v23l-28-29Z" fill="#91829d" stroke="#6f627e" strokeWidth="2" /><path d="M-4-31 34-36l10 12-38 5Z" fill="#cab2b8" stroke="#817185" strokeWidth="2" /><path d="m19-3 23-3" stroke="#dac4bf" strokeWidth="4" /></g>
      <Plant {...P(u0 + 0.2, v0 + 0.14)} scale={.85} />
      <Plant {...P(u1 - 0.24, v0 + 0.1)} scale={1.1} />
      <Plant {...P(u1 - 0.22, v1 - 0.2)} scale={.9} />
      {theme === 'greenhouse' && Array.from({ length: rows }, (_, r) => <Plant key={r} {...P(u0 + 0.22, r + 0.62)} scale={1.15} />)}
      <g transform={`translate(${pt(terrarium)})`}><path d="m0 0 67-9 22 22-67 9Z" fill="#b5a6be" stroke="#83748e" strokeWidth="2" /><path d="m22 22 67-9v19l-67 9Z" fill="#887993" stroke="#83748e" strokeWidth="2" /><path d="m11-22 45-6 19 22-45 6Z" fill="#7ca79b" opacity=".65" stroke="#96c2ba" strokeWidth="2" /><path d="M11-22v22M56-28v20M75-6v10" stroke="#9ccec1" strokeWidth="2" /><path d="m31-3 4-20 9 16 10-12 2 12" fill="none" stroke="#b8d5a2" strokeWidth="4" /></g>
      <g transform={`translate(${pt(antenna)})`}><ellipse cy="30" rx="36" ry="10" fill="#28243b" opacity=".25" /><path d="M0-44v64m-18 12 18-12 18 7" fill="none" stroke="#a098b1" strokeWidth="5" strokeLinecap="round" /><path d="M-18-72q31-2 49 24-31 15-54-7Z" fill="#beb3cb" stroke="#746b89" strokeWidth="3" /><path d="m-10-60 26 17 5-37" fill="none" stroke="#8d7b9f" strokeWidth="3" /><circle className="antenna-light" cx="21" cy="-80" r="4" fill="#eeb8a2" /></g>
      <g transform={`translate(${pt(stairs)})`}><path d="m0 0 100-14 51 47-100 14Z" fill="#9187a0" stroke="#6d627f" strokeWidth="2" /><path d="m15 15 100-13m-84 28 100-13" stroke="#c3b8d0" strokeWidth="3" /></g>
      <text x={label.x} y={label.y} transform={`rotate(-7 ${label.x} ${label.y})`} fill="var(--floor-label)" fontSize="12" fontFamily="var(--mono)" letterSpacing="5" opacity=".55">WAYSTATION / 01</text>
      <text x={box.x + 40} y={box.y + box.height - 26} fill="var(--scene-caption)" fontSize="9" fontFamily="var(--mono)" letterSpacing="2">A SMALL STATION. A BIG MISSION.</text>
    </g>
  );
}
