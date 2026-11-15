/**
 * Reading a Jupyter notebook (.ipynb, nbformat 4) into what a file tile shows: markdown, code with its outputs (text,
 * images, errors). Untrusted input: anything unexpected is skipped, never executed, and HTML outputs are not rendered
 * (their plain-text form is shown instead). Pure logic, no DOM.
 */

export type NotebookOutput =
  | { readonly kind: 'text'; readonly text: string; readonly tone: 'stream' | 'stderr' | 'result' }
  | { readonly kind: 'image'; readonly mime: string; readonly base64: string }
  | { readonly kind: 'markdown'; readonly text: string }
  | { readonly kind: 'error'; readonly text: string };

export interface NotebookCell {
  readonly kind: 'code' | 'markdown' | 'raw';
  readonly source: string;
  /** The execution count of a code cell, when it has run. */
  readonly count?: number;
  readonly outputs: readonly NotebookOutput[];
}

export interface Notebook {
  readonly language: string;
  readonly cells: readonly NotebookCell[];
  /** Cells left out past MAX_CELLS. */
  readonly hiddenCells: number;
}

export class NotebookError extends Error {}

export const MAX_CELLS = 2000;
export const MAX_OUTPUT_CHARS = 20_000;
const IMAGE_MIMES = ['image/png', 'image/jpeg', 'image/gif'] as const;

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/** nbformat stores multi-line strings either whole or as a list of lines. */
export const joinSource = (value: unknown): string =>
  (Array.isArray(value) ? value.filter((part): part is string => typeof part === 'string').join('') : typeof value === 'string' ? value : '');

/** Terminal colour codes, which tracebacks are full of. */
export const stripAnsi = (text: string): string => text.replace(/\u001b\[[0-9;?]*[A-Za-z]/g, '');

const capped = (text: string): string =>
  (text.length > MAX_OUTPUT_CHARS ? `${text.slice(0, MAX_OUTPUT_CHARS)}\n… (${text.length - MAX_OUTPUT_CHARS} more characters not shown)` : text);

function utf8Base64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  for (let i = 0; i < bytes.length; i += 1) binary += String.fromCharCode(bytes[i]!);
  return btoa(binary);
}

function richOutput(data: Record<string, unknown>): NotebookOutput | undefined {
  for (const mime of IMAGE_MIMES) {
    const image = joinSource(data[mime]).replace(/\s+/g, '');
    if (image) return { kind: 'image', mime, base64: image };
  }
  const svg = joinSource(data['image/svg+xml']);
  if (svg) return { kind: 'image', mime: 'image/svg+xml', base64: utf8Base64(svg) };
  const markdown = joinSource(data['text/markdown']);
  if (markdown) return { kind: 'markdown', text: capped(markdown) };
  const plain = joinSource(data['text/plain']);
  if (plain) return { kind: 'text', text: capped(plain), tone: 'result' };
  if (data['text/html'] !== undefined) return { kind: 'text', text: '(HTML output, not shown here)', tone: 'result' };
  return undefined;
}

function readOutput(value: unknown): NotebookOutput | undefined {
  if (!isRecord(value)) return undefined;
  switch (value.output_type) {
    case 'stream':
      return { kind: 'text', text: capped(stripAnsi(joinSource(value.text))), tone: value.name === 'stderr' ? 'stderr' : 'stream' };
    case 'execute_result':
    case 'display_data':
      return isRecord(value.data) ? richOutput(value.data) : undefined;
    case 'error': {
      const trace = Array.isArray(value.traceback) ? value.traceback.filter((line): line is string => typeof line === 'string').join('\n') : '';
      const summary = `${typeof value.ename === 'string' ? value.ename : 'Error'}: ${typeof value.evalue === 'string' ? value.evalue : ''}`;
      return { kind: 'error', text: capped(stripAnsi(trace) || summary) };
    }
    default:
      return undefined;
  }
}

function readCell(value: unknown): NotebookCell | undefined {
  if (!isRecord(value)) return undefined;
  const kind = value.cell_type === 'code' || value.cell_type === 'markdown' || value.cell_type === 'raw' ? value.cell_type : undefined;
  if (!kind) return undefined;
  const source = joinSource(value.source);
  if (kind !== 'code') return { kind, source, outputs: [] };
  const outputs = Array.isArray(value.outputs) ? value.outputs.map(readOutput).filter((output): output is NotebookOutput => output !== undefined) : [];
  const count = typeof value.execution_count === 'number' && Number.isFinite(value.execution_count) ? value.execution_count : undefined;
  return { kind, source, outputs, ...(count !== undefined ? { count } : {}) };
}

export function parseNotebook(text: string): Notebook {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new NotebookError('This notebook is not valid JSON.');
  }
  if (!isRecord(parsed) || !Array.isArray(parsed.cells)) throw new NotebookError('This file has no notebook cells (it may be an older notebook format).');
  const metadata = isRecord(parsed.metadata) ? parsed.metadata : {};
  const kernel = isRecord(metadata.kernelspec) && typeof metadata.kernelspec.language === 'string' ? metadata.kernelspec.language : undefined;
  const info = isRecord(metadata.language_info) && typeof metadata.language_info.name === 'string' ? metadata.language_info.name : undefined;
  const cells = parsed.cells.slice(0, MAX_CELLS).map(readCell).filter((cell): cell is NotebookCell => cell !== undefined);
  return { language: kernel ?? info ?? 'python', cells, hiddenCells: Math.max(0, parsed.cells.length - MAX_CELLS) };
}
