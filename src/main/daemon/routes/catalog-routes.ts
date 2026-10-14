// Skill catalogs over the daemon API, for Studio's skills browser and the
// terminal app.
//
//   GET /catalog/skills?url=           SKILLS_CATALOG_GET
//   GET /catalog/skills/package?url=   SKILLS_PACKAGE_GET
//
// Pure network reads through the shared catalog guard
// (services/skills-catalog-fetch.ts): https only, SSRF/egress guard (the
// daemon port included, so a redirect cannot reach this API), redirect hop
// cap, size ceiling and a 10 s budget on every hop. The URL is the one the
// owner configured (skillCatalogSources); as in Studio, no settings opt-out
// applies to these explicit reads.

import type { FastifyInstance } from 'fastify'
import { fetchSkillPackage, fetchSkillsCatalog } from '../../services/skills-catalog-fetch'
import type { DaemonRouteContext } from './index'

export function registerCatalogRoutes(server: FastifyInstance, _ctx: DaemonRouteContext): void {
  server.get<{ Querystring: { url?: string } }>('/catalog/skills', async (request) => fetchSkillsCatalog(request.query.url))

  server.get<{ Querystring: { url?: string } }>('/catalog/skills/package', async (request) => fetchSkillPackage(request.query.url))
}
