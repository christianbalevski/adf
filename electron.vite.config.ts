import { resolve } from 'node:path'
import { readFileSync } from 'node:fs'
import { build, defineConfig, externalizeDepsPlugin } from 'electron-vite'
import type { Plugin } from 'vite'
import react from '@vitejs/plugin-react'

const pkg = JSON.parse(readFileSync(resolve(__dirname, 'package.json'), 'utf-8')) as { version: string }

// The headless daemon (src/main/daemon/index.ts) ships as out/main/daemon.js;
// Studio runs it with ELECTRON_RUN_AS_NODE=1 (design daemon-backend.md §8.1).
//
// It is a second, separate main build (mode DAEMON_MODE) rather than a second
// rollup input of the Studio build: two inputs would move every module both
// graphs share into common chunks and change the order in which Studio's
// main-process modules run. This way out/main/index.js is byte-identical
// with or without the daemon entry.
const DAEMON_MODE = 'adf-daemon'

function daemonEntryPlugin(): Plugin {
  let building: Promise<void> | null = null
  return {
    name: 'adf-daemon-entry',
    apply: 'build',
    // writeBundle runs after every main build, including each rebuild under
    // `electron-vite dev`, so the daemon never lags behind Studio's main.
    async writeBundle() {
      if (building) return building
      // electron-vite's build() sets NODE_ENV and NODE_ENV_ELECTRON_VITE for
      // its own run; restore them so `electron-vite dev` keeps its values.
      const saved = { NODE_ENV: process.env.NODE_ENV, NODE_ENV_ELECTRON_VITE: process.env.NODE_ENV_ELECTRON_VITE }
      building = build({ configFile: resolve(__dirname, 'electron.vite.config.ts'), mode: DAEMON_MODE, ignoreConfigWarning: true })
        .finally(() => {
          for (const [key, value] of Object.entries(saved)) {
            if (value === undefined) delete process.env[key]
            else process.env[key] = value
          }
          building = null
        })
      return building
    }
  }
}

export default defineConfig(({ mode }) => {
  if (mode === DAEMON_MODE) {
    return {
      main: {
        plugins: [externalizeDepsPlugin()],
        define: { __ADF_VERSION__: JSON.stringify(pkg.version) },
        build: {
          // Studio's main build already wrote out/main.
          emptyOutDir: false,
          rollupOptions: {
            input: { daemon: resolve(__dirname, 'src/main/daemon/index.ts') },
            output: { chunkFileNames: 'daemon-chunks/[name]-[hash].js' }
          }
        }
      }
    }
  }
  return {
    main: {
      plugins: [externalizeDepsPlugin(), daemonEntryPlugin()]
    },
    preload: {
      plugins: [externalizeDepsPlugin()]
    },
    renderer: {
      plugins: [react()]
    }
  }
})
