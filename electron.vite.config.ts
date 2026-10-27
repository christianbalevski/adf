import { dirname, resolve } from 'node:path'
import { readFileSync } from 'node:fs'
import { build, defineConfig, externalizeDepsPlugin, type UserConfig } from 'electron-vite'
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
  // Studio's resolved main outDir (`<outDir>/main`, honouring --outDir); the
  // daemon is written next to it.
  let mainOutDir = resolve(__dirname, 'out', 'main')
  let building: Promise<void> | null = null
  let rebuildQueued = false
  const buildDaemon = async (): Promise<void> => {
    // electron-vite's build() sets NODE_ENV and NODE_ENV_ELECTRON_VITE for
    // its own run; restore them so `electron-vite dev` keeps its values.
    const saved = { NODE_ENV: process.env.NODE_ENV, NODE_ENV_ELECTRON_VITE: process.env.NODE_ENV_ELECTRON_VITE }
    try {
      // electron-vite maps build.outDir X to X/main for the main build.
      await build({ configFile: resolve(__dirname, 'electron.vite.config.ts'), mode: DAEMON_MODE, ignoreConfigWarning: true, build: { outDir: dirname(mainOutDir) } })
    } finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
    }
  }
  return {
    name: 'adf-daemon-entry',
    apply: 'build',
    configResolved(config) {
      mainOutDir = resolve(config.root, config.build.outDir)
    },
    // writeBundle runs after every main build, including each rebuild under
    // `electron-vite dev`, so the daemon never lags behind Studio's main. A
    // main rebuild that lands while the daemon builds queues one more daemon
    // build after it (several collapse into one).
    async writeBundle() {
      if (building) {
        rebuildQueued = true
        return building
      }
      building = (async () => {
        do {
          rebuildQueued = false
          await buildDaemon()
        } while (rebuildQueued)
      })().finally(() => { building = null })
      return building
    }
  }
}

// Studio main and the daemon each start at a bootstrap entry (src/main/entry.ts,
// src/main/daemon/entry.ts) that checks the runtime and then imports the app.
// The app's chunk is written next to the entry, not under chunks/: its code
// resolves the preload, renderer, resources and daemon.js from __dirname.
function appChunkNames(app: string, name: string, others: string): (chunk: { moduleIds: string[] }) => string {
  return (chunk) => (chunk.moduleIds.includes(app) ? name : others)
}

export default defineConfig(({ mode }): UserConfig => {
  if (mode === DAEMON_MODE) {
    return {
      main: {
        plugins: [externalizeDepsPlugin()],
        define: { __ADF_VERSION__: JSON.stringify(pkg.version) },
        build: {
          // Studio's main build already wrote out/main.
          emptyOutDir: false,
          rollupOptions: {
            input: { daemon: resolve(__dirname, 'src/main/daemon/entry.ts') },
            output: { chunkFileNames: appChunkNames(resolve(__dirname, 'src/main/daemon/index.ts'), 'daemon-main.js', 'daemon-chunks/[name]-[hash].js') }
          }
        }
      }
    }
  }
  return {
    main: {
      plugins: [externalizeDepsPlugin(), daemonEntryPlugin()],
      build: {
        // A bootstrap entry: out/main/index.js checks the runtime before the app loads (src/main/entry.ts).
        rollupOptions: {
          input: { index: resolve(__dirname, 'src/main/entry.ts') },
          output: { chunkFileNames: appChunkNames(resolve(__dirname, 'src/main/index.ts'), 'studio-main.js', 'chunks/[name]-[hash].js') }
        }
      }
    },
    preload: {
      plugins: [externalizeDepsPlugin()]
    },
    renderer: {
      plugins: [react()]
    }
  }
})
