import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { resolve, extname } from 'node:path';

/** PDF fonts, character maps and image decoders stay local in dev and packaged desktop builds. */
function pdfAssets() {
  const folders = { fonts: 'standard_fonts', cmaps: 'cmaps', wasm: 'wasm' } as const;
  const types: Record<string, string> = { '.wasm': 'application/wasm', '.mjs': 'text/javascript', '.ttf': 'font/ttf' };
  return {
    name: 'local-pdf-assets',
    configureServer(server: import('vite').ViteDevServer) {
      server.middlewares.use('/pdf-assets', (req, res, next) => {
        const match = /^\/(fonts|cmaps|wasm)\/([a-zA-Z0-9_.-]+)$/.exec((req.url ?? '').split('?')[0]);
        if (!match) return next();
        const file = resolve('node_modules/pdfjs-dist', folders[match[1] as keyof typeof folders], match[2]);
        if (!existsSync(file)) return next();
        res.setHeader('content-type', types[extname(file)] ?? 'application/octet-stream'); res.end(readFileSync(file));
      });
    },
    generateBundle(this: { emitFile: (asset: { type: 'asset'; fileName: string; source: Buffer }) => unknown }) {
      for (const [key, folder] of Object.entries(folders)) for (const name of readdirSync(resolve('node_modules/pdfjs-dist', folder))) {
        if (/\.(?:bcmap|pfb|ttf|wasm|mjs)$/.test(name)) this.emitFile({ type: 'asset', fileName: `pdf-assets/${key}/${name}`, source: readFileSync(resolve('node_modules/pdfjs-dist', folder, name)) });
      }
    },
  };
}

const DAEMON = 'http://127.0.0.1:4317';

export default defineConfig({
  root: 'web',
  plugins: [react(), pdfAssets()],
  build: { outDir: 'dist', emptyOutDir: true },
  server: {
    port: 5173,
    strictPort: true,
    host: '127.0.0.1',
    proxy: {
      '/api': { target: DAEMON, changeOrigin: true },
      '/ws': { target: DAEMON, changeOrigin: true, ws: true },
    },
  },
});
