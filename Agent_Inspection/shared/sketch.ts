/*
 * The planning sketch on a project's console-board canvas: notes, text, shapes, images, pen strokes, free arrows, and
 * architecture components joined by connections. Shared by the board (which draws and edits it) and the daemon (which
 * stores it and lets agents read and edit it through the Waystation MCP tools). Everything here is pure and validates
 * untrusted input: imported files, agent edits and stored records all pass through parsePlanning.
 */

export interface SketchPoint { readonly x: number; readonly y: number }
export interface SketchRect extends SketchPoint { readonly width: number; readonly height: number }

export const COLORS = ['sand', 'mint', 'rose', 'blue'] as const;
export type NoteColor = typeof COLORS[number];
export const PLANNING_KINDS = ['note', 'text', 'shape', 'image', 'draw', 'arrow', 'component', 'link'] as const;
export type PlanningKind = typeof PLANNING_KINDS[number];

/** Architecture building blocks. `layer` is a dashed boundary (Frontend, Backend…); `stack` is a stacked group of instances. */
export const SKETCH_VARIANTS = ['client', 'loadbalancer', 'gateway', 'server', 'service', 'database', 'cache', 'queue', 'storage', 'external', 'layer', 'stack'] as const;
export type SketchVariant = typeof SKETCH_VARIANTS[number];

export interface PlanningNode extends SketchRect {
  readonly id: string;
  readonly kind: PlanningKind;
  /** Label, note text or connection label. */
  readonly text: string;
  readonly color: NoteColor;
  /** Pen strokes and free arrows, relative to x/y. */
  readonly points?: readonly SketchPoint[];
  /** Embedded image (data: URL) for image objects. */
  readonly src?: string;
  /** Which architecture block a component is. */
  readonly variant?: SketchVariant;
  /** A connection's source and target object ids. Its own x/y/width/height are unused. */
  readonly from?: string;
  readonly to?: string;
}
export interface PlanningDocument {
  readonly version: 1;
  readonly title: string;
  readonly nodes: readonly PlanningNode[];
}

export const MAX_SKETCH_NODES = 500;
export const MAX_SKETCH_TEXT = 12_000;
const LIMIT = 20_000;

export interface SketchLibraryEntry {
  readonly variant: SketchVariant;
  readonly label: string;
  readonly hint: string;
  readonly width: number;
  readonly height: number;
  readonly color: NoteColor;
}

/** What the palette offers and the default size, label and tint of each block. */
export const SKETCH_LIBRARY: readonly SketchLibraryEntry[] = [
  { variant: 'client', label: 'Client', hint: 'A user, browser or app', width: 96, height: 104, color: 'sand' },
  { variant: 'loadbalancer', label: 'Load balancer', hint: 'Spreads traffic', width: 136, height: 112, color: 'sand' },
  { variant: 'gateway', label: 'API gateway', hint: 'Single entry point', width: 168, height: 64, color: 'blue' },
  { variant: 'server', label: 'Server', hint: 'A host or container', width: 160, height: 72, color: 'blue' },
  { variant: 'service', label: 'Service', hint: 'One responsibility', width: 180, height: 48, color: 'mint' },
  { variant: 'database', label: 'Database', hint: 'SQL or NoSQL store', width: 128, height: 136, color: 'rose' },
  { variant: 'cache', label: 'Cache', hint: 'Redis, CDN…', width: 150, height: 60, color: 'rose' },
  { variant: 'queue', label: 'Queue', hint: 'Messages, events', width: 180, height: 56, color: 'mint' },
  { variant: 'storage', label: 'Storage', hint: 'Files, objects, blobs', width: 150, height: 72, color: 'rose' },
  { variant: 'external', label: 'External', hint: 'Third-party or cloud', width: 170, height: 96, color: 'blue' },
  { variant: 'stack', label: 'Stack', hint: 'Group of instances', width: 220, height: 280, color: 'blue' },
  { variant: 'layer', label: 'Layer', hint: 'Boundary: Frontend, Backend…', width: 340, height: 360, color: 'blue' },
];

export const sketchEntry = (variant: SketchVariant): SketchLibraryEntry => SKETCH_LIBRARY.find((entry) => entry.variant === variant)!;

