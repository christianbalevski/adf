// Side-effect module: the first import of every entrypoint (Studio main, the
// daemon, the CLI). Imports are evaluated in order, so this exits on a
// vulnerable runtime before any other module of the entry graph runs — before
// the database opens, a .adf is read or a response is decoded.
// See brotli-runtime-guard.ts.
import { exitIfUnsafeBrotliRuntime } from './brotli-runtime-guard'

exitIfUnsafeBrotliRuntime()
