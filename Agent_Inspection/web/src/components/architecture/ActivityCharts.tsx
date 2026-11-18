import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode, type RefObject } from 'react';

/** Inline-SVG chart kit for the Agent activity overview: thin marks, hairline grid, one tooltip per position, table twin. */
export interface ChartSeries { key: string; label: string; color: string; values: (number | null)[] }
interface Margin { top: number; right: number; bottom: number; left: number }

const PLOT_HEIGHT = 148;
const MARGIN: Margin = { top: 10, right: 10, bottom: 24, left: 52 };
const BAR_MAX = 24;
const GAP = 2;
const RADIUS = 4;
const TICK_SPACING = 76;
const MIN_WIDTH = 240;

export function useWidth<T extends HTMLElement>(): [RefObject<T | null>, number] {
  const ref = useRef<T>(null); const [width, setWidth] = useState(0);
  useEffect(() => {
    const el = ref.current; if (!el) return;
    setWidth(el.clientWidth);
    const observer = new ResizeObserver(entries => setWidth(Math.round(entries[0].contentRect.width)));
    observer.observe(el); return () => observer.disconnect();
  }, []);
  return [ref, width];
}

/** 0 plus 2-4 clean ticks (1/2/5 steps) covering `max`. */
export function niceTicks(max: number): number[] {
  if (!(max > 0)) return [0, 1];
  const rough = max / 3; const mag = 10 ** Math.floor(Math.log10(rough)); const step = [1, 2, 5, 10].map(m => m * mag).find(s => s >= rough) ?? 10 * mag;
  const ticks: number[] = []; for (let t = 0; t < max + step * 0.999; t += step) ticks.push(Number(t.toPrecision(12)));
  return ticks.length < 2 ? [0, step] : ticks;
}

export function timeLabel(start: number, bucketMs: number, withDate = false): string {
  const d = new Date(start);
  if (bucketMs >= 86_400_000) return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  const time = d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  return bucketMs >= 6 * 3_600_000 || withDate ? `${d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} ${time}` : time;
}
export const bucketRange = (start: number, bucketMs: number) => `${timeLabel(start, bucketMs, true)} – ${timeLabel(start + bucketMs, bucketMs, bucketMs < 86_400_000 && new Date(start).getDate() !== new Date(start + bucketMs).getDate())}`;

const roundedTop = (x: number, y: number, w: number, h: number) => {
  const r = Math.min(RADIUS, w / 2, h);
  return `M${x},${y + h}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h}Z`;
};

export function Legend({ items }: { items: { label: string; color: string; kind?: 'rect' | 'line' }[] }) {
  return <ul className="viz-legend">{items.map(item => <li key={item.label}><span className={`viz-key viz-key-${item.kind ?? 'rect'}`} style={{ background: item.color }} aria-hidden="true" />{item.label}</li>)}</ul>;
}

interface ChartCardProps { title: string; subtitle?: ReactNode; legend?: ReactNode; table: ReactNode; wide?: boolean; children: ReactNode; note?: ReactNode }
/** Card that owns the title, legend and the "View as table" twin every chart carries. */
export function ChartCard({ title, subtitle, legend, table, wide, children, note }: ChartCardProps) {
  const [asTable, setAsTable] = useState(false);
  return <figure className={`viz-card${wide ? ' viz-card-wide' : ''}`}>
    <header><div><h4>{title}</h4>{subtitle && <p>{subtitle}</p>}</div><button type="button" className="viz-table-toggle" aria-pressed={asTable} onClick={() => setAsTable(v => !v)}>{asTable ? 'View as chart' : 'View as table'}</button></header>
    {legend}
    {asTable ? <div className="viz-table-scroll">{table}</div> : children}
    {note && <figcaption>{note}</figcaption>}
  </figure>;
}

interface TimeChartProps { starts: number[]; bucketMs: number; series: ChartSeries[]; format: (value: number) => string; label: string; onSelect?: (index: number, key?: string) => void }

