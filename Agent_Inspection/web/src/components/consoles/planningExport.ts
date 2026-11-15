import { linkEnds, type PlanningDocument, type PlanningNode } from './planningBoard.ts';

const PAPER = { sand: '#eed69c', mint: '#b9dbc6', rose: '#e4bdc9', blue: '#b9cfeb' };
const INK = { sand: '#3c3017', mint: '#213f30', rose: '#492532', blue: '#23364c' };
const SHAPE = { sand: '#4f4430', mint: '#284b3e', rose: '#50333f', blue: '#2b405c' };
const SHAPE_INK = { sand: '#ffe5a7', mint: '#c4efda', rose: '#f4ccda', blue: '#cce1ff' };
const STROKE = { sand: '#ebcf89', mint: '#9ad7bb', rose: '#e5a6b9', blue: '#a7cafa' };

/** A bounded raster of authored material, suitable for sharing and for agents that accept image context. */
export async function renderPlanningImage(doc: PlanningDocument, nodes: readonly PlanningNode[]): Promise<string> {
  // Connections have no position of their own: they are drawn between their ends, which set the bounds.
  const placed = nodes.filter((node) => node.kind !== 'link');
  if (!placed.length) throw new Error('Add an idea to the board before exporting an image.');
  const left = Math.min(...placed.map((node) => node.x)), top = Math.min(...placed.map((node) => node.y));
  const width = Math.max(...placed.map((node) => node.x + node.width)) - left + 96;
  const height = Math.max(...placed.map((node) => node.y + node.height)) - top + 128;
  const byId = new Map(doc.nodes.map((node) => [node.id, node]));
  const scale = Math.min(2, 2400 / Math.max(width, height));
  const canvas = document.createElement('canvas'); canvas.width = Math.ceil(width * scale); canvas.height = Math.ceil(height * scale);
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('This browser cannot export a canvas image. Export an editable board instead.');
  ctx.scale(scale, scale); ctx.fillStyle = '#090b14'; ctx.fillRect(0, 0, width, height);
  ctx.font = '600 19px "Source Sans 3", sans-serif'; ctx.fillStyle = '#e6e8f2'; ctx.fillText(doc.title, 36, 32, width - 72);
  ctx.translate(48 - left, 80 - top);
  const wrappedText = (text: string, x: number, y: number, maxWidth: number, maxHeight: number, size = 20, centered = false) => {
    ctx.font = `${size}px "Source Sans 3", sans-serif`; ctx.textBaseline = 'top';
    ctx.textAlign = centered ? 'center' : 'left';
    const drawLine = (line: string, cursor: number) => ctx.fillText(line, centered ? x + maxWidth / 2 : x, cursor, maxWidth);
    let line = '', cursor = y;
    // Split long unbroken words too, so imported URLs never spill across neighboring objects.
    for (const paragraph of text.split('\n')) {
      const parts = paragraph.split(/(\s+)/);
      for (const part of parts) {
        for (const character of part) {
          if (ctx.measureText(line + character).width > maxWidth && line) { drawLine(line, cursor); line = ''; cursor += size * 1.4; }
          if (cursor > y + maxHeight - size) return;
          line += character;
        }
      }
      drawLine(line, cursor); line = ''; cursor += size * 1.4;
      if (cursor > y + maxHeight - size) return;
    }
  };
  // Layers first (they are boundaries), then strokes and connections, then everything else: as on the interactive board.
  const isLayer = (node: PlanningNode) => node.kind === 'component' && node.variant === 'layer';
  const ordered = [...placed.filter(isLayer), ...placed.filter((node) => node.points), ...nodes.filter((node) => node.kind === 'link'),
    ...placed.filter((node) => !node.points && !isLayer(node))];
  for (const node of ordered) {
    if (node.kind === 'link') {
      const from = byId.get(node.from!), to = byId.get(node.to!);
      if (from && to) drawLink(ctx, from, to, node.text, wrappedText);
      continue;
    }
    ctx.save(); ctx.translate(node.x, node.y);
    if (node.kind === 'component') {
      drawComponent(ctx, node);
      ctx.fillStyle = '#ededee';
      const labelTop = node.variant === 'layer' || node.variant === 'stack' ? 14 : node.variant === 'client' ? node.height - 24 : node.height / 2 - 10;
      wrappedText(node.text, 8, labelTop, node.width - 16, node.height - labelTop, node.variant === 'layer' || node.variant === 'stack' ? 18 : 14, node.variant !== 'layer');
    } else if (node.points) {
      ctx.strokeStyle = STROKE[node.color]; ctx.lineWidth = 3; ctx.lineJoin = 'round'; ctx.lineCap = 'round'; ctx.beginPath();
      node.points.forEach((point, i) => i ? ctx.lineTo(point.x, point.y) : ctx.moveTo(point.x, point.y)); ctx.stroke();
      if (node.kind === 'arrow') {
        const first = node.points[0]!, end = node.points.at(-1)!, angle = Math.atan2(end.y - first.y, end.x - first.x);
        ctx.beginPath(); ctx.moveTo(end.x - 15 * Math.cos(angle + .5), end.y - 15 * Math.sin(angle + .5)); ctx.lineTo(end.x, end.y); ctx.lineTo(end.x - 15 * Math.cos(angle - .5), end.y - 15 * Math.sin(angle - .5)); ctx.stroke();
      }
    } else if (node.kind === 'image' && node.src) {
      const image = new Image(); image.src = node.src; await image.decode();
      ctx.fillStyle = '#1e2435'; ctx.fillRect(0, 0, node.width, node.height);
      const ratio = Math.min(node.width / image.naturalWidth, Math.max(1, node.height - 38) / image.naturalHeight);
      const iw = image.naturalWidth * ratio, ih = image.naturalHeight * ratio;
      ctx.drawImage(image, (node.width - iw) / 2, (node.height - 38 - ih) / 2, iw, ih);
      ctx.fillStyle = '#e6e8f2'; wrappedText(node.text, 10, node.height - 28, node.width - 20, 24, 12);
    } else {
      if (node.kind !== 'text') {
        ctx.fillStyle = node.kind === 'shape' ? SHAPE[node.color] : PAPER[node.color]; ctx.beginPath(); ctx.roundRect(0, 0, node.width, node.height, node.kind === 'shape' ? 12 : 3); ctx.fill();
        if (node.kind === 'shape') { ctx.strokeStyle = SHAPE_INK[node.color]; ctx.lineWidth = 1; ctx.stroke(); }
      }
      ctx.fillStyle = node.kind === 'text' ? PAPER[node.color] : node.kind === 'shape' ? SHAPE_INK[node.color] : INK[node.color];
      wrappedText(node.text, 18, node.kind === 'text' ? 20 : 36, node.width - 36, node.height - 50, node.kind === 'text' ? 24 : 20, node.kind === 'shape');
    }
    ctx.restore();
  }
  return canvas.toDataURL('image/png');
}

