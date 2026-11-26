import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'

// noVNC (MPL-2.0, with vendored pako) ships minified in the Computer tab's
// chunk, its license headers stripped: say what it is and where its source is.
function noVncNotice(): Plugin {
  const dir = resolve(__dirname, 'node_modules/@novnc/novnc')
  return {
    name: 'adf-novnc-notice',
    apply: 'build',
    generateBundle() {
      const { version } = JSON.parse(readFileSync(resolve(dir, 'package.json'), 'utf8')) as { version: string }
      this.emitFile({
        type: 'asset',
        fileName: 'THIRD_PARTY_NOTICES.txt',
        source: [
          `noVNC ${version} (@novnc/novnc), used unmodified by the Computer tab.`,
          `Source: https://github.com/novnc/noVNC/tree/v${version}`,
          '', readFileSync(resolve(dir, 'LICENSE.txt'), 'utf8'),
          '', 'pako (vendored by noVNC):', '', readFileSync(resolve(dir, 'vendor/pako/LICENSE'), 'utf8'),
          // des.js keeps its BSD-style notices only in its header comment, which minifying drops.
          '', 'core/crypto/des.js:', '', /^\/\*[\s\S]*?\*\//.exec(readFileSync(resolve(dir, 'core/crypto/des.js'), 'utf8'))?.[0] ?? '',
        ].join('\n'),
      })
    },
  }
}

// The browser entry installs the transport, then loads Studio's renderer.
// All screens, styles, stores and API method mappings remain shared.
export default defineConfig({
  root: resolve(__dirname, 'src/web'),
  base: '/studio/',
  plugins: [react(), noVncNotice()],
  // noVNC (the Computer tab) uses top-level await.
  optimizeDeps: { esbuildOptions: { target: 'es2022' } },
  build: {
    target: 'es2022',
    outDir: resolve(__dirname, 'out/web'),
    emptyOutDir: true,
  },
  server: {
    host: '127.0.0.1',
    proxy: {
      // Preserve the browser origin/host for the daemon's same-origin checks.
      // ws: the Computer tab's stream (/web/desktop) is a WebSocket.
      '/web': { target: process.env.ADF_WEB_DAEMON_URL ?? 'http://127.0.0.1:7385', ws: true },
    },
  },
})