/** Keyboard + pointer state shared by the column and line charts: one active bucket, arrow keys move it. */
function useActive(count: number, onSelect?: (index: number) => void) {
  const [active, setActive] = useState<number>();
  const onKeyDown = (e: KeyboardEvent) => {
    if (!count) return;
    const move = { ArrowLeft: -1, ArrowRight: 1, Home: -Infinity, End: Infinity }[e.key];
    if (move !== undefined) { e.preventDefault(); setActive(a => Math.max(0, Math.min(count - 1, a === undefined ? count - 1 : a + move))); }
    else if ((e.key === 'Enter' || e.key === ' ') && active !== undefined && onSelect) { e.preventDefault(); onSelect(active); }
    else if (e.key === 'Escape') setActive(undefined);
  };
  return { active, setActive, onKeyDown, onFocus: () => setActive(a => a ?? count - 1), onBlur: () => setActive(undefined) };
}

function Axes({ width, ticks, scaleY, starts, bucketMs, band, format }: { width: number; ticks: number[]; scaleY: (v: number) => number; starts: number[]; bucketMs: number; band: number; format: (v: number) => string }) {
  const every = Math.max(1, Math.ceil(TICK_SPACING / Math.max(band, 1)));
  return <g aria-hidden="true">
    {ticks.map(t => <g key={t}><line className={t === 0 ? 'viz-baseline' : 'viz-gridline'} x1={MARGIN.left} x2={width - MARGIN.right} y1={scaleY(t)} y2={scaleY(t)} /><text className="viz-tick" x={MARGIN.left - 8} y={scaleY(t)} dy="0.32em" textAnchor="end">{format(t)}</text></g>)}
    {starts.map((s, i) => (starts.length - 1 - i) % every === 0 && <text key={s} className="viz-tick" x={MARGIN.left + band * (i + 0.5)} y={MARGIN.top + PLOT_HEIGHT + 16} textAnchor="middle">{timeLabel(s, bucketMs)}</text>)}
  </g>;
}

function Tooltip({ x, width, title, rows, hint }: { x: number; width: number; title: string; rows: { label: string; color: string; value: string; kind?: 'rect' | 'line' }[]; hint?: string }) {
  const left = Math.max(4, Math.min(x - 90, width - 184));
  return <div className="viz-tooltip" style={{ left }} role="status" aria-live="polite">
    <div className="viz-tooltip-title">{title}</div>
    {rows.map(row => <div key={row.label} className="viz-tooltip-row"><span className="viz-key viz-key-line" style={{ background: row.color }} aria-hidden="true" /><strong>{row.value}</strong><span>{row.label}</span></div>)}
    {hint && <div className="viz-tooltip-hint">{hint}</div>}
  </div>;
}