const TINT = { sand: '#f1b54a', mint: '#4fd394', rose: '#f47a72', blue: '#7fb2ff' };
const mix = (hex: string, amount: number) => `${hex}${Math.round(amount * 255).toString(16).padStart(2, '0')}`;

/** An architecture block's silhouette, in its own coordinates (the caller has translated to its top-left). */
function drawComponent(ctx: CanvasRenderingContext2D, node: PlanningNode): void {
  const tint = TINT[node.color], w = node.width, h = node.height;
  ctx.fillStyle = mix(tint, 0.16); ctx.strokeStyle = mix(tint, 0.7); ctx.lineWidth = 1.5; ctx.setLineDash([]);
  ctx.beginPath();
  switch (node.variant) {
    case 'layer': ctx.setLineDash([6, 5]); ctx.fillStyle = mix(tint, 0.04); ctx.roundRect(0, 0, w, h, 14); break;
    case 'loadbalancer': ctx.moveTo(w / 2, 0); ctx.lineTo(w, h / 2); ctx.lineTo(w / 2, h); ctx.lineTo(0, h / 2); ctx.closePath(); break;
    case 'database': {
      const ry = Math.min(14, h * 0.12);
      ctx.ellipse(w / 2, ry, w / 2, ry, 0, Math.PI, 0); ctx.lineTo(w, h - ry); ctx.ellipse(w / 2, h - ry, w / 2, ry, 0, 0, Math.PI); ctx.closePath();
      ctx.fill(); ctx.stroke(); ctx.beginPath(); ctx.ellipse(w / 2, ry, w / 2, ry, 0, 0, Math.PI); break;
    }
    case 'client': ctx.arc(w / 2, h * 0.28, Math.min(w, h) * 0.18, 0, Math.PI * 2); ctx.fill(); ctx.beginPath(); ctx.ellipse(w / 2, h * 0.68, w * 0.32, h * 0.16, 0, Math.PI, 0); ctx.closePath(); break;
    case 'service': ctx.roundRect(0, 0, w, h, h / 2); break;
    case 'external': ctx.roundRect(0, 0, w, h, h / 2.2); break;
    default: ctx.roundRect(0, 0, w, h, 10);
  }
  if (node.variant === 'stack') { ctx.save(); ctx.translate(8, -8); ctx.fill(); ctx.stroke(); ctx.restore(); ctx.fillStyle = '#111113'; }
  ctx.fill(); ctx.stroke(); ctx.setLineDash([]);
}

/** A connection from edge to edge, with an arrowhead and its label at the middle. */
function drawLink(ctx: CanvasRenderingContext2D, from: PlanningNode, to: PlanningNode, label: string,
  wrappedText: (text: string, x: number, y: number, maxWidth: number, maxHeight: number, size?: number, centered?: boolean) => void): void {
  const { start, end } = linkEnds(from, to);
  const angle = Math.atan2(end.y - start.y, end.x - start.x);
  ctx.save(); ctx.strokeStyle = '#b9b9bf'; ctx.lineWidth = 2; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  ctx.beginPath(); ctx.moveTo(start.x, start.y); ctx.lineTo(end.x, end.y);
  ctx.moveTo(end.x - 11 * Math.cos(angle + 0.45), end.y - 11 * Math.sin(angle + 0.45)); ctx.lineTo(end.x, end.y);
  ctx.lineTo(end.x - 11 * Math.cos(angle - 0.45), end.y - 11 * Math.sin(angle - 0.45)); ctx.stroke();
  if (label.trim()) {
    const mid = { x: (start.x + end.x) / 2, y: (start.y + end.y) / 2 };
    ctx.font = '12px "Geist", sans-serif';
    const textWidth = Math.min(180, ctx.measureText(label).width + 14);
    ctx.fillStyle = '#0e0e10'; ctx.beginPath(); ctx.roundRect(mid.x - textWidth / 2, mid.y - 10, textWidth, 20, 6); ctx.fill();
    ctx.fillStyle = '#b9b9bf'; wrappedText(label, mid.x - textWidth / 2, mid.y - 7, textWidth, 20, 12, true);
  }
  ctx.restore();
}

export function downloadPlanningImage(name: string, data: string): void {
  const anchor = document.createElement('a'); anchor.href = data; anchor.download = `${name.replace(/[^a-z0-9_-]/gi, '-').slice(0, 80) || 'canvas'}.png`; anchor.click();
}
