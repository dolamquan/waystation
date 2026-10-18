import { useCallback, useEffect, useRef, useState } from 'react';

/** Matches the daemon: at most 8 images, each under Claude's 5 MB limit. */
export const MAX_IMAGES = 8;
const MAX_BYTES = 5 * 1024 * 1024;
/** Larger images are scaled down first; the models downsample beyond this anyway. */
const MAX_SIDE = 2000;
const NATIVE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
export const IMAGE_ACCEPT = 'image/png,image/jpeg,image/gif,image/webp,image/bmp';

export interface ImageAttachment {
  readonly id: string;
  readonly name: string;
  /** Object URL for the thumbnail; revoked when the image is removed. */
  readonly preview: string;
  /** Base64 without the data: prefix, as the daemon expects. */
  readonly data: string;
}

const toBase64 = (blob: Blob): Promise<string> => new Promise((resolve, reject) => {
  const reader = new FileReader();
  reader.onload = () => resolve(String(reader.result).replace(/^data:[^,]*,/, ''));
  reader.onerror = () => reject(reader.error ?? new Error('Could not read the image.'));
  reader.readAsDataURL(blob);
});

const canvasBlob = (canvas: HTMLCanvasElement, type: string, quality?: number): Promise<Blob | null> =>
  new Promise(resolve => canvas.toBlob(resolve, type, quality));

/** Keep small PNG/JPEG/GIF/WebP files as they are; scale and re-encode anything else. */
async function prepare(file: Blob): Promise<Blob> {
  if (file.type === 'image/gif') {
    if (file.size > MAX_BYTES) throw new Error('GIFs must be under 5 MB.');
    return file;
  }
  const bitmap = await createImageBitmap(file).catch(() => { throw new Error('That file is not an image this browser can read.'); });
  try {
    const scale = Math.min(1, MAX_SIDE / Math.max(bitmap.width, bitmap.height));
    if (scale === 1 && NATIVE_TYPES.has(file.type) && file.size <= MAX_BYTES) return file;
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    canvas.getContext('2d')?.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const png = await canvasBlob(canvas, 'image/png');
    if (png && png.size <= MAX_BYTES) return png;
    const jpeg = await canvasBlob(canvas, 'image/jpeg', 0.85);
    if (jpeg && jpeg.size <= MAX_BYTES) return jpeg;
    throw new Error('That image is too large to send, even scaled down.');
  } finally {
    bitmap.close();
  }
}

/** Images waiting to go with the next message: paste, drop or pick them, as in Claude Code. */
export function useImageAttachments() {
  const [images, setImages] = useState<readonly ImageAttachment[]>([]);
  const [error, setError] = useState<string>();
  const live = useRef(images);
  useEffect(() => { live.current = images; }, [images]);
  useEffect(() => () => live.current.forEach(image => URL.revokeObjectURL(image.preview)), []);

  const add = useCallback(async (files: readonly File[]): Promise<void> => {
    const candidates = files.filter(file => file.type.startsWith('image/'));
    if (!candidates.length) { if (files.length) setError('Only images can be attached.'); return; }
    setError(undefined);
    const room = MAX_IMAGES - live.current.length;
    if (room <= 0) { setError(`Attach at most ${MAX_IMAGES} images per message.`); return; }
    if (candidates.length > room) setError(`Only the first ${room} image${room === 1 ? '' : 's'} were attached (limit ${MAX_IMAGES}).`);
    const prepared = await Promise.allSettled(candidates.slice(0, room).map(async file => {
      const blob = await prepare(file);
      return { id: crypto.randomUUID(), name: file.name || 'Pasted image', preview: URL.createObjectURL(blob), data: await toBase64(blob) };
    }));
    const added = prepared.flatMap(result => (result.status === 'fulfilled' ? [result.value] : []));
    const failed = prepared.find((result): result is PromiseRejectedResult => result.status === 'rejected');
    if (failed) setError((failed.reason as Error).message);
    setImages(previous => [...previous, ...added].slice(0, MAX_IMAGES));
  }, []);

  const remove = useCallback((id: string) => {
    setImages(previous => {
      previous.filter(image => image.id === id).forEach(image => URL.revokeObjectURL(image.preview));
      return previous.filter(image => image.id !== id);
    });
    setError(undefined);
  }, []);

  const clear = useCallback(() => {
    setImages(previous => { previous.forEach(image => URL.revokeObjectURL(image.preview)); return []; });
    setError(undefined);
  }, []);

  return { images, error, add, remove, clear };
}
