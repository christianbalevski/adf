// The Computer tab of a remote client: an agent container's noVNC desktop,
// relayed through this daemon so the client never needs a tunnel.
//
//   GET /compute/desktop/:container/websockify   the VNC stream (WebSocket)
//   GET /compute/desktop/:container/*            noVNC's page and scripts
//
// The container's noVNC port stays on this host's loopback; these routes are
// authenticated like every other route (request-guard.ts), so a remote
// listener serves them only to a paired device. Studio points its viewer at a
// loopback relay of its own that forwards here (daemon-mode/remote/desktop-relay.ts).

import fastifyWebsocket from '@fastify/websocket'
import type { FastifyInstance } from 'fastify'
import WebSocket from 'ws'
import { pipeWebSockets } from '../../services/ws-pipe'
import type { DaemonRouteContext } from './index'

interface DesktopCapable {
  getNovncHostPort?(containerName: string): Promise<number | null>
}

/** An agent container's name (isolatedContainerName); nothing else is relayed. */
const CONTAINER = /^adf-[a-z0-9][a-z0-9_-]{0,80}$/i

export function registerComputeDesktopRoutes(server: FastifyInstance, ctx: DaemonRouteContext): void {
  const novncPort = async (container: string): Promise<number | null> => {
    if (!CONTAINER.test(container)) return null
    const service = ctx.options.computeService as DesktopCapable | undefined
    return (await service?.getNovncHostPort?.(container)) ?? null
  }

  // Its own context: @fastify/websocket must be registered before the routes that use it.
  void server.register(async (app) => {
    await app.register(fastifyWebsocket)

    app.get<{ Params: { container: string } }>('/compute/desktop/:container/websockify', { websocket: true }, (socket, request) => {
      void (async () => {
        const port = await novncPort(request.params.container)
        if (port === null) { socket.close(1008, 'No desktop for this container'); return }
        pipeWebSockets(socket, new WebSocket(`ws://127.0.0.1:${port}/websockify`, socket.protocol ? [socket.protocol] : []))
      })().catch(() => socket.terminate())
    })

    app.get<{ Params: { container: string; '*': string } }>('/compute/desktop/:container/*', async (request, reply) => {
      const port = await novncPort(request.params.container)
      if (port === null) return reply.code(404).send({ error: 'No desktop for this container', code: 'not_found' })
      const segments = request.params['*'].split('/')
      if (segments.some((s) => s === '..' || s === '.')) return reply.code(400).send({ error: 'Bad path', code: 'bad_request' })
      const path = segments.map(encodeURIComponent).join('/')
      let res: Response
      try {
        res = await fetch(`http://127.0.0.1:${port}/${path}`, { redirect: 'manual' })
      } catch {
        return reply.code(503).send({ error: 'The container\'s display is not answering yet', code: 'unavailable' })
      }
      const type = res.headers.get('content-type')
      if (type) reply.header('content-type', type)
      return reply.code(res.status).header('cache-control', 'no-store').send(Buffer.from(await res.arrayBuffer()))
    })
  })
}
