import { existsSync, readdirSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { tempDir } from './helpers.ts';
import {
  AttachmentError, IMAGE_NOTE, MAX_IMAGES, extractImageRefs, pruneAttachments, saveImages, sniffImage, withImageRefs,
} from '../daemon/managed/attachments.ts';

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({ query: vi.fn() }));

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16]);
const png64 = PNG.toString('base64');

describe('sniffImage', () => {
  it('detects formats from the bytes, not the declared type', () => {
    expect(sniffImage(PNG)).toBe('image/png');
    expect(sniffImage(JPEG)).toBe('image/jpeg');
    expect(sniffImage(Buffer.from('GIF89a......'))).toBe('image/gif');
    expect(sniffImage(Buffer.from('RIFF\0\0\0\0WEBPVP8 '))).toBe('image/webp');
    expect(sniffImage(Buffer.from('<svg></svg>'))).toBeUndefined();
  });
});

describe('saveImages', () => {
  it('writes each image into the attachments folder with an extension matching its bytes', () => {
    const dir = tempDir();
    const saved = saveImages([{ data: png64 }, { data: JPEG.toString('base64') }], dir);
    expect(saved.map(image => image.mediaType)).toEqual(['image/png', 'image/jpeg']);
    expect(saved[0].path.startsWith(dir)).toBe(true);
    expect(saved[1].path.endsWith('.jpg')).toBe(true);
    expect(readFileSync(saved[0].path)).toEqual(PNG);
  });

  it('returns nothing when no images are sent', () => {
    expect(saveImages(undefined, tempDir())).toEqual([]);
  });

  it('rejects non-images, too many images and malformed input before writing anything', () => {
    const dir = tempDir();
    expect(() => saveImages([{ data: Buffer.from('#!/bin/sh').toString('base64') }], dir)).toThrow(AttachmentError);
    expect(() => saveImages(Array.from({ length: MAX_IMAGES + 1 }, () => ({ data: png64 })), dir)).toThrow(/at most/);
    expect(() => saveImages('nope', dir)).toThrow(AttachmentError);
    expect(() => saveImages([{ data: png64 }, {}], dir)).toThrow(/Image 2 has no data/);
    expect(existsSync(dir) ? readdirSync(dir) : []).toEqual([]);
  });
});

describe('image references', () => {
  it('round-trips: the delivered text carries paths, managed runners get labels and files back', () => {
    const dir = tempDir();
    const saved = saveImages([{ data: png64 }, { data: png64 }], dir);
    const delivered = withImageRefs('What is wrong here?', saved);
    expect(delivered).toContain(`[Image #1: ${saved[0].path}]`);
    expect(delivered).toContain(IMAGE_NOTE);

    const { text, images } = extractImageRefs(delivered, dir);
    expect(text).toBe('What is wrong here?\n\n[Image #1]\n[Image #2]');
    expect(images.map(image => image.path)).toEqual(saved.map(image => image.path));
  });

  it('sends image-only messages as just the labels', () => {
    const dir = tempDir();
    const saved = saveImages([{ data: png64 }], dir);
    expect(extractImageRefs(withImageRefs('', saved), dir).text).toBe('[Image #1]');
  });

  it('ignores references outside the attachments folder, so text cannot upload arbitrary files', () => {
    const dir = tempDir();
    const outside = join(tempDir(), 'secret.png');
    writeFileSync(outside, PNG);
    const message = `look [Image #1: ${outside}] and [Image #2: ${join(dir, '..', 'x.png')}]`;
    expect(extractImageRefs(message, dir)).toEqual({ text: message, images: [] });
  });

  it('leaves text without references unchanged', () => {
    expect(extractImageRefs('plain [Image #1] text', tempDir())).toEqual({ text: 'plain [Image #1] text', images: [] });
  });
});

describe('pruneAttachments', () => {
  it('removes only files older than two weeks', () => {
    const dir = tempDir();
    const [old, fresh] = saveImages([{ data: png64 }, { data: png64 }], dir);
    const monthAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    utimesSync(old.path, monthAgo, monthAgo);
    expect(pruneAttachments(dir)).toBe(1);
    expect(existsSync(old.path)).toBe(false);
    expect(existsSync(fresh.path)).toBe(true);
  });
});

describe('runner integration', () => {
  it('Claude: turns references into base64 image blocks followed by the text', async () => {
    const { userMessage } = await import('../daemon/managed/claudeRunner.ts');
    const dir = tempDir();
    const saved = saveImages([{ data: png64 }], dir);
    const message = userMessage(withImageRefs('fix this', saved), dir);
    expect(message.message.content).toEqual([
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: png64 } },
      { type: 'text', text: 'fix this\n\n[Image #1]' },
    ]);
    expect(userMessage('just text', dir).message.content).toBe('just text');
  });

  it('Codex: passes each image with --image= before the stdin marker', async () => {
    const { codexArgs } = await import('../daemon/managed/codexRunner.ts');
    const launch = { vendor: 'codex' as const, cwd: 'C:/proj', prompt: '' };
    const args = codexArgs('codex.js', launch, 'thread-1', ['C:/a.png', 'C:/b.jpg']);
    expect(args).toContain('--image=C:/a.png');
    expect(args).toContain('--image=C:/b.jpg');
    expect(args.at(-1)).toBe('-');
    expect(codexArgs('codex.js', launch).some(arg => arg.startsWith('--image'))).toBe(false);
  });
});