export const emptyPlanning = (): PlanningDocument => ({ version: 1, title: 'Untitled canvas', nodes: [] });
export const newNodeId = (): string => globalThis.crypto.randomUUID();
const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const coordinate = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= LIMIT;
export const imageSource = (value: unknown): value is string => typeof value === 'string' && /^data:image\/(png|jpeg|webp|gif);base64,[A-Za-z0-9+/=]+$/.test(value) && value.length <= 2_800_000;
const isVariant = (value: unknown): value is SketchVariant => SKETCH_VARIANTS.includes(value as SketchVariant);
/** Objects a connection may join: everything except strokes, free arrows and other connections. */
export const connectable = (node: PlanningNode): boolean => node.kind !== 'link' && node.kind !== 'draw' && node.kind !== 'arrow';

/** Treat boards as untrusted data: no external image requests, executable markup or unbounded coordinates. */
export function parsePlanning(value: unknown): PlanningDocument {
  const doc = object(value);
  if (doc.version !== 1 || !Array.isArray(doc.nodes) || doc.nodes.length > MAX_SKETCH_NODES) throw new Error(`Choose a Waystation canvas file with at most ${MAX_SKETCH_NODES} objects.`);
  const seen = new Set<string>();
  const nodes = doc.nodes.map((raw): PlanningNode => {
    const node = object(raw);
    if (typeof node.id !== 'string' || !node.id || node.id.length > 100 || seen.has(node.id)) throw new Error('The canvas contains invalid or duplicate object IDs.');
    seen.add(node.id);
    if (!PLANNING_KINDS.includes(node.kind as PlanningKind) || !COLORS.includes(node.color as NoteColor)) throw new Error('The canvas contains an unsupported object.');
    if (![node.x, node.y, node.width, node.height].every(coordinate) || (node.width as number) < 1 || (node.height as number) < 1) throw new Error('The canvas contains invalid object dimensions.');
    if (typeof node.text !== 'string' || node.text.length > MAX_SKETCH_TEXT) throw new Error('An object contains too much text.');
    if (node.kind === 'image' && !imageSource(node.src)) throw new Error('Images must be embedded PNG, JPEG, WebP or GIF files under 2 MB.');
    if (node.kind === 'component' && !isVariant(node.variant)) throw new Error(`Components must be one of: ${SKETCH_VARIANTS.join(', ')}.`);
    if (node.kind === 'link' && (typeof node.from !== 'string' || typeof node.to !== 'string' || node.from === node.to)) throw new Error('A connection must join two different objects.');
    let points: SketchPoint[] | undefined;
    if (node.kind === 'draw' || node.kind === 'arrow') {
      if (!Array.isArray(node.points) || node.points.length < 2 || node.points.length > 5000) throw new Error('A drawing has invalid points.');
      points = node.points.map((rawPoint) => {
        const point = object(rawPoint);
        if (!coordinate(point.x) || !coordinate(point.y)) throw new Error('A drawing contains an invalid coordinate.');
        return { x: point.x, y: point.y };
      });
    }
    return { id: node.id, kind: node.kind as PlanningKind, color: node.color as NoteColor, text: node.text,
      x: node.x as number, y: node.y as number, width: node.width as number, height: node.height as number,
      ...(points ? { points } : {}), ...(node.kind === 'image' ? { src: node.src as string } : {}),
      ...(node.kind === 'component' ? { variant: node.variant as SketchVariant } : {}),
      ...(node.kind === 'link' ? { from: node.from as string, to: node.to as string } : {}) };
  });
  return { version: 1, title: typeof doc.title === 'string' ? doc.title.slice(0, 120) : 'Imported canvas', nodes: withoutDanglingLinks(nodes) };
}

/** Connections whose ends were removed (or are not connectable) go with them. */
export function withoutDanglingLinks(nodes: readonly PlanningNode[]): PlanningNode[] {
  const ends = new Set(nodes.filter(connectable).map((node) => node.id));
  return nodes.filter((node) => node.kind !== 'link' || (ends.has(node.from!) && ends.has(node.to!)));
}

/** Every authored path, including paste, duplicate, agent edits and keyboard moves, must stay round-trippable. */
export function constrainPlanning(doc: PlanningDocument): PlanningDocument {
  const bound = (n: number, min: number, max: number) => Math.min(max, Math.max(min, Number.isFinite(n) ? n : 0));
  return { ...doc, nodes: withoutDanglingLinks(doc.nodes).map((node) => ({ ...node,
    x: bound(node.x, -LIMIT, LIMIT), y: bound(node.y, -LIMIT, LIMIT),
    width: bound(node.width, 1, LIMIT), height: bound(node.height, 1, LIMIT),
    ...(node.points ? { points: node.points.map((point) => ({ x: bound(point.x, -LIMIT, LIMIT), y: bound(point.y, -LIMIT, LIMIT) })) } : {}),
  })) };
}

