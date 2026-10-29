import { resolve } from 'node:path'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// The browser entry installs the transport, then loads Studio's renderer.
// All screens, styles, stores and API method mappings remain shared.
export default defineConfig({
  root: resolve(__dirname, 'src/web'),
  base: '/studio/',
  plugins: [react()],
  build: {
    outDir: resolve(__dirname, 'out/web'),
    emptyOutDir: true,
  },
  server: {
    host: '127.0.0.1',
    proxy: {
      // Preserve the browser origin/host for the daemon's same-origin checks.
      '/web': { target: process.env.ADF_WEB_DAEMON_URL ?? 'http://127.0.0.1:7385' },
    },
  },
})
