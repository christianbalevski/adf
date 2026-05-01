# Code Execution Environment

All code in ADF — whether run by `sys_code`, `sys_lambda`, trigger lambdas, timer lambdas, or API route handlers — executes inside a sandboxed environment built on Node.js Worker Threads and V8 VM Contexts.

## Execution Contexts

| Context | Entry Point | State Persistence | Authorization | Receives |
|---------|------------|-------------------|---------------|----------|
| `sys_code` | LLM calls the tool | Yes — same worker per agent, variables carry over | Always unauthorized | Raw code string |
| `sys_lambda` | LLM calls the tool | No — fresh VM context per call | HIL if target is authorized; otherwise unauthorized | `args` object via destructuring |
| Trigger lambda | System scope trigger fires | No — fresh VM context per call (unless `warm: true`) | Based on file's `authorized` flag | `event` object ([details](triggers.md#lambda-event-object)) |
| Timer lambda | `on_timer` system scope fires | No — fresh VM context per call (unless `warm: true`) | Based on file's `authorized` flag | `event` object ([details](timers.md#timer-lambda-execution)) |
| API route handler | HTTP request matches a route | No — fresh VM context per call (unless `warm: true`) | Based on file's `authorized` flag | `request` object ([details](serving.md#lambda-functions)) |
| Middleware lambda | Pipeline integration point fires | No — fresh VM context per call | Based on file's `authorized` flag | `input` object ([details](middleware.md#input)) |

