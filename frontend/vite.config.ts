import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Vite proxies /api -> :3000 in dev, then strips the /api prefix.
// In production the same Fastify server serves both API and built frontend.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://localhost:3000',
        changeOrigin: true,
      },
    },
  },
});
