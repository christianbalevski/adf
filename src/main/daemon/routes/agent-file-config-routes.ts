// An agent file's config by path, whether or not it is open here.
//
//   GET /files/agent/config?path=     { filePath, agentId, loaded, config }
//
// For a client that edits one part of a file's config through the
// path-addressed routes (W1-E, /files/agent/*) and must decide from what is
// there now, e.g. Studio's adapter attach, which turns on an adapter the
// agent already has and keeps its policy. A running agent or an open
// document answers its live config (the one GET /agents/:id/config
// answers); any other file is read through one readonly connection (no
// migration, nothing written). Same path rules as the other /files routes.
// The config holds no credential values: those are identity rows.

import type { FastifyInstance } from 'fastify'
import { AdfDatabase } from '../../adf/adf-database'
import type { AgentConfig } from '../../../shared/types/adf-v02.types'
import { FileOpError, requireAdfPath } from '../file-ops'
import { storedDirs } from '../tracked-dirs'
import type { DaemonRouteContext } from './index'

export function registerAgentFileConfigRoutes(server: FastifyInstance, ctx: DaemonRouteContext): void {
  const { runtime, options } = ctx
  const settings = options.settingsStore

  server.get<{ Querystring: { path?: string } }>('/files/agent/config', async (request, reply) => {
    try {
      const filePath = await requireAdfPath(request.query.path, { uncRoots: settings ? storedDirs(settings) : [] })
      const live = runtime.getAgentWorkspaceByPath(filePath)
      if (live) return { filePath, agentId: live.agentId, loaded: true, config: runtime.getAgentConfig(live.agentId).config }
      const config = AdfDatabase.peek(filePath, (db) => {
        const row = db.prepare('SELECT config_json FROM adf_config WHERE id = 1').get() as { config_json: string } | undefined
        if (!row) throw new FileOpError('Not a readable .adf: missing adf_config row', 400, 'not_an_adf')
        return JSON.parse(row.config_json) as AgentConfig
      })
      return { filePath, agentId: config.id ?? null, loaded: false, config }
    } catch (err) {
      if (err instanceof FileOpError) return reply.code(err.statusCode).send({ ...(err.details ?? {}), error: err.message, code: err.code })
      return reply.code(500).send({ error: err instanceof Error ? err.message : String(err), code: 'internal_error' })
    }
  })
}