/** Stacked columns over time. Each segment is a click target; the column band is the hover target. */
export function TimeColumns({ starts, bucketMs, series, format, label, onSelect }: TimeChartProps) {
  const [ref, measured] = useWidth<HTMLDivElement>(); const width = Math.max(MIN_WIDTH, measured);
  const n = starts.length; const band = (width - MARGIN.left - MARGIN.right) / Math.max(n, 1);
  const totals = starts.map((_, i) => series.reduce((sum, s) => sum + (s.values[i] ?? 0), 0));
  const ticks = niceTicks(Math.max(0, ...totals)); const top = ticks.at(-1)!;
  const scaleY = (v: number) => MARGIN.top + PLOT_HEIGHT - (v / top) * PLOT_HEIGHT;
  const barW = Math.max(1, Math.min(BAR_MAX, band - GAP * 2));
  const { active, setActive, onKeyDown, onFocus, onBlur } = useActive(n, onSelect);
  return <div className="viz-plot" ref={ref}>
    <svg width={width} height={MARGIN.top + PLOT_HEIGHT + MARGIN.bottom} tabIndex={0} role="img" aria-label={`${label}. Use the arrow keys to read each period${onSelect ? '; Enter opens its runs' : ''}.`} onKeyDown={onKeyDown} onFocus={onFocus} onBlur={onBlur} onPointerLeave={() => setActive(undefined)}>
      <Axes width={width} ticks={ticks} scaleY={scaleY} starts={starts} bucketMs={bucketMs} band={band} format={format} />
      {starts.map((start, i) => {
        const x = MARGIN.left + band * i + (band - barW) / 2; let base = 0; const drawn = series.filter(s => (s.values[i] ?? 0) > 0);
        return <g key={start} className={active === i ? 'viz-active' : undefined}>
          <rect className="viz-hit" x={MARGIN.left + band * i} y={MARGIN.top} width={band} height={PLOT_HEIGHT} onPointerMove={() => setActive(i)} onClick={() => onSelect?.(i)} style={{ cursor: onSelect ? 'pointer' : undefined }} />
          {drawn.map((s, k) => {
            const value = s.values[i]!; const y0 = scaleY(base); const y1 = scaleY(base + value); base += value;
            const h = Math.max(1, y0 - y1 - (k > 0 ? GAP : 0));
            const isTop = k === drawn.length - 1;
            return isTop ? <path key={s.key} className="viz-mark" d={roundedTop(x, y1, barW, h)} fill={s.color} onPointerMove={() => setActive(i)} onClick={e => { e.stopPropagation(); onSelect?.(i, s.key); }} style={{ cursor: onSelect ? 'pointer' : undefined }} />
              : <rect key={s.key} className="viz-mark" x={x} y={y1} width={barW} height={h} fill={s.color} onPointerMove={() => setActive(i)} onClick={e => { e.stopPropagation(); onSelect?.(i, s.key); }} style={{ cursor: onSelect ? 'pointer' : undefined }} />;
          })}
        </g>;
      })}
    </svg>
    {active !== undefined && <Tooltip x={MARGIN.left + band * (active + 0.5)} width={width} title={bucketRange(starts[active], bucketMs)} rows={[...series].reverse().map(s => ({ label: s.label, color: s.color, value: format(s.values[active] ?? 0) }))} hint={onSelect && totals[active] > 0 ? 'Click a segment to open those runs' : undefined} />}
  </div>;
}

/** Lines over time with a snapping crosshair; null values break the line, isolated points keep a marker. */
export function TimeLines({ starts, bucketMs, series, format, label }: TimeChartProps) {
  const [ref, measured] = useWidth<HTMLDivElement>(); const width = Math.max(MIN_WIDTH, measured);
  const n = starts.length; const band = (width - MARGIN.left - MARGIN.right) / Math.max(n, 1);
  const ticks = niceTicks(Math.max(0, ...series.flatMap(s => s.values.filter((v): v is number => v !== null)))); const top = ticks.at(-1)!;
  const scaleY = (v: number) => MARGIN.top + PLOT_HEIGHT - (v / top) * PLOT_HEIGHT; const cx = (i: number) => MARGIN.left + band * (i + 0.5);
  const { active, setActive, onKeyDown, onFocus, onBlur } = useActive(n);
  const path = (values: (number | null)[]) => values.map((v, i) => v === null ? '' : `${i > 0 && values[i - 1] !== null ? 'L' : 'M'}${cx(i)},${scaleY(v)}`).join('');
  const isolated = (values: (number | null)[], i: number) => values[i] !== null && (i === 0 || values[i - 1] === null) && (i === n - 1 || values[i + 1] === null);
  return <div className="viz-plot" ref={ref}>
    <svg width={width} height={MARGIN.top + PLOT_HEIGHT + MARGIN.bottom} tabIndex={0} role="img" aria-label={`${label}. Use the arrow keys to read each period.`} onKeyDown={onKeyDown} onFocus={onFocus} onBlur={onBlur} onPointerLeave={() => setActive(undefined)}
      onPointerMove={e => { const box = e.currentTarget.getBoundingClientRect(); const i = Math.floor((e.clientX - box.left - MARGIN.left) / band); if (i >= 0 && i < n) setActive(i); }}>
      <Axes width={width} ticks={ticks} scaleY={scaleY} starts={starts} bucketMs={bucketMs} band={band} format={format} />
      {active !== undefined && <line className="viz-crosshair" x1={cx(active)} x2={cx(active)} y1={MARGIN.top} y2={MARGIN.top + PLOT_HEIGHT} />}
      {series.map(s => <g key={s.key}>
        <path className="viz-line" d={path(s.values)} stroke={s.color} />
        {s.values.map((v, i) => v !== null && (isolated(s.values, i) || active === i) && <circle key={i} className="viz-dot" cx={cx(i)} cy={scaleY(v)} r={4} fill={s.color} />)}
      </g>)}
    </svg>
    {active !== undefined && <Tooltip x={cx(active)} width={width} title={bucketRange(starts[active], bucketMs)} rows={series.map(s => ({ label: s.label, color: s.color, value: s.values[active] === null ? 'No finished runs' : format(s.values[active]!) }))} />}
  </div>;
}