export function createPlanningNode(kind: PlanningKind, point: SketchPoint, color: NoteColor): PlanningNode {
  return { id: newNodeId(), kind, x: point.x, y: point.y, width: kind === 'image' ? 360 : 260, height: kind === 'text' ? 100 : 220, text: '', color };
}

/** An architecture block centred on `point`, with its library size, label and tint unless given. */
export function componentNode(variant: SketchVariant, point: SketchPoint, options: { color?: NoteColor; text?: string; id?: string } = {}): PlanningNode {
  const entry = sketchEntry(variant);
  return { id: options.id ?? newNodeId(), kind: 'component', variant, x: point.x - entry.width / 2, y: point.y - entry.height / 2,
    width: entry.width, height: entry.height, text: options.text ?? entry.label, color: options.color ?? entry.color };
}

/** A connection from one object to another; it is drawn between their current positions, so it follows them. */
export function linkNode(from: string, to: string, options: { text?: string; color?: NoteColor; id?: string } = {}): PlanningNode {
  return { id: options.id ?? newNodeId(), kind: 'link', from, to, x: 0, y: 0, width: 1, height: 1, text: options.text ?? '', color: options.color ?? 'blue' };
}

export function drawingNode(kind: 'draw' | 'arrow', points: readonly SketchPoint[], color: NoteColor): PlanningNode {
  const xs = points.map((point) => point.x), ys = points.map((point) => point.y);
  const x = Math.min(...xs), y = Math.min(...ys);
  return { ...createPlanningNode(kind, { x, y }, color), width: Math.max(1, Math.max(...xs) - x), height: Math.max(1, Math.max(...ys) - y),
    points: points.map((point) => ({ x: point.x - x, y: point.y - y })) };
}

/** How an object is named in briefs and agent responses. */
export function objectName(node: PlanningNode): string {
  const label = node.text.trim().split('\n')[0]?.slice(0, 80);
  if (node.kind === 'component') return label || sketchEntry(node.variant!).label;
  return label || node.kind;
}

/** Snapshot only authored material; a shared file never includes agent sessions, terminal output or access tokens. */
export function planningBrief(doc: PlanningDocument, nodes: readonly PlanningNode[]): string {
  const byId = new Map(doc.nodes.map((node) => [node.id, node]));
  const describe = (node: PlanningNode): string => {
    if (node.kind === 'link') {
      const from = byId.get(node.from!), to = byId.get(node.to!);
      return `connection: ${from ? objectName(from) : '?'} → ${to ? objectName(to) : '?'}${node.text.trim() ? ` (${node.text.trim()})` : ''}`;
    }
    const where = `(position ${Math.round(node.x)}, ${Math.round(node.y)})`;
    if (node.kind === 'component') {
      const inside = doc.nodes.filter((other) => other.kind === 'component' && other.variant === 'layer' && other.id !== node.id && contains(other, node));
      return `${sketchEntry(node.variant!).label.toLowerCase()}: ${objectName(node)}${inside.length ? ` [in ${inside.map(objectName).join(' > ')}]` : ''} ${where}`;
    }
    return `${node.kind}: ${node.text.trim() || (node.kind === 'image' ? 'Attached reference image' : 'Visual element')} ${where}`;
  };
  return `Canvas: ${doc.title}\n\n${nodes.map((node, i) => `${i + 1}. ${describe(node)}`).join('\n\n')}`;
}

/* ---------- Geometry ---------- */

export const center = (rect: SketchRect): SketchPoint => ({ x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 });
export const contains = (outer: SketchRect, inner: SketchRect): boolean =>
  inner.x >= outer.x && inner.y >= outer.y && inner.x + inner.width <= outer.x + outer.width && inner.y + inner.height <= outer.y + outer.height;

/** Where the line from the rect's centre towards `toward` leaves the rect. */
export function edgePoint(rect: SketchRect, toward: SketchPoint): SketchPoint {
  const c = center(rect), dx = toward.x - c.x, dy = toward.y - c.y;
  if (dx === 0 && dy === 0) return c;
  const scale = Math.min(Math.abs(dx) > 0 ? rect.width / 2 / Math.abs(dx) : Infinity, Math.abs(dy) > 0 ? rect.height / 2 / Math.abs(dy) : Infinity);
  return { x: c.x + dx * scale, y: c.y + dy * scale };
}

