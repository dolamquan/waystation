import { useEffect, useRef, useState } from 'react';
import type { PDFDocumentProxy } from 'pdfjs-dist';

/** Pages rendered past this are skipped (a note says so); a huge PDF should be opened in a PDF reader. */
const MAX_PAGES = 300;
/** Pixels per PDF point: sharp when the tile is zoomed in, without huge canvases. */
const RENDER_SCALE = 2;
/** Letter-ish proportions for a page that has not been measured yet. */
const FALLBACK_RATIO = 1.294;

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

function bytesOf(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** PDF.js and its worker load only when a PDF is opened, so the rest of the app does not carry them. */
async function openPdf(base64: string): Promise<{ doc: PDFDocumentProxy; destroy: () => Promise<void> }> {
  const [pdfjs, worker] = await Promise.all([import('pdfjs-dist'), import('pdfjs-dist/build/pdf.worker.min.mjs?worker')]);
  // Vite owns the worker bundle and its URL; each document owns and closes its own worker.
  const port = new worker.default();
  // This PDF.js release's generated constructor type infers null, though its documented port accepts Worker.
  const pdfWorker = new pdfjs.PDFWorker({ port } as unknown as ConstructorParameters<typeof pdfjs.PDFWorker>[0]);
  const task = pdfjs.getDocument({ data: bytesOf(base64), worker: pdfWorker, cMapUrl: '/pdf-assets/cmaps/', cMapPacked: true,
    standardFontDataUrl: '/pdf-assets/fonts/', wasmUrl: '/pdf-assets/wasm/' });
  const destroy = async () => { try { await task.destroy(); } finally { pdfWorker.destroy(); port.terminate(); } };
  try { return { doc: await task.promise, destroy }; }
  catch (error) { await destroy(); throw error; }
}

/** One page: drawn onto a canvas the first time it scrolls into view. */
function PdfPage({ doc, number, ratio }: { readonly doc: PDFDocumentProxy; readonly number: number; readonly ratio: number }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [drawn, setDrawn] = useState(false);
  const [error, setError] = useState<string>();
  useEffect(() => {
    const element = canvas.current;
    if (!element || drawn) return undefined;
    let cancelled = false;
    let task: { cancel: () => void } | undefined;
    const draw = async () => {
      const page = await doc.getPage(number);
      if (cancelled) return;
      const viewport = page.getViewport({ scale: RENDER_SCALE });
      element.width = Math.floor(viewport.width);
      element.height = Math.floor(viewport.height);
      const render = page.render({ canvas: element, viewport });
      task = render;
      await render.promise;
      if (!cancelled) setDrawn(true);
    };
    const observer = new IntersectionObserver((entries) => {
      if (!entries.some((entry) => entry.isIntersecting)) return;
      observer.disconnect();
      draw().catch((failure) => { if (!cancelled) setError(messageOf(failure)); });
    }, { rootMargin: '400px' });
    observer.observe(element);
    return () => { cancelled = true; observer.disconnect(); task?.cancel(); };
  }, [doc, number, drawn]);
  return <div className="pdf-page-wrap">{error && <p role="alert" className="tile-error">Page {number} could not be rendered: {error}</p>}<canvas ref={canvas} className="pdf-page" aria-label={`Page ${number}`}
    style={drawn ? undefined : { aspectRatio: `1 / ${ratio}` }} /></div>;
}

/** A PDF drawn page by page with PDF.js (no browser plugin, so it works in the desktop app too). */
export function PdfView({ base64 }: { readonly base64: string }) {
  const [doc, setDoc] = useState<PDFDocumentProxy>();
  const [ratio, setRatio] = useState(FALLBACK_RATIO);
  const [error, setError] = useState<string>();
  useEffect(() => {
    let cancelled = false;
    let opened: Awaited<ReturnType<typeof openPdf>> | undefined;
    setDoc(undefined);
    setError(undefined);
    openPdf(base64).then(async (resource) => {
      opened = resource;
      if (cancelled) { void resource.destroy().catch(() => {}); return; }
      const first = (await resource.doc.getPage(1)).getViewport({ scale: 1 });
      if (!cancelled) { setRatio(first.height / first.width); setDoc(resource.doc); }
    }).catch((failure: unknown) => { if (!cancelled) setError(`This PDF could not be opened: ${messageOf(failure)}`); });
    return () => { cancelled = true; void opened?.destroy().catch(() => {}); };
  }, [base64]);

  if (error) return <p className="tile-error file-message" role="alert">{error}</p>;
  if (!doc) return <p className="tile-note file-message">Opening the PDF…</p>;
  const pages = Math.min(doc.numPages, MAX_PAGES);
  return <div className="pdf-view">
    {Array.from({ length: pages }, (_, index) => <PdfPage key={index} doc={doc} number={index + 1} ratio={ratio} />)}
    {doc.numPages > MAX_PAGES && <p className="tile-note file-message">Only the first {MAX_PAGES} of {doc.numPages} pages are shown.</p>}
  </div>;
}
