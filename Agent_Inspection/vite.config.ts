import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const DAEMON = 'http://127.0.0.1:4317';

export default defineConfig({
  root: 'web',
  plugins: [react()],
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