/** A connection's drawn ends: from the edge of one object to the edge of the other. */
export function linkEnds(from: SketchRect, to: SketchRect): { start: SketchPoint; end: SketchPoint } {
  return { start: edgePoint(from, center(to)), end: edgePoint(to, center(from)) };
}

/** The connectable object under a world point: the smallest one, so a service inside a layer wins over the layer. */
export function objectAt(nodes: readonly PlanningNode[], point: SketchPoint): PlanningNode | undefined {
  return nodes.filter((node) => connectable(node) && point.x >= node.x && point.x <= node.x + node.width && point.y >= node.y && point.y <= node.y + node.height)
    .sort((a, b) => a.width * a.height - b.width * b.height)[0];
}

/** Content bounds, ignoring connections (which have no position of their own). */
export function sketchBounds(nodes: readonly PlanningNode[]): SketchRect | undefined {
  const placed = nodes.filter((node) => node.kind !== 'link');
  if (!placed.length) return undefined;
  const x = Math.min(...placed.map((n) => n.x)), y = Math.min(...placed.map((n) => n.y));
  return { x, y, width: Math.max(...placed.map((n) => n.x + n.width)) - x, height: Math.max(...placed.map((n) => n.y + n.height)) - y };
}

/* ---------- Template ---------- */

/** A layered web architecture to start from: clients, a load balancer, frontend and backend layers, services and a database. */
export function layeredTemplate(origin: SketchPoint): readonly PlanningNode[] {
  const at = (variant: SketchVariant, x: number, y: number, text: string, size?: Partial<SketchRect>): PlanningNode => {
    const node = componentNode(variant, { x: 0, y: 0 }, { text });
    return { ...node, x: origin.x + x, y: origin.y + y, width: size?.width ?? node.width, height: size?.height ?? node.height };
  };
  const clients = [0, 150, 300].map((y) => at('client', 0, y + 20, 'Client'));
  const balancer = at('loadbalancer', 170, 160, 'Load balancer');
  const frontend = at('layer', 380, 0, 'Frontend', { width: 230, height: 460 });
  const ui = at('stack', 410, 70, 'UI', { width: 170, height: 360 });
  const backend = at('layer', 640, 0, 'Backend', { width: 330, height: 460 });
  const logic = at('stack', 670, 70, 'Logic', { width: 270, height: 360 });
  const services = ['Catalog service', 'Cart service', 'Discount service', 'Order service']
    .map((name, i) => at('service', 700, 140 + i * 62, name, { width: 210, height: 46 }));
  const database = at('database', 1030, 180, 'Database');
  const principles: PlanningNode = { ...createPlanningNode('text', { x: origin.x + 1010, y: origin.y - 50 }, 'sand'), width: 300, height: 210,
    text: 'Principles\n· KISS\n· YAGNI\n· Separation of concerns\n· SOLID' };
  const links = [
    ...clients.map((client) => linkNode(client.id, balancer.id)),
    linkNode(balancer.id, ui.id, { text: 'HTTPS' }), linkNode(ui.id, logic.id, { text: 'API' }), linkNode(logic.id, database.id, { text: 'SQL' }),
  ];
  return [frontend, backend, ...clients, balancer, ui, logic, ...services, database, principles, ...links];
}

/* ---------- Agent edits ---------- */

export interface SketchEditResult { readonly doc: PlanningDocument; readonly created: readonly string[] }

const text = (value: unknown, field: string, max = MAX_SKETCH_TEXT): string => {
  if (typeof value !== 'string' || value.length > max) throw new Error(`${field} must be text of at most ${max} characters.`);
  return value;
};
const optionalNumber = (value: unknown, field: string): number | undefined => {
  if (value === undefined) return undefined;
  if (!coordinate(value)) throw new Error(`${field} must be a number between -${LIMIT} and ${LIMIT}.`);
  return value;
};
const optionalColor = (value: unknown): NoteColor | undefined => {
  if (value === undefined) return undefined;
  if (!COLORS.includes(value as NoteColor)) throw new Error(`color must be one of: ${COLORS.join(', ')}.`);
  return value as NoteColor;
};
const optionalId = (value: unknown, taken: ReadonlySet<string>): string | undefined => {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !/^[\w-]{1,100}$/.test(value)) throw new Error('Object ids use letters, digits, - and _ (at most 100 characters).');
  if (taken.has(value)) throw new Error(`The id "${value}" is already used on this canvas.`);
  return value;
};