/** Tile sparkline: de-emphasis stroke, current period marked. */
export function Sparkline({ values }: { values: number[] }) {
  if (values.length < 2 || !values.some(v => v > 0)) return null;
  const w = 96; const h = 24; const max = Math.max(...values);
  const pts = values.map((v, i) => [(i / (values.length - 1)) * (w - 4) + 2, h - 2 - (v / max) * (h - 4)] as const);
  return <svg className="viz-spark" width={w} height={h} aria-hidden="true"><path d={pts.map(([x, y], i) => `${i ? 'L' : 'M'}${x},${y}`).join('')} /><circle cx={pts.at(-1)![0]} cy={pts.at(-1)![1]} r={2.5} /></svg>;
}

export interface RankedRow { key: string; label: string; detail?: string; value: number; display: string; cells?: ReactNode[]; onSelect?: () => void }
/** Ranked horizontal bars on one baseline, one hue, with figures beside them; rows drill when they can. */
export function RankedBars({ rows, columns, caption, color }: { rows: RankedRow[]; columns: string[]; caption: string; color: string }) {
  const max = Math.max(0, ...rows.map(r => r.value));
  // Wide breakdowns (By tool has five columns) scroll inside their card on narrow screens instead of widening the page.
  return <div className="viz-ranked-scroll"><table className="viz-ranked"><caption className="arch-sr-only">{caption}</caption>
    <thead><tr>{columns.map((c, i) => <th key={c} scope="col" className={i ? 'num' : undefined}>{c}</th>)}</tr></thead>
    <tbody>{rows.map(row => <tr key={row.key}>
      <th scope="row">{row.onSelect ? <button type="button" className="viz-row-link" onClick={row.onSelect}>{row.label}</button> : <span>{row.label}</span>}{row.detail && <small>{row.detail}</small>}
        <span className="viz-meter" aria-hidden="true"><span style={{ width: max ? `${Math.max(1, (row.value / max) * 100)}%` : 0, background: color }} /></span></th>
      <td className="num">{row.display}</td>{row.cells?.map((cell, i) => <td key={i} className="num">{cell}</td>)}
    </tr>)}</tbody></table></div>;
}

/** Plain table twin for a time chart. */
export function TimeTable({ starts, bucketMs, series, format, caption }: { starts: number[]; bucketMs: number; series: ChartSeries[]; format: (v: number) => string; caption: string }) {
  return <table className="viz-table"><caption className="arch-sr-only">{caption}</caption>
    <thead><tr><th scope="col">Period</th>{series.map(s => <th key={s.key} scope="col" className="num">{s.label}</th>)}</tr></thead>
    <tbody>{starts.map((s, i) => <tr key={s}><th scope="row">{bucketRange(s, bucketMs)}</th>{series.map(x => <td key={x.key} className="num">{x.values[i] === null ? '—' : format(x.values[i]!)}</td>)}</tr>)}</tbody></table>;
}
