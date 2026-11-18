import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// bb.js ships wasm workers that the dep pre-bundler would break, and needs cross-origin isolation for threads.
const isolation = { 'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'require-corp' };

export default defineConfig({
  plugins: [react()],
  // noir_js is only imported when someone proves a claim; pre-bundling it up front avoids a reload at that moment.
  optimizeDeps: { exclude: ['@aztec/bb.js'], include: ['@noir-lang/noir_js'] },
  build: { target: 'esnext' },
  server: { headers: isolation, proxy: { '/api': `http://127.0.0.1:${process.env.ZKDB_API_PORT ?? 8788}` } },
  preview: { headers: isolation },
});
