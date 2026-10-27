// Side-effect module: the only static import of every bundle entry (Studio
// main and the daemon: entry.ts; the CLI: cli/bin.ts), which load the rest
// with a dynamic import after it. A bundle requires every external module of
// its file at the top, so the rest must not be a static import: then this
// exits on a vulnerable runtime before any other module runs — before the
// database opens, a .adf is read or a response is decoded.
// See brotli-runtime-guard.ts.
import { exitIfUnsafeBrotliRuntime } from './brotli-runtime-guard'

exitIfUnsafeBrotliRuntime()
