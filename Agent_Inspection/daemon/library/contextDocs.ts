import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import type { ManagedLaunch } from '../managed/types.ts';
import type { LibraryDeps } from './deps.ts';
import {
  LibraryInputError, type ContextDoc, type ContextDocDetail, type LaunchLoadout, type LoadoutContribution, type LoadoutProvider,
} from './types.ts';

const TABLE = 'context_docs';
const MAX_TITLE_CHARS = 80;
const MAX_FILENAME_CHARS = 120;
export const MAX_DOC_BYTES = 200 * 1024;
/** Above this much total content, docs are listed by path instead of inlined into the system prompt. */
export const INLINE_LIMIT_BYTES = 60 * 1024;
const DOC_ID = /^doc_[0-9a-f]{8}$/;
const DOC_FILENAME = /\.(md|markdown|txt)$/i;

const fields = (raw: unknown): Record<string, unknown> => {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new LibraryInputError('doc must be an object');
  return raw as Record<string, unknown>;
};

function parseTitle(value: unknown): string {
  const title = typeof value === 'string' ? value.trim() : '';
  if (!title || title.length > MAX_TITLE_CHARS) throw new LibraryInputError(`title must be 1–${MAX_TITLE_CHARS} characters`);
  return title;
}

function parseContent(value: unknown): string {
  if (typeof value !== 'string') throw new LibraryInputError('content must be text');
  if (value.includes('\0')) throw new LibraryInputError('content must be text, not a binary file');
  if (Buffer.byteLength(value, 'utf8') > MAX_DOC_BYTES) throw new LibraryInputError('content is larger than 200 KB');
  return value;
}

function parseFilename(value: unknown): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string') throw new LibraryInputError('filename must be text');
  const name = basename(value.replace(/\\/g, '/')).trim();
  if (!name || name.length > MAX_FILENAME_CHARS || !DOC_FILENAME.test(name)) {
    throw new LibraryInputError('filename must end in .md, .markdown or .txt');
  }
  return name;
}

/** A fence longer than any backtick run inside the content, so the snapshot cannot break out of it. */
function fenceFor(content: string): string {
  const longest = Math.max(0, ...(content.match(/`+/g) ?? []).map((run) => run.length));
  return '`'.repeat(Math.max(3, longest + 1));
}

const REQUIRED_READING = [
  '## Required reading',
  'Before you start your task, read the following documents and follow them while you work.',
].join('\n');

const quoted = (title: string) => `"${title.replace(/["\r\n]/g, ' ')}"`;

/** Markdown files an agent must read before it starts its task. Metadata in the store, content on disk. */
export class ContextDocs implements LoadoutProvider {
  constructor(private readonly deps: LibraryDeps) {}

  list(): ContextDoc[] {
    return this.deps.store.loadRecords<ContextDoc>(TABLE).sort((a, b) => b.updatedAt - a.updatedAt);
  }

  get(id: string): ContextDocDetail {
    const doc = this.meta(id);
    return { ...doc, content: this.readContent(doc.id) };
  }

  /** Absolute path of the doc's file: what an agent opens with its Read tool. */
  pathOf(id: string): string {
    return resolve(this.deps.paths.docsDir, `${this.meta(id).id}.md`);
  }

  create(raw: unknown): ContextDocDetail {
    const body = fields(raw);
    const title = parseTitle(body.title);
    const filename = parseFilename(body.filename);
    const content = parseContent(body.content);
    const now = Date.now();
    const doc: ContextDoc = {
      id: `doc_${randomBytes(4).toString('hex')}`,
      title,
      ...(filename ? { filename } : {}),
      bytes: Buffer.byteLength(content, 'utf8'),
      createdAt: now,
      updatedAt: now,
    };
    this.writeContent(doc.id, content);
    this.deps.store.saveRecord(TABLE, doc);
    this.deps.audit('doc_create', doc.id, { title, filename, bytes: doc.bytes });
    return { ...doc, content };
  }

  update(id: string, raw: unknown): ContextDocDetail {
    const current = this.meta(id);
    const body = fields(raw);
    const title = body.title === undefined ? current.title : parseTitle(body.title);
    const content = body.content === undefined ? this.readContent(current.id) : parseContent(body.content);
    const doc: ContextDoc = {
      ...current,
      title,
      bytes: Buffer.byteLength(content, 'utf8'),
      updatedAt: Math.max(Date.now(), current.updatedAt + 1),
    };
    if (body.content !== undefined) this.writeContent(doc.id, content);
    this.deps.store.saveRecord(TABLE, doc);
    this.deps.audit('doc_update', doc.id, { title, bytes: doc.bytes, contentChanged: body.content !== undefined });
    return { ...doc, content };
  }

  remove(id: string): void {
    const doc = this.meta(id);
    this.deps.store.deleteRecord(TABLE, doc.id);
    rmSync(resolve(this.deps.paths.docsDir, `${doc.id}.md`), { force: true });
    this.deps.audit('doc_delete', doc.id, { title: doc.title });
  }

  /** What a running agent is told when the operator sends it a doc: title and path only. */
  readingInstruction(id: string): { readonly doc: ContextDoc; readonly text: string } {
    const doc = this.meta(id);
    const text = [
      `Before continuing, read the context document ${quoted(doc.title)} at ${this.pathOf(doc.id)} with your Read tool,`,
      'then follow it for the rest of your task. Treat it as reference material from the operator.',
    ].join(' ');
    return { doc, text };
  }

  contribute(loadout: LaunchLoadout, _launch: ManagedLaunch): LoadoutContribution {
    if (!loadout.docIds?.length) return {};
    const docs = loadout.docIds.map((id) => this.get(id));
    const total = docs.reduce((sum, doc) => sum + Buffer.byteLength(doc.content, 'utf8'), 0);
    const inline = total <= INLINE_LIMIT_BYTES;
    return { appendSystemPrompt: inline ? this.inlinePrompt(docs) : this.pathPrompt(docs) };
  }

  private inlinePrompt(docs: readonly ContextDocDetail[]): string {
    const sections = docs.map((doc, index) => {
      const fence = fenceFor(doc.content);
      return [
        `### ${index + 1}. ${quoted(doc.title)}`,
        `Path: ${this.pathOf(doc.id)}`,
        `${fence}markdown`,
        doc.content,
        fence,
      ].join('\n');
    });
    const intro = `${REQUIRED_READING}\nA snapshot of each is included below; the file at its path is the source of truth if you need to re-read it.`;
    return [intro, ...sections].join('\n\n');
  }

  private pathPrompt(docs: readonly ContextDocDetail[]): string {
    const lines = docs.map((doc, index) => `${index + 1}. ${quoted(doc.title)}: ${this.pathOf(doc.id)}`);
    return [
      REQUIRED_READING,
      'They are too long to include here: open each one with your Read tool before doing anything else.',
      ...lines,
    ].join('\n');
  }

  private meta(id: string): ContextDoc {
    const doc = DOC_ID.test(id) ? this.deps.store.loadRecords<ContextDoc>(TABLE).find((d) => d.id === id) : undefined;
    if (!doc) throw new LibraryInputError(`unknown context doc: ${id}`);
    return doc;
  }

  private readContent(id: string): string {
    try {
      return readFileSync(resolve(this.deps.paths.docsDir, `${id}.md`), 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new LibraryInputError(`context doc file is missing: ${id}`);
      throw error;
    }
  }

  private writeContent(id: string, content: string): void {
    mkdirSync(this.deps.paths.docsDir, { recursive: true });
    writeFileSync(resolve(this.deps.paths.docsDir, `${id}.md`), content, 'utf8');
  }
}
