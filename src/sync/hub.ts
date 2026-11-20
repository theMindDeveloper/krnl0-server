// Live change notices over WebSocket (F10, F14, Decision S9). Writes go over
// HTTP; this channel only says what changed, so a client re-reads it.

import { randomBytes } from 'node:crypto'
import type { IncomingMessage } from 'node:http'
import type { Duplex } from 'node:stream'
import { WebSocketServer, type WebSocket } from 'ws'
import { z } from 'zod'
import { PROTOCOL, VERSION } from '../version.js'
import type { DocChange } from '../store/docs.js'
import type { TimelogChange } from '../store/timelog.js'
import type { AssetChange } from '../store/assets.js'

export type Change = DocChange | TimelogChange | AssetChange

export const MAX_WS_MESSAGE = 64 * 1024
const HEARTBEAT_MS = 30_000
const HELLO_TIMEOUT_MS = 10_000

/** Who a connection belongs to; re-checked on every heartbeat so a revoke closes it. */
export interface WsPrincipal { kind: 'session' | 'device'; id: string; stillValid: () => boolean }

const helloSchema = z.object({
  type: z.literal('hello'),
  protocol: z.number().int(),
  client: z.enum(['web', 'desktop']),
  version: z.string().max(40).optional(),
})

interface Conn { id: string; ws: WebSocket; principal: WsPrincipal; ready: boolean; alive: boolean }

export class SyncHub {
  private readonly wss = new WebSocketServer({ noServer: true, maxPayload: MAX_WS_MESSAGE, perMessageDeflate: false })
  private readonly conns = new Map<string, Conn>()
  private readonly timer: NodeJS.Timeout

  constructor(private readonly info: () => { timeZone: string }) {
    this.timer = setInterval(() => this.heartbeat(), HEARTBEAT_MS)
    this.timer.unref()
  }

  get size(): number { return this.conns.size }

  /** Completes an upgrade the caller has already authenticated. */
  accept(req: IncomingMessage, socket: Duplex, head: Buffer, principal: WsPrincipal): void {
    this.wss.handleUpgrade(req, socket, head, (ws) => this.attach(ws, principal))
  }

  private attach(ws: WebSocket, principal: WsPrincipal): void {
    const conn: Conn = { id: randomBytes(9).toString('base64url'), ws, principal, ready: false, alive: true }
    this.conns.set(conn.id, conn)
    const helloTimer = setTimeout(() => { if (!conn.ready) ws.close(4002, 'hello expected') }, HELLO_TIMEOUT_MS)
    ws.on('pong', () => { conn.alive = true })
    ws.on('close', () => { clearTimeout(helloTimer); this.conns.delete(conn.id) })
    ws.on('error', () => { /* closed below by ws */ })
    ws.on('message', (data, isBinary) => {
      if (isBinary) { ws.close(1003, 'text only'); return }
      let msg: unknown
      try { msg = JSON.parse(data.toString()) } catch { ws.close(1007, 'bad json'); return }
      if (!conn.ready) {
        const hello = helloSchema.safeParse(msg)
        if (!hello.success) { ws.close(4002, 'hello expected'); return }
        if (hello.data.protocol !== PROTOCOL) {
          const older = hello.data.protocol < PROTOCOL
          this.send(ws, {
            type: 'error',
            code: 'protocol',
            message: older
              ? `This server speaks protocol ${PROTOCOL}; update the KRNL0 app.`
              : `This app speaks protocol ${hello.data.protocol}; update the KRNL0 server (krnl0 update or docker compose pull).`,
            serverProtocol: PROTOCOL,
          })
          ws.close(4000, 'protocol')
          return
        }
        conn.ready = true
        clearTimeout(helloTimer)
        this.send(ws, { type: 'hello', protocol: PROTOCOL, version: VERSION, connectionId: conn.id, timeZone: this.info().timeZone, serverTime: Date.now() })
        return
      }
      const ping = z.object({ type: z.literal('ping') }).safeParse(msg)
      if (ping.success) this.send(ws, { type: 'pong', at: Date.now() })
    })
  }

  private send(ws: WebSocket, body: unknown): void {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(body))
  }

  broadcast(change: Change): void {
    for (const c of this.conns.values()) if (c.ready) this.send(c.ws, { type: 'change', ...change })
  }

  /** Tells every tab to reload (a new server version is about to run). */
  notify(body: Record<string, unknown>): void {
    for (const c of this.conns.values()) if (c.ready) this.send(c.ws, body)
  }

  private heartbeat(): void {
    for (const c of this.conns.values()) {
      if (!c.principal.stillValid()) { c.ws.close(4001, 'signed out'); continue }
      if (!c.alive) { c.ws.terminate(); continue }
      c.alive = false
      c.ws.ping()
    }
  }

  /** Closes the connections of one session or device right away (revoke). */
  closeFor(kind: 'session' | 'device', id: string): void {
    for (const c of this.conns.values()) if (c.principal.kind === kind && c.principal.id === id) c.ws.close(4001, 'signed out')
  }

  close(): void {
    clearInterval(this.timer)
    for (const c of this.conns.values()) c.ws.close(1001, 'server stopping')
    this.wss.close()
  }
}
