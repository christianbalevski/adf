// Long-running work as jobs (daemon/jobs.ts).
//
//   GET  /jobs/:jobId          state, and the result once it finished
//   POST /jobs/:jobId/cancel   abort a running job
//
// Routes that start a job answer 202 { jobId, job }.

import type { FastifyInstance } from 'fastify'
import { jobsFor } from '../jobs'
import type { DaemonRouteContext } from './index'
import { notFound } from './route-helpers'

export function registerJobRoutes(server: FastifyInstance, ctx: DaemonRouteContext): void {
  const jobs = jobsFor(ctx.options)
  server.addHook('onClose', (_instance, done) => { jobs.cancelAll(); done() })

  server.get<{ Params: { jobId: string } }>('/jobs/:jobId', async (request, reply) => {
    const job = jobs.get(request.params.jobId)
    return job ?? notFound(reply, 'No such job (unknown, or finished more than 10 minutes ago)')
  })

  server.post<{ Params: { jobId: string } }>('/jobs/:jobId/cancel', async (request, reply) => {
    const job = jobs.get(request.params.jobId)
    if (!job) return notFound(reply, 'No such job (unknown, or finished more than 10 minutes ago)')
    const cancelled = jobs.cancel(job.id)
    return { cancelled, job: jobs.get(job.id) }
  })
}
