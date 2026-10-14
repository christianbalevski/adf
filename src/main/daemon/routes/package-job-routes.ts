// Package installs as jobs, for clients that must not hold a request open
// for the whole install (Studio's Settings → MCP, channel adapters, the
// sandbox package dialog).
//
//   POST /admin/mcp/packages/npm/jobs      { package }             MCP_INSTALL_PACKAGE
//   POST /admin/mcp/packages/python/jobs   { package, version? }   MCP_INSTALL_PYTHON_PACKAGE
//   POST /admin/adapters/packages/jobs     { package }             ADAPTER_INSTALL_PACKAGE
//   POST /admin/sandbox/packages/jobs      { packages: [{ name, version }] }   SANDBOX_INSTALL_PACKAGES
//
// Each answers 202 { jobId, job } (daemon/jobs.ts); GET /jobs/:jobId carries
// the result, which is the answer Studio's install handler gives:
// `{ success: true, installed }` or `{ success: false, error }` (the error as
// String(error)), and for the sandbox `{ success: true, results }` with one
// entry per package, installed one after the other. A Python install
// downloads uv and Python first when they are missing, which can take longer
// than a client or proxy keeps a request open; the synchronous routes
// (POST /admin/mcp/packages/npm, …) stay for the CLI.
//
// Every progress line the installer reports is on the job (`progress`,
// `progressLog` with `detail.package`), and the client stream's install
// topics carry it too where the composition root wires them. While an
// install of the same package runs, a second request joins it
// (`job.joined`). An install cannot stop half-way: a cancelled job reads
// `cancelled` and the installer finishes on its own.

import type { FastifyInstance, FastifyReply } from 'fastify'
import { JobLimitError, jobsFor, type JobContext } from '../jobs'
import type { DaemonRouteContext } from './index'
import { tooManyJobs } from './mcp-admin-routes'
import { badRequest, stringParam, unavailable } from './route-helpers'

type InstallResult = { success: true; installed: unknown } | { success: false; error: string }

/** A single-package install: the installer's answer, or its error as Studio words it. */
async function installOne(pkg: string, ctx: JobContext, install: (onProgress: (message: string) => void) => Promise<unknown>): Promise<InstallResult> {
  try {
    const installed = await install((message) => ctx.setProgress(message, { package: pkg }))
    return { success: true, installed }
  } catch (error) {
    return { success: false, error: String(error) }
  }
}

export function registerPackageJobRoutes(server: FastifyInstance, ctx: DaemonRouteContext): void {
  const { options } = ctx
  const jobs = jobsFor(options)

  const start = (reply: FastifyReply, kind: string, key: string, run: (job: JobContext) => Promise<unknown>) => {
    try {
      const job = jobs.start(kind, run, { key })
      return reply.code(202).send({ jobId: job.id, job })
    } catch (err) {
      if (err instanceof JobLimitError) return tooManyJobs(reply, err)
      throw err
    }
  }

  server.post<{ Body: { package?: unknown } | null }>('/admin/mcp/packages/npm/jobs', async (request, reply) => {
    const service = options.mcpPackageService
    if (!service) return unavailable(reply, 'MCP npm package service is not configured.')
    const pkg = stringParam(request.body?.package)
    if (!pkg) return badRequest(reply, 'package is required')
    return start(reply, 'mcp.install.npm', pkg, (job) => installOne(pkg, job, (onProgress) => service.install(pkg, onProgress)))
  })

  server.post<{ Body: { package?: unknown; version?: unknown } | null }>('/admin/mcp/packages/python/jobs', async (request, reply) => {
    const service = options.mcpPythonPackageService
    if (!service) return unavailable(reply, 'MCP Python package service is not configured.')
    const pkg = stringParam(request.body?.package)
    if (!pkg) return badRequest(reply, 'package is required')
    const version = stringParam(request.body?.version)
    return start(reply, 'mcp.install.python', `${pkg}@${version ?? ''}`, (job) => installOne(pkg, job, (onProgress) => service.install(pkg, version, onProgress)))
  })

  server.post<{ Body: { package?: unknown } | null }>('/admin/adapters/packages/jobs', async (request, reply) => {
    const service = options.adapterPackageService
    if (!service) return unavailable(reply, 'Adapter package service is not configured.')
    const pkg = stringParam(request.body?.package)
    if (!pkg) return badRequest(reply, 'package is required')
    return start(reply, 'adapter.install', pkg, (job) => installOne(pkg, job, (onProgress) => service.install(pkg, onProgress)))
  })

  server.post<{ Body: { packages?: unknown } | null }>('/admin/sandbox/packages/jobs', async (request, reply) => {
    const service = options.sandboxPackageService
    if (!service) return unavailable(reply, 'Sandbox package service is not configured.')
    const raw = request.body?.packages
    if (!Array.isArray(raw)) return badRequest(reply, 'packages array is required')
    const packages: Array<{ name: string; version?: string }> = []
    for (const entry of raw) {
      const name = stringParam((entry as { name?: unknown } | null)?.name)
      const version = (entry as { version?: unknown } | null)?.version
      if (!name || (version !== undefined && typeof version !== 'string')) return badRequest(reply, 'packages entries need a name string and a version string')
      packages.push({ name, ...(typeof version === 'string' ? { version } : {}) })
    }
    const key = packages.map((p) => `${p.name}@${p.version ?? ''}`).sort().join(',')
    return start(reply, 'sandbox.install', key, async (job) => {
      const results: Record<string, { success: boolean; version?: string; error?: string }> = {}
      for (const pkg of packages) {
        try {
          const result = await service.install(pkg.name, pkg.version, (message) => job.setProgress(message, { package: pkg.name }))
          results[pkg.name] = { success: true, version: result.version }
        } catch (error) {
          results[pkg.name] = { success: false, error: String(error) }
        }
      }
      return { success: true, results }
    })
  })
}
