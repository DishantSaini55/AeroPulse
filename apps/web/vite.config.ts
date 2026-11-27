import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

const visualTest = (globalThis as typeof globalThis & { process?: { env?: Record<string, string | undefined> } }).process?.env?.AEROPULSE_VISUAL_TEST === '1';
const apiProxyTarget = (globalThis as typeof globalThis & { process?: { env?: Record<string, string | undefined> } }).process?.env?.AEROPULSE_API_PROXY_TARGET ?? 'http://127.0.0.1:4000';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    proxy: {
      '/api': apiProxyTarget,
      ...(!visualTest ? { '/socket.io': { target: apiProxyTarget, ws: true } } : {}),
    },
  },
});
