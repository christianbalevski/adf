/**
 * Networking commands: curl, wget
 */

import type { CommandHandler, CommandContext, CommandResult } from './types'
import { ok, err } from './types'
import type { ArgumentNode } from '../parser/ast'

/** Normalize a path for VFS: strip leading ./ and / */
function vfsPath(p: string): string {
  if (p === '.' || p === './' || p === '/') return ''
  return p.replace(/^\.\//, '').replace(/^\//, '')
}

/** Static value of an arg for pre-gate inspection: literal or fully-literal
 *  quoted string; null for variables/substitutions (not statically knowable). */
function staticArgValue(arg: ArgumentNode): string | null {
  if (arg.type === 'literal') return arg.value
  if (arg.type === 'quoted' && arg.parts.length === 1 && arg.parts[0].type === 'literal') return arg.parts[0].value
  return null
}

const curlHandler: CommandHandler = {
  name: 'curl',
  aliases: ['wget'],
  summary: 'HTTP requests',
  helpText: [
    'curl <url>                   GET request',
    'curl -X POST -d \'data\' <url> POST with body',
    'curl -H "Header: Value" <url> Custom headers',
    'curl -o <path> <url>         Save response BODY to file',
    '',
    'This is a wrapper over the sys_fetch tool, not real curl. Default stdout',
    'is a JSON envelope {status,statusText,headers,body}, NOT the raw body.',
    "Idioms:  curl -s url | jq -r .body     curl -s url | jq .status",
    'Binary responses carry a base64 body plus "_body_encoding": "base64".',
    '',
    'Options:',
    '  -X <method>                HTTP method',
    '  -H <header>                Add header (repeatable)',
    '  -d <data>                  Request body',
    '  -o <path>                  Save the raw response body (only) to a VFS',
    '                             file; a one-line saved note goes to stderr',
    '                             unless -s. Base64 bodies are saved as-is.',
    '  -O <path>                  Same as -o (wget compat)',
    '  -s                         Silent: suppress the -o saved note',
    '  -w <fmt>                   Write-out after the output; supports ONLY',
    '                             %{http_code} (plus \\n/\\t/\\r escapes) —',
    '                             any other %{var} is an error',
    '  -v                         NOT supported (errors) — the envelope already',
    "                             has it: curl -s url | jq '{status,headers}'",
  ].join('\n'),
  category: 'network',
  resolvedTools: ['sys_fetch'],
  // -o/-O writes the response into the VFS via fs_write — surface that to the
  // pre-gate so disabling fs_write actually blocks `curl -o` (it previously
  // wrote ungated). Matches -o, -O, and the attached form -opath; a flag we
  // can't see statically (e.g. a variable) stays sys_fetch-only.
  resolveToolsFromArgs(args: ArgumentNode[]): string[] {
    const hasOutputFlag = args.some(a => {
      const v = staticArgValue(a)
      return v !== null && /^-[oO]/.test(v)
    })
    return hasOutputFlag ? ['fs_write'] : []
  },
  valueFlags: new Set(['X', 'H', 'd', 'o', 'O', 'w']),

  async execute(ctx: CommandContext): Promise<CommandResult> {
    const url = ctx.args[ctx.args.length - 1]
    if (!url) return err('curl: missing URL')

    const method = (ctx.flags.X as string) ?? (ctx.flags.d ? 'POST' : 'GET')
    const body = ctx.flags.d as string | undefined
    const outputPath = (ctx.flags.o ?? ctx.flags.O) as string | undefined
    const silent = !!ctx.flags.s
    const verbose = !!ctx.flags.v
    const writeOut = typeof ctx.flags.w === 'string' ? ctx.flags.w : undefined

    // Parse headers
    const headers: Record<string, string> = {}
    const headerFlag = ctx.flags.H
    if (headerFlag) {
      const headerList = Array.isArray(headerFlag) ? headerFlag : [headerFlag as string]
      for (const h of headerList) {
        const colonIdx = h.indexOf(':')
        if (colonIdx > 0) {
          headers[h.slice(0, colonIdx).trim()] = h.slice(colonIdx + 1).trim()
        }
      }
    }

    // Use stdin as body if -d not specified and stdin present
    const requestBody = body ?? (ctx.stdin || undefined)

    const input: Record<string, unknown> = {
      url,
      method: method.toUpperCase(),
    }
    if (Object.keys(headers).length > 0) input.headers = headers
    if (requestBody) input.body = requestBody

    // -v would need to print request/response wire traffic like real curl; a
    // half-faithful envelope dump is worse than a plain refusal. Fail BEFORE
    // the fetch so no side effect happens on an unsupported invocation.
    if (verbose) {
      return err("curl: -v is not supported in adf_shell — the default stdout envelope already carries it: curl -s url | jq '{status,headers}'")
    }

    const result = await ctx.toolRegistry.executeTool('sys_fetch', input, ctx.workspace)
    if (result.isError) return err(`curl: ${result.content}`)

    // Parse the sys_fetch envelope {status,statusText,headers,body} for -o/-w.
    // Default stdout stays the RAW envelope string, unchanged — agents rely on
    // `curl -s url | jq -r .body`.
    let envelope: { status?: number; body?: string } | null = null
    try {
      const parsed = JSON.parse(result.content)
      if (parsed && typeof parsed === 'object') envelope = parsed
    } catch { /* non-JSON tool output; envelope-dependent flags error below */ }

    // -w: interpolate BEFORE writing/printing anything — an unsupported token
    // must produce a plain error, never partial/garbled output.
    let writeOutText = ''
    if (writeOut !== undefined) {
      if (!envelope || typeof envelope.status !== 'number') {
        return err('curl: -w: response envelope has no status to report')
      }
      const unsupported: string[] = []
      writeOutText = writeOut
        .replace(/%\{([^}]*)\}/g, (_m, name: string) => {
          if (name === 'http_code') return String(envelope!.status)
          unsupported.push(name)
          return ''
        })
        .replace(/\\n/g, '\n').replace(/\\t/g, '\t').replace(/\\r/g, '\r')
      if (unsupported.length > 0) {
        return err(`curl: -w: %{${unsupported[0]}} is not supported in adf_shell — only %{http_code} is`)
      }
    }

    // -o: write the raw response BODY only — not the JSON envelope. (Binary
    // responses arrive base64-encoded with _body_encoding: "base64" and are
    // saved as-is.) Falls back to the raw content only if there is no body
    // string to extract (e.g. non-envelope tool output).
    if (outputPath) {
      // Same target semantics as shell redirects: normalize through vfsPath so
      // the written key is visible/removable under the same name (`-o /tmp/x`
      // must not create a literal "/tmp/x" key), /dev/null discards, and other
      // /dev/* targets are rejected plainly.
      const normalizedPath = vfsPath(outputPath)
      if (normalizedPath === 'dev/null') {
        return { exit_code: 0, stdout: writeOutText, stderr: '' }
      }
      if (normalizedPath === 'dev/stdout' || normalizedPath === 'dev/stderr') {
        return err(`curl: -o ${outputPath} is not supported in adf_shell — omit -o and pipe stdout instead`)
      }
      const fileContent = envelope && typeof envelope.body === 'string' ? envelope.body : result.content
      const write = await ctx.toolRegistry.executeTool('fs_write', {
        mode: 'write',
        path: normalizedPath,
        content: fileContent
      }, ctx.workspace)
      if (write.isError) return err(`curl: -o ${outputPath}: ${write.content}`)
      return {
        exit_code: 0,
        stdout: writeOutText,
        // Real curl keeps stdout clean and reports progress on stderr; -s silences it.
        stderr: silent ? '' : `curl: saved response body to ${outputPath} (${Buffer.byteLength(fileContent, 'utf8')} bytes)`,
      }
    }

    return ok(result.content + writeOutText)
  }
}

export const networkingHandlers: CommandHandler[] = [curlHandler]
