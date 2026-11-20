import type { IncomingMessage, ServerResponse } from 'node:http'
import type { ZodType } from 'zod'

export class HttpError extends Error {
  constructor(readonly status: number, readonly code: string, message: string, readonly extra: Record<string, unknown> = {}) {
    super(message)
  }
}

export function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body)
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.setHeader('Cache-Control', 'no-store')
  res.setHeader('Content-Length', Buffer.byteLength(text))
  res.end(text)
}

export function sendError(res: ServerResponse, err: HttpError): void {
  sendJson(res, err.status, { error: { code: err.code, message: err.message, ...err.extra } })
}

/** The whole body, refusing anything over `limit` bytes. */
export function readBody(req: IncomingMessage, limit: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers['content-length'] ?? '0')
    if (declared > limit) {
      reject(new HttpError(413, 'too-large', 'The request is too large.'))
      req.resume()
      return
    }
    const chunks: Buffer[] = []
    let size = 0
    let done = false
    req.on('data', (c: Buffer) => {
      if (done) return
      size += c.length
      if (size > limit) {
        done = true
        reject(new HttpError(413, 'too-large', 'The request is too large.'))
        req.resume()
        return
      }
      chunks.push(c)
    })
    req.on('end', () => { if (!done) { done = true; resolve(Buffer.concat(chunks)) } })
    req.on('error', (e) => { if (!done) { done = true; reject(e) } })
  })
}

export async function readJsonBody<T>(req: IncomingMessage, schema: ZodType<T>, limit = 64 * 1024): Promise<T> {
  const type = String(req.headers['content-type'] ?? '')
  if (!type.toLowerCase().startsWith('application/json')) throw new HttpError(415, 'json-only', 'Send JSON (Content-Type: application/json).')
  const buf = await readBody(req, limit)
  let value: unknown
  try { value = JSON.parse(buf.toString('utf8')) } catch { throw new HttpError(400, 'bad-json', 'The body is not valid JSON.') }
  const parsed = schema.safeParse(value)
  if (!parsed.success) throw new HttpError(400, 'invalid', 'The request is not in the expected shape.', { issues: parsed.error.issues.slice(0, 5).map((i) => `${i.path.join('.')}: ${i.message}`) })
  return parsed.data
}

/** application/x-www-form-urlencoded fields (the plain login and setup forms). */
export async function readForm(req: IncomingMessage, limit = 8 * 1024): Promise<URLSearchParams> {
  const type = String(req.headers['content-type'] ?? '')
  if (!type.toLowerCase().startsWith('application/x-www-form-urlencoded')) throw new HttpError(415, 'form-only', 'Send a form.')
  const buf = await readBody(req, limit)
  return new URLSearchParams(buf.toString('utf8'))
}

export function cookie(req: IncomingMessage, name: string): string | undefined {
  const header = req.headers.cookie
  if (!header) return undefined
  for (const part of header.split(';')) {
    const eq = part.indexOf('=')
    if (eq < 0) continue
    if (part.slice(0, eq).trim() === name) return decodeURIComponent(part.slice(eq + 1).trim())
  }
  return undefined
}

export function bearer(req: IncomingMessage): string | undefined {
  const h = req.headers.authorization
  if (!h) return undefined
  const m = /^Bearer\s+(\S+)$/i.exec(h)
  return m?.[1]
}

const first = (v: string | string[] | undefined): string | undefined => (Array.isArray(v) ? v[0] : v)

export function clientIp(req: IncomingMessage, trustProxy: boolean): string {
  if (trustProxy) {
    const fwd = first(req.headers['x-forwarded-for'])
    const ip = fwd?.split(',')[0]?.trim()
    if (ip) return ip
  }
  return req.socket.remoteAddress ?? 'unknown'
}

/** The origin a browser shows for this server ("https://host:port"). */
export function ownOrigin(req: IncomingMessage, secure: boolean, trustProxy: boolean): string | null {
  const proto = (trustProxy ? first(req.headers['x-forwarded-proto'])?.split(',')[0]?.trim() : undefined) ?? (secure ? 'https' : 'http')
  const host = (trustProxy ? first(req.headers['x-forwarded-host'])?.split(',')[0]?.trim() : undefined) ?? req.headers.host
  if (!host) return null
  return `${proto}://${host}`.toLowerCase()
}

export function htmlEscape(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c)
}
