import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { extname, isAbsolute, join, relative, resolve } from 'node:path';

/**
 * Images sent with a message. They are saved to disk and the message text carries
 * `[Image #N: <path>]` references, so one string travels through every delivery path
 * (queue, hooks, terminal). Managed runners turn the references back into real image
 * input; other sessions read the file at the path, as Claude Code does with a dropped file.
 */

export type ImageMediaType = 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp';

export interface ImageRef {
  readonly path: string;
  readonly mediaType: ImageMediaType;
}

export const MAX_IMAGES = 8;
/** Claude's API rejects images above 5 MB. */
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const PRUNE_AFTER_MS = 14 * 24 * 60 * 60 * 1000;

const EXTENSIONS: Readonly<Record<ImageMediaType, string>> = {
  'image/png': '.png', 'image/jpeg': '.jpg', 'image/gif': '.gif', 'image/webp': '.webp',
};
const BY_EXTENSION: Readonly<Record<string, ImageMediaType>> = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp',
};

export const IMAGE_NOTE = '(Images are attached as files at the paths above; open them to view them.)';
const REF_PATTERN = /\[Image #(\d+): ([^\]\r\n]+)\]/g;

export class AttachmentError extends Error {}

/** Detect the format from the file's own bytes: the declared type is not trusted. */
export function sniffImage(bytes: Buffer): ImageMediaType | undefined {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes.length >= 6 && /^GIF8[79]a$/.test(bytes.subarray(0, 6).toString('latin1'))) return 'image/gif';
  if (bytes.length >= 12 && bytes.subarray(0, 4).toString('latin1') === 'RIFF' && bytes.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  return undefined;
}

/** Validate `[{ data: base64 }]` from the API and save each image. Returns the saved files in order. */
export function saveImages(raw: unknown, dir: string): ImageRef[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) throw new AttachmentError('images must be a list.');
  if (raw.length > MAX_IMAGES) throw new AttachmentError(`Attach at most ${MAX_IMAGES} images per message.`);
  const decoded = raw.map((item: unknown, index) => {
    const data = item && typeof item === 'object' ? (item as Record<string, unknown>).data : undefined;
    if (typeof data !== 'string' || !data) throw new AttachmentError(`Image ${index + 1} has no data.`);
    const bytes = Buffer.from(data, 'base64');
    if (bytes.length > MAX_IMAGE_BYTES) throw new AttachmentError(`Image ${index + 1} is larger than 5 MB.`);
    const mediaType = sniffImage(bytes);
    if (!mediaType) throw new AttachmentError(`Image ${index + 1} is not a PNG, JPEG, GIF or WebP image.`);
    return { bytes, mediaType };
  });
  if (decoded.length) mkdirSync(dir, { recursive: true });
  return decoded.map(({ bytes, mediaType }) => {
    const path = join(dir, `${randomUUID()}${EXTENSIONS[mediaType]}`);
    writeFileSync(path, bytes, { flag: 'wx' });
    return { path, mediaType };
  });
}

/** The message as delivered: the operator's text, then one reference line per image. */
export function withImageRefs(text: string, images: readonly ImageRef[]): string {
  if (!images.length) return text;
  const refs = images.map((image, index) => `[Image #${index + 1}: ${image.path}]`).join('\n');
  return [text, refs, IMAGE_NOTE].filter(Boolean).join('\n\n');
}

function inside(dir: string, path: string): boolean {
  const rel = relative(resolve(dir), resolve(path));
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
}

/**
 * Split a message into display text (`[Image #N]` labels, no paths) and the images it
 * references. Only files in the attachments folder count, so message text can never make
 * a runner upload an arbitrary file from disk.
 */
export function extractImageRefs(text: string, dir: string): { text: string; images: ImageRef[] } {
  const images: ImageRef[] = [];
  const replaced = text.replace(REF_PATTERN, (match, label: string, rawPath: string) => {
    const path = rawPath.trim();
    const mediaType = BY_EXTENSION[extname(path).toLowerCase()];
    if (!mediaType || !inside(dir, path) || !existsSync(path)) return match;
    images.push({ path, mediaType });
    return `[Image #${label}]`;
  });
  if (!images.length) return { text, images };
  return { text: replaced.replace(IMAGE_NOTE, '').trim(), images };
}

/** Delete attachments older than two weeks; their messages were delivered long before. */
export function pruneAttachments(dir: string, now = Date.now()): number {
  if (!existsSync(dir)) return 0;
  let removed = 0;
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    try {
      if (now - statSync(path).mtimeMs > PRUNE_AFTER_MS) { unlinkSync(path); removed += 1; }
    } catch (error) {
      console.warn('[attachments] could not prune', path, (error as Error).message);
    }
  }
  return removed;
}

export const readImageBase64 = (image: ImageRef): string => readFileSync(image.path).toString('base64');