All contexts have access to the [`adf` proxy object](adf-object.md) for calling tools, invoking the model (including multimodal content blocks — `image_url`, `input_audio`, `video_url` — for capable models; see [model_invoke](adf-object.md#model_invoke)), and running lambdas.

The **Authorization** column indicates whether the execution context can call [restricted tools and methods](authorized-code.md). `sys_code` always runs unauthorized — inline code has no provenance. When the LLM calls `sys_lambda` targeting an authorized file, the runtime triggers a HIL approval prompt; if approved, the lambda runs with authorization. Unauthorized targets run without authorization, no prompt needed. System-initiated contexts (triggers, timers, middleware) inherit authorization from the source file's `authorized` flag. See [Authorized Code Execution](authorized-code.md) for the full security model.

## Security Model

The sandbox is configured with:

```javascript
codeGeneration: { strings: false, wasm: true }
```

This disables:
- `eval()` and `new Function()` — no dynamic code generation from strings

WebAssembly is enabled to support standard library packages that use WASM (e.g., sql.js, mupdf).

Native `fetch` and related globals (`Request`, `Response`, `Headers`) are deleted from the worker scope on startup. All network access must go through `adf.sys_fetch()`, which routes through the agent's security middleware pipeline.

## Available Globals

The sandbox exposes a curated set of standard JavaScript globals:

**Core types:** `Array`, `Object`, `Map`, `Set`, `WeakMap`, `WeakSet`, `String`, `Number`, `Boolean`, `Symbol`, `BigInt`, `RegExp`

**Error types:** `Error`, `TypeError`, `RangeError`, `SyntaxError`, `URIError`, `ReferenceError`, `EvalError`

**Numbers and encoding:** `parseInt`, `parseFloat`, `isNaN`, `isFinite`, `NaN`, `Infinity`, `undefined`, `encodeURIComponent`, `decodeURIComponent`, `encodeURI`, `decodeURI`, `atob`, `btoa`

**Binary data:** `ArrayBuffer`, `SharedArrayBuffer`, `DataView`, `Uint8Array`, `Uint16Array`, `Uint32Array`, `Uint8ClampedArray`, `Int8Array`, `Int16Array`, `Int32Array`, `Float32Array`, `Float64Array`, `BigInt64Array`, `BigUint64Array`, `Buffer`

**Async and timing:** `Promise`, `setTimeout`, `clearTimeout`, `setInterval`, `clearInterval`, `queueMicrotask`

**Utilities:** `Math`, `Date`, `JSON`, `structuredClone`, `TextEncoder`, `TextDecoder`, `URL`, `URLSearchParams`

**ADF-specific:** `adf` (proxy object), `__require` (for allowed Node.js modules and standard library packages), `__stdlibPath` (base path for standard library packages on disk)

## Not Available

| Global | Reason | Alternative |
|--------|--------|-------------|
| `console` | Undefined in `sys_code` context (available in lambdas) | Use `adf.fs_write()` to persist output |
| `fetch` | Deleted on worker startup — no direct network access | `adf.sys_fetch()` |
| `eval` / `Function` | Disabled by `codeGeneration` policy | Write code directly |
| `require` / `import` | No arbitrary module loading | `import` from allowed modules and standard library (see below) |
| `process` | No access to host process | N/A |
| `__dirname` / `__filename` | No filesystem path context | N/A |

**Note:** Lambda contexts (`sys_lambda`, triggers, timers, API routes) **do** have `console.log`, `console.warn`, `console.error`, and `console.info` — output is captured and logged to `adf_logs`. The `sys_code` context does not have console by default but gets it injected per execution.

## Allowed Node.js Modules

You can use standard `import` syntax to load these built-in Node.js modules:

| Module | Use Case |
|--------|----------|
| `crypto` | Hashing, HMAC, random bytes, encryption |
| `buffer` | Binary data manipulation |
| `url` | URL parsing and formatting |
| `querystring` | Query string parsing |
| `path` | File path manipulation |
| `util` | Utility functions (inspect, format, promisify) |
| `string_decoder` | Buffer-to-string decoding |
| `punycode` | Unicode/ASCII domain encoding |
| `assert` | Assertions for validation |
| `events` | EventEmitter pattern |
| `stream` | Stream processing |
| `zlib` | Compression (gzip, deflate, brotli) |
| `os` | OS information (platform, arch, cpus) |

```javascript
import { createHash } from 'crypto'
import { join } from 'path'

const hash = createHash('sha256').update('hello').digest('hex')
const filePath = join('lib', 'utils.ts')
```

Importing any module not in this list (and not in the standard library or [custom packages](#custom-packages)) throws an error:
```
Module "fs" is not available in the sandbox. Available modules: crypto, buffer, url, ..., xlsx, pdf-lib, ...
```

## Standard Library Packages

In addition to Node.js built-in modules, the sandbox provides a curated set of npm packages for document processing, data manipulation, and image handling. These are always available — no configuration needed.

| Package | Version | Use Case |
|---------|---------|----------|
| `xlsx` | 0.18.5 | Read/write Excel spreadsheets (.xlsx, .xls, .csv) |
| `pdf-lib` | 1.17.1 | Create and modify PDF documents |
| `mupdf` | 0.3.0 | Parse and extract content from existing PDFs |
| `docx` | 9.0.2 | Generate Word documents (.docx) |
| `jszip` | 3.10.1 | Create and extract ZIP archives |
| `sql.js` | 1.11.0 | In-memory SQLite database (WebAssembly) |
| `cheerio` | 1.0.0 | Parse and manipulate HTML (jQuery-like API) |
| `yaml` | 2.6.0 | Parse and stringify YAML |
| `date-fns` | 4.1.0 | Date/time manipulation and formatting |
| `jimp` | 1.6.0 | Image processing (resize, crop, rotate, filters) |

All packages are pure JavaScript or WebAssembly — no native addons.

### Usage Examples

```javascript
// Parse an Excel file from the VFS
import { read, utils } from 'xlsx'
const file = await adf.fs_read({ path: 'data/report.xlsx' })
const buf = Buffer.from(file.content, 'base64')
const workbook = read(buf)
const sheet = workbook.Sheets[workbook.SheetNames[0]]
const rows = utils.sheet_to_json(sheet)

// Create a PDF
import { PDFDocument } from 'pdf-lib'
const doc = await PDFDocument.create()
const page = doc.addPage()
page.drawText('Hello from ADF')
const bytes = await doc.save()
await adf.fs_write({ mode: 'write', path: 'output.pdf', content: Buffer.from(bytes), mime_type: 'application/pdf' })

// Parse HTML
import * as cheerio from 'cheerio'
const resp = await adf.sys_fetch({ url: 'https://example.com' })
const $ = cheerio.load(resp.body)
const title = $('title').text()

// In-memory SQLite
import initSqlJs from 'sql.js'
const SQL = await initSqlJs()
const db = new SQL.Database()
db.run('CREATE TABLE test (id INTEGER PRIMARY KEY, name TEXT)')
db.run("INSERT INTO test VALUES (1, 'hello')")
const results = db.exec('SELECT * FROM test')

// Process images
import { Jimp } from 'jimp'
const imgFile = await adf.fs_read({ path: 'photo.png' })
const image = await Jimp.read(Buffer.from(imgFile.content, 'base64'))
image.resize({ w: 200, h: 200 })
const output = await image.getBuffer('image/png')
await adf.fs_write({ mode: 'write', path: 'thumb.png', content: output, mime_type: 'image/png' })

// Parse/stringify YAML
import YAML from 'yaml'
const config = YAML.parse('key: value\nlist:\n  - a\n  - b')
const yamlStr = YAML.stringify({ hello: 'world' })

// Date manipulation
import { format, addDays } from 'date-fns'
const tomorrow = format(addDays(new Date(), 1), 'yyyy-MM-dd')

// Read a PDF with mupdf
import mupdf from 'mupdf'
const pdfFile = await adf.fs_read({ path: 'document.pdf' })
const pdfDoc = mupdf.Document.openDocument(Buffer.from(pdfFile.content, 'base64'), 'application/pdf')
const pageCount = pdfDoc.countPages()
```

### First-Launch Install

Standard library packages are installed automatically on first launch to `~/.adf-studio/sandbox-stdlib/`. During the initial install (typically 1-2 minutes), attempting to import a stdlib package throws:

```
Module "xlsx" is not available. Standard library is still installing — try again shortly.
```

A progress banner appears in the UI during installation. Subsequent launches use the cached packages.

## Custom Packages

Beyond the standard library, agents can install additional npm packages using the [`npm_install`](tools.md#npm_install) tool. Packages must be pure JavaScript or WebAssembly — native addons are detected and blocked.

### Installing from Code

```javascript
// Agent installs a package (persisted to its config)
await adf.npm_install({ name: 'vega-lite', version: '^5.21.0' })
await adf.npm_install({ name: 'vega' })
await adf.npm_install({ name: '@resvg/resvg-wasm' })
```

Installed packages become importable on the **next turn**:

```javascript
import * as vl from 'vega-lite'
import * as vega from 'vega'
import { Resvg } from '@resvg/resvg-wasm'

const spec = { /* vega-lite spec */ }
const compiled = vl.compile(spec)
const view = new vega.View(vega.parse(compiled.spec), { renderer: 'none' })
const svg = await view.toSVG()

// SVG → PNG via WASM (auto-initialized, no initWasm() call needed)
const png = new Resvg(svg, { fitTo: { mode: 'width', value: 800 } }).render().asPng()
await adf.fs_write({ mode: 'write', path: 'chart.png', content: Buffer.from(png).toString('base64'), encoding: 'base64', mime_type: 'image/png' })
```

### Three Package Tiers

| Tier | Scope | Managed by |
|------|-------|------------|
| **Standard library** | All agents, always | Bundled with Studio |
| **Runtime packages** | All agents on this instance | User via Settings > Packages |
| **Agent packages** | Single agent | Agent via `npm_install` / agent config UI |

Module resolution follows this order: Node built-ins → stdlib → runtime packages → agent packages. If a package isn't in the agent's config or the runtime config, the import throws `MODULE_NOT_FOUND` even if the package is installed on disk.

### Runtime Packages

Runtime packages are configured in **Settings > Packages** and are available to every agent. Use this for packages you want globally available (e.g., charting libraries, data processing tools). Agents can also promote their own packages to runtime via the **Make Runtime** button in Settings.

### Limits

| Limit | Value |
|-------|-------|
| Per-package install size | 50 MB |
| Total user packages | 200 MB |
| Max packages per agent | 50 |

### WASM Auto-Initialization

Packages that use WebAssembly and export an `initWasm()` function (common for wasm-bindgen packages like `@resvg/resvg-wasm`) are auto-initialized during import. The sandbox detects the `.wasm` file in the package directory, reads it, and calls `initWasm(buffer)` before returning the module. No manual initialization is needed.

### First-Open Install Prompt

When opening an agent that declares packages in `code_execution.packages`, Studio checks if those packages are installed. Missing packages trigger a modal prompting the user to install them or skip.

## Import/Export Transforms

Before execution, the sandbox transforms modern JavaScript syntax:

**Imports** are converted to `await __require()` calls:
```javascript
// Written as:
import { createHash } from 'crypto'
import path from 'path'
import * as util from 'util'

// Transformed to:
const { createHash } = await __require('crypto')
const path = await __require('path')
const util = await __require('util')
```

The `await` is required for standard library packages that use ESM with top-level await (e.g., mupdf). For Node.js built-in modules, `__require()` resolves synchronously but the `await` is harmless.

**Exports** are stripped so functions/constants become context-accessible:
```javascript
// Written as:
export function process(data) { ... }
export const VERSION = '1.0'

// Transformed to:
function process(data) { ... }
const VERSION = '1.0'
```

This means you can write standard TypeScript/JavaScript modules and they work in the sandbox.

## The adf Object

Every execution context has access to the global `adf` proxy object. It provides an async RPC bridge to all enabled agent tools, the LLM model, the lambda execution engine, and the identity store. In addition to regular tools, the following **special methods** are available only from code execution (controlled via the Code Execution config): `model_invoke`, `sys_lambda`, `task_resolve`, `loop_inject`, `get_identity`. Additional methods are available exclusively from [authorized code](authorized-code.md): `set_meta_protection`, `set_file_protection` (and `sys_set_meta`/`sys_delete_meta` bypass protection checks when authorized).

### Bypassing Output Limits (`_full`)

Tools like `db_query` truncate their output by default to protect the LLM context window. Since code execution results go to your code (not the model), you can add `_full: true` to get the complete, untruncated result:

```javascript
const allRows = await adf.db_query({ sql: 'SELECT * FROM local_events', _full: true })
```

Note: `fs_read` always returns full content from code execution — no `_full` needed:

```javascript
const result = await adf.fs_read({ path: 'data/export.csv' })
const lines = result.content.split('\n')
```

This parameter is **only honored in code execution contexts** — the runtime strips it from direct LLM tool calls. See the [adf object reference](adf-object.md#full-output-_full) for details.

See the **[adf Proxy Object Reference](adf-object.md)** for the complete API.

## Console and Logging

Console behavior varies by context:

| Context | `console` Available | Output Destination |
|---------|--------------------|--------------------|
| `sys_code` | Yes (injected per execution) | Returned as `stdout` in tool result |
| `sys_lambda` | Yes | Returned as `stdout` in tool result, logged to `adf_logs` |
| Trigger lambdas | Yes | Logged to `adf_logs` |
| Timer lambdas | Yes | Logged to `adf_logs` |
| API route handlers | Yes | Logged to `adf_logs` with the `api_response` entry |

All console methods (`log`, `warn`, `error`, `info`) are captured. `warn` and `error` prefix output with `[warn]` and `[error]` respectively.

## Timeouts

| Setting | Value |
|---------|-------|
| Default timeout | 10 seconds |
| Maximum timeout | 300 seconds (5 minutes) |

The `sys_code` tool accepts an optional `timeout` parameter (in milliseconds) capped at the maximum. If execution exceeds the timeout, the operation fails with a `TIMEOUT` error code.

The worker itself has an additional 2-second buffer beyond the configured timeout to allow pending RPC round-trips to complete before the worker is forcibly terminated.

## State Persistence

**`sys_code`** uses a **persistent worker** per agent. Variables, functions, and state defined in one `sys_code` call carry over to the next. This makes it suitable for building up state incrementally:

```javascript
// First call
let counter = 0
function increment() { return ++counter }

// Second call — counter and increment() still exist
const val = increment() // returns 1
```

**`sys_lambda`**, **trigger lambdas**, **timer lambdas**, and **API route handlers** use **fresh VM contexts** by default. Each invocation starts clean with no leftover state.

**Warm mode:** Trigger targets, timers, and API routes can set `warm: true` to keep the sandbox worker alive between invocations. This trades isolation for performance — useful for frequently-firing triggers or high-traffic API endpoints. The sandbox IDs are:
- Trigger/timer lambdas: `{agentId}:lambda`
- API routes: `{agentId}:api`

## Error Handling

All `adf.*` calls can throw errors. Use `try`/`catch` to handle them:

```javascript
try {
  const data = await adf.fs_read({ path: 'config.json' })
  const config = JSON.parse(data)
} catch (err) {
  // err.code contains the error code (e.g., 'NOT_FOUND', 'TOOL_ERROR')
  // err.message contains a human-readable description
  await adf.fs_write({ path: 'errors.log', content: `Error: ${err.message}\n` })
}
```

The sandbox also fast-fails for certain conditions without making an RPC round-trip:

- **Disabled/unknown tools** — If the tool isn't in the agent's enabled set (and not `restricted`), throws immediately with code `NOT_FOUND`
- **Restricted tools** — Tools with `restricted: true` cannot be called from unauthorized code, throws with code `REQUIRES_AUTHORIZED_CODE`. Authorized code can call restricted tools directly (bypassing HIL).

See the [adf object error codes](adf-object.md#error-handling) for the complete list.

## Circular Call Detection

When `sys_lambda` calls another `sys_lambda` (via the `adf` proxy), the runtime tracks the call stack. If a circular call is detected (A calls B which calls A), execution fails immediately with a `CIRCULAR_CALL` error:

```
Circular sys_lambda detected: lib/a.ts:process → lib/b.ts:transform → lib/a.ts:process
```

This prevents infinite recursion between lambda functions.
