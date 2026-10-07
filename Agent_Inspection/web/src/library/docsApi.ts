import { request } from '../api.ts';
import type { ContextDoc, ContextDocDetail, ContextDocInput } from '../../../daemon/library/types.ts';

export type { ContextDoc, ContextDocDetail, ContextDocInput };

/** Same limit the daemon enforces. */
export const MAX_DOC_BYTES = 200 * 1024;
export const DOC_FILE_PATTERN = /\.(md|markdown|txt)$/i;

const enc = encodeURIComponent;

export const docsApi = {
  list: () => request<{ docs: ContextDoc[] }>('GET', '/api/library/docs'),
  get: (id: string) => request<{ doc: ContextDocDetail }>('GET', `/api/library/docs/${enc(id)}`),
  create: (input: ContextDocInput) => request<{ ok: true; doc: ContextDocDetail }>('POST', '/api/library/docs', input),
  update: (id: string, patch: { readonly title?: string; readonly content?: string }) =>
    request<{ ok: true; doc: ContextDocDetail }>('POST', `/api/library/docs/${enc(id)}`, patch),
  remove: (id: string) => request<{ ok: true }>('POST', `/api/library/docs/${enc(id)}/delete`, { confirm: true }),
  /** Tells a running agent to read the doc before continuing. */
  sendToAgent: (agentId: string, docId: string) =>
    request<{ ok: true }>('POST', `/api/agents/${enc(agentId)}/docs`, { docId }),
};

/** Title from an uploaded file name: "CONVENTIONS.md" becomes "CONVENTIONS". */
export function titleFromFilename(name: string): string {
  const stem = name.replace(DOC_FILE_PATTERN, '').trim();
  return (stem || name).slice(0, 80);
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
}

/** Reads and checks an uploaded file client-side. Throws with an operator-facing message. */
export async function readDocFile(file: File): Promise<ContextDocInput> {
  if (!DOC_FILE_PATTERN.test(file.name)) throw new Error(`${file.name}: only .md, .markdown or .txt files can be added.`);
  if (file.size > MAX_DOC_BYTES) throw new Error(`${file.name} is larger than 200 KB.`);
  const content = await file.text();
  if (content.includes('\0')) throw new Error(`${file.name} is not a text file.`);
  return { title: titleFromFilename(file.name), filename: file.name, content };
}