/**
 * Applies a batch of edits atomically (an invalid edit rejects the whole batch). Operations:
 * add {node: {id?, kind: component|note|text|shape, variant?, text, x?, y?, width?, height?, color?}} — x/y is the top-left;
 *   omitted, the object is placed below the current content. Ids given here can be used by later connect operations.
 * connect {id?, from, to, label?} · update {id, text?, x?, y?, width?, height?, color?, variant?} · remove {id} · title {title}
 */
export function applySketchOperations(doc: PlanningDocument, operations: unknown): SketchEditResult {
  if (!Array.isArray(operations) || operations.length === 0 || operations.length > 200) throw new Error('Send between 1 and 200 operations.');
  let nodes = [...doc.nodes];
  let title = doc.title;
  const created: string[] = [];
  const bounds = sketchBounds(nodes);
  let slotX = bounds?.x ?? 0;
  const slotY = bounds ? bounds.y + bounds.height + 80 : 0;
  const ids = () => new Set(nodes.map((node) => node.id));
  const find = (id: unknown): PlanningNode => {
    const node = nodes.find((entry) => entry.id === id);
    if (!node) throw new Error(`No object with id "${String(id)}". Read the sketch again for current ids.`);
    return node;
  };
  for (const raw of operations) {
    const op = object(raw);
    switch (op.type) {
      case 'add': {
        const spec = object(op.node);
        const kind = spec.kind;
        if (kind !== 'component' && kind !== 'note' && kind !== 'text' && kind !== 'shape') throw new Error('add creates a component, note, text or shape.');
        if (kind === 'component' && !isVariant(spec.variant)) throw new Error(`variant must be one of: ${SKETCH_VARIANTS.join(', ')}.`);
        const id = optionalId(spec.id, ids()) ?? newNodeId();
        const base = kind === 'component' ? componentNode(spec.variant as SketchVariant, { x: 0, y: 0 }, { id }) : { ...createPlanningNode(kind, { x: 0, y: 0 }, 'sand'), id };
        const width = optionalNumber(spec.width, 'width') ?? base.width, height = optionalNumber(spec.height, 'height') ?? base.height;
        const x = optionalNumber(spec.x, 'x'), y = optionalNumber(spec.y, 'y');
        const placed = { x: x ?? slotX, y: y ?? slotY };
        if (x === undefined && y === undefined) slotX += width + 48;
        nodes.push({ ...base, ...placed, width: Math.max(1, width), height: Math.max(1, height),
          text: spec.text === undefined ? base.text : text(spec.text, 'text'), color: optionalColor(spec.color) ?? base.color });
        created.push(id);
        break;
      }
      case 'connect': {
        const from = find(op.from), to = find(op.to);
        if (!connectable(from) || !connectable(to) || from.id === to.id) throw new Error('Connect two different components, notes, shapes, text or images.');
        const id = optionalId(op.id, ids()) ?? newNodeId();
        nodes.push(linkNode(from.id, to.id, { id, text: op.label === undefined ? '' : text(op.label, 'label', 200) }));
        created.push(id);
        break;
      }
      case 'update': {
        const node = find(op.id);
        if (op.variant !== undefined && (node.kind !== 'component' || !isVariant(op.variant))) throw new Error(`Only components have a variant (${SKETCH_VARIANTS.join(', ')}).`);
        const next: PlanningNode = { ...node,
          ...(op.text !== undefined ? { text: text(op.text, 'text') } : {}),
          ...(op.color !== undefined ? { color: optionalColor(op.color)! } : {}),
          ...(op.variant !== undefined ? { variant: op.variant as SketchVariant } : {}),
          ...Object.fromEntries((['x', 'y', 'width', 'height'] as const).flatMap((key) => {
            const value = optionalNumber(op[key], key);
            return value === undefined ? [] : [[key, key === 'width' || key === 'height' ? Math.max(1, value) : value]];
          })) };
        nodes = nodes.map((entry) => (entry.id === node.id ? next : entry));
        break;
      }
      case 'remove': {
        const node = find(op.id);
        nodes = withoutDanglingLinks(nodes.filter((entry) => entry.id !== node.id));
        break;
      }
      case 'title': title = text(op.title, 'title', 120); break;
      default: throw new Error('Each operation needs a type: add, connect, update, remove or title.');
    }
  }
  return { doc: parsePlanning(constrainPlanning({ version: 1, title, nodes })), created };
}

/** What agents read: the sketch without embedded image data (described by their captions instead). */
export function sketchForAgents(doc: PlanningDocument): PlanningDocument {
  return { ...doc, nodes: doc.nodes.map(({ src: _src, ...node }) => node) };
}
