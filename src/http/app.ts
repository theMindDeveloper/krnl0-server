// Requests (protocol 1, Decision S9). Every route states how it is protected
// (threat-model.md "Rules that keep this true").

import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { dirname, extname, join, normalize, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Duplex } from 'node:stream'
import { z } from 'zod'
import type { Config } from '../config.js'
import type { DataPaths } from '../paths.js'
import type { AuthStore, Device, LoginResult, Session, SetupCodeKeeper } from '../auth/store.js'
import { passwordProblem, PASSWORD_MAX } from '../auth/password.js'
import type { WindowLimiter } from '../auth/ratelimit.js'
import { safeEqual } from '../auth/tokens.js'
import type { DocStore } from '../store/docs.js'
import { DOC_NAME, MAX_DOC_BYTES } from '../store/docs.js'
import type { TimelogStore } from '../store/timelog.js'
import { BOARD_ID, MONTH } from '../store/timelog.js'
import type { AssetStore } from '../store/assets.js'
import { ASSET_ID, kindOf, mimeOf, parseAssetFile, TooLargeError } from '../store/assets.js'
import { lastBackupAt } from '../store/backup.js'
import type { TlsInfo } from '../tls/index.js'
import type { SyncHub } from '../sync/hub.js'
import type { UpdateChecker } from '../update/check.js'
import { PROTOCOL, VERSION } from '../version.js'
import { log } from '../log.js'
import { ASSET_CSP, securityHeaders } from './headers.js'
import { homeWithoutWebBuild, loginPage, noticePage, setupPage, type PageFacts } from './pages.js'
import { bearer, clientIp, cookie, HttpError, ownOrigin, readForm, readJsonBody, requestOf, sendError, sendJson, sendJsonText } from './util.js'

export const SESSION_COOKIE = '__Host-krnl0'
export const CSRF_HEADER = 'x-krnl0-csrf'
export const CONNECTION_HEADER = 'x-krnl0-connection'

export interface AppContext {
  cfg: Config
  paths: DataPaths
  auth: AuthStore
  setup: SetupCodeKeeper
  docs: DocStore
  timelog: TimelogStore
  assets: AssetStore
  tls: () => TlsInfo
  hub: SyncHub
  updates: UpdateChecker
  authLimiter: WindowLimiter
}

type Principal = { kind: 'session'; session: Session } | { kind: 'device'; device: Device }

const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])

const passwordField = z.string().min(1).max(PASSWORD_MAX * 4)
const codeField = z.string().max(64).optional()

const setupBody = z.object({ code: z.string().min(1).max(64), password: passwordField }).strict()
const loginBody = z.object({ password: passwordField, code: codeField }).strict()
const pairBody = z.object({ password: passwordField, code: codeField, name: z.string().min(1).max(80), platform: z.string().max(40).default('') }).strict()
const putDocBody = z.object({ baseRev: z.number().int().min(0), body: z.unknown() }).strict()
const appendBody = z.object({ entries: z.array(z.object({ month: z.string().regex(MONTH), entry: z.unknown() }).strict()).max(5000) }).strict()

/** The pages' own fonts and pictures (public: the login page needs them before login). */
const PAGE_ASSETS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'public', 'k0')
const PAGE_ASSET = /^[a-z0-9-]{1,40}\.(woff2|webp|png|txt)$/

const STATIC_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.ico': 'image/x-icon',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.otf': 'font/otf',
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg', '.webmanifest': 'application/manifest+json',
  '.wasm': 'application/wasm', '.txt': 'text/plain; charset=utf-8', '.map': 'application/json',
}

function loginFailure(r: LoginResult): HttpError {
  if (r.kind === 'locked') return new HttpError(429, 'locked', `Too many wrong passwords. Try again in ${Math.ceil(r.waitMs / 1000)} seconds.`, { retryAfter: Math.ceil(r.waitMs / 1000) })
  if (r.kind === 'totp-required') return new HttpError(401, 'totp-required', 'Enter the code from your authenticator app.')
  return new HttpError(401, 'bad-login', 'Wrong password or code.')
}

export function createApp(ctx: AppContext): {
  handle: (req: IncomingMessage, res: ServerResponse) => void
  upgrade: (req: IncomingMessage, socket: Duplex, head: Buffer) => void
} {
  const { cfg, auth } = ctx

  const origin = (req: IncomingMessage): string | null => ownOrigin(req, ctx.tls().secure, cfg.trustProxy)
  const ip = (req: IncomingMessage): string => clientIp(req, cfg.trustProxy)

  /** A present Origin header must be ours (CSRF, cross-site WebSocket). */
  const originOk = (req: IncomingMessage): boolean => {
    const o = req.headers.origin
    if (o === undefined) return true
    return o.toLowerCase() === origin(req)
  }

  /**
   * A form post from our own page: our Origin, or (privacy settings can make a
   * browser send `Origin: null`) `Sec-Fetch-Site: same-origin`, which page
   * scripts cannot set.
   */
  const formFromOurPage = (req: IncomingMessage): boolean => {
    const o = req.headers.origin
    if (o !== undefined && o !== 'null') return originOk(req)
    return req.headers['sec-fetch-site'] === 'same-origin'
  }

  const sessionCookie = (token: string, maxAgeSec: number): string =>
    `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${maxAgeSec}`

  const principalOf = (req: IncomingMessage): Principal | null => {
    const token = bearer(req)
    if (token !== undefined) {
      if (!cfg.appSync) return null
      const device = auth.findDevice(token)
      return device ? { kind: 'device', device } : null
    }
    if (!cfg.website) return null
    const session = auth.findSession(cookie(req, SESSION_COOKIE))
    return session ? { kind: 'session', session } : null
  }

  /** Auth for API routes; browser writes also need the CSRF token and our Origin. */
  const requirePrincipal = (req: IncomingMessage): Principal => {
    const p = principalOf(req)
    if (!p) throw new HttpError(401, 'signed-out', 'Log in first.')
    if (p.kind === 'session' && WRITE_METHODS.has(req.method ?? 'GET')) {
      if (req.headers.origin === undefined || !originOk(req)) throw new HttpError(403, 'origin', 'This request did not come from this server\'s page.')
      const sent = req.headers[CSRF_HEADER]
      if (typeof sent !== 'string' || !safeEqual(sent, p.session.csrf)) throw new HttpError(403, 'csrf', 'Missing or wrong CSRF token. Reload the page.')
    }
    return p
  }

  const byOf = (req: IncomingMessage): string | null => {
    const v = req.headers[CONNECTION_HEADER]
    return typeof v === 'string' && /^[A-Za-z0-9_-]{1,32}$/.test(v) ? v : null
  }

  const rateLimit = (req: IncomingMessage): void => {
    if (!ctx.authLimiter.take(ip(req))) throw new HttpError(429, 'rate-limited', 'Too many attempts from this address. Wait 15 minutes.')
  }

  const health = () => {
    const t = ctx.tls()
    return {
      ok: true,
      name: 'krnl0-server',
      version: VERSION,
      protocol: PROTOCOL,
      website: cfg.website,
      appSync: cfg.appSync,
      needsSetup: !auth.hasOwner(),
      timeZone: cfg.timeZone,
      time: Date.now(),
      tls: { mode: t.mode, fingerprint: t.fingerprint },
    }
  }

  // ── API ──────────────────────────────────────────────────────────────────

  async function api(req: IncomingMessage, res: ServerResponse, path: string, query: URLSearchParams): Promise<void> {
    const method = req.method ?? 'GET'
    // Segments are URL-decoded: a client may send board:b1 as board%3Ab1.
    let seg: string[]
    try { seg = path.split('/').filter(Boolean).slice(2).map((x) => decodeURIComponent(x)) } catch { throw new HttpError(400, 'bad-path', 'The address could not be read.') }
    const [head, a, b] = seg
    if (!originOk(req)) throw new HttpError(403, 'origin', 'Cross-site requests are refused.')

    // Public: no auth (health is needed before login for the version handshake).
    if (head === 'health' && seg.length === 1 && method === 'GET') return sendJson(res, 200, health())

    // Public while unclaimed: rate-limited, needs the setup code (F2).
    if (head === 'setup' && seg.length === 1 && method === 'POST') {
      rateLimit(req)
      const body = await readJsonBody(req, setupBody)
      if (auth.hasOwner()) throw new HttpError(409, 'claimed', 'This server already has an owner.')
      const problem = passwordProblem(body.password)
      if (problem) throw new HttpError(400, 'weak-password', problem)
      if (!ctx.setup.consume(body.code)) throw new HttpError(401, 'bad-code', 'Wrong or expired setup code. See the server\'s log for the current one.')
      await auth.setPassword(body.password)
      log.info('Owner account created', { via: 'setup code' })
      return sendJson(res, 201, { ok: true })
    }

    if (head === 'auth') {
      // Public: rate-limited, password-checked (F3–F5).
      if (a === 'login' && method === 'POST') {
        if (!cfg.website) throw new HttpError(404, 'website-off', 'The website is off on this server.')
        rateLimit(req)
        const body = await readJsonBody(req, loginBody)
        const r = await auth.login(body.password, body.code)
        if (r.kind !== 'ok') throw loginFailure(r)
        const { token, session } = auth.createSession(String(req.headers['user-agent'] ?? ''), ip(req))
        res.setHeader('Set-Cookie', sessionCookie(token, 30 * 24 * 3600))
        log.info('Browser logged in', { session: session.id })
        return sendJson(res, 200, { csrf: session.csrf, session: session.id })
      }
      const p = requirePrincipal(req)
      if (a === 'logout' && method === 'POST' && p.kind === 'session') {
        auth.revokeSession(p.session.id)
        ctx.hub.closeFor('session', p.session.id)
        res.setHeader('Set-Cookie', sessionCookie('', 0))
        return sendJson(res, 200, { ok: true })
      }
      if (a === 'session' && method === 'GET' && p.kind === 'session') {
        return sendJson(res, 200, { csrf: p.session.csrf, session: p.session.id, createdAt: p.session.createdAt })
      }
      throw new HttpError(404, 'not-found', 'No such route.')
    }

    // Public: rate-limited, password-checked (F6).
    if (head === 'devices' && a === 'pair' && method === 'POST') {
      if (!cfg.appSync) throw new HttpError(404, 'app-sync-off', 'App sync is off on this server.')
      rateLimit(req)
      const body = await readJsonBody(req, pairBody)
      const r = await auth.login(body.password, body.code)
      if (r.kind !== 'ok') throw loginFailure(r)
      const { token, device } = auth.createDevice(body.name, body.platform)
      log.info('Device paired', { device: device.id })
      return sendJson(res, 201, { deviceId: device.id, token, protocol: PROTOCOL, version: VERSION, timeZone: cfg.timeZone, fingerprint: ctx.tls().fingerprint })
    }

    // Everything below needs a session or a device token.
    const p = requirePrincipal(req)
    const by = byOf(req)

    if (head === 'server' && seg.length === 1 && method === 'GET') {
      const t = ctx.tls()
      return sendJson(res, 200, {
        ...health(),
        update: ctx.updates.info(),
        tls: { mode: t.mode, fingerprint: t.fingerprint, notAfter: t.notAfter?.toISOString() ?? null, names: t.names },
        lastBackupAt: lastBackupAt(ctx.paths)?.toISOString() ?? null,
      })
    }

    if (head === 'devices') {
      if (!a && method === 'GET') {
        const current = p.kind === 'device' ? p.device.id : null
        return sendJson(res, 200, { devices: auth.listDevices().map((d) => ({ id: d.id, name: d.name, platform: d.platform, createdAt: d.createdAt, lastSeenAt: d.lastSeenAt, current: d.id === current })) })
      }
      if (a && !b && method === 'DELETE') {
        if (!auth.revokeDevice(a)) throw new HttpError(404, 'not-found', 'No such device.')
        ctx.hub.closeFor('device', a)
        log.info('Device revoked', { device: a })
        return sendJson(res, 200, { ok: true })
      }
    }

    if (head === 'sessions') {
      if (!a && method === 'GET') {
        const current = p.kind === 'session' ? p.session.id : null
        return sendJson(res, 200, { sessions: auth.listSessions().map((s) => ({ id: s.id, agent: s.agent, ip: s.ip, createdAt: s.createdAt, lastSeenAt: s.lastSeenAt, current: s.id === current })) })
      }
      if (a && !b && method === 'DELETE') {
        if (!auth.revokeSession(a)) throw new HttpError(404, 'not-found', 'No such session.')
        ctx.hub.closeFor('session', a)
        return sendJson(res, 200, { ok: true })
      }
    }

    if (head === 'docs') {
      if (!a && method === 'GET') return sendJson(res, 200, { docs: ctx.docs.list() })
      if (a && !b) {
        if (!DOC_NAME.test(a)) throw new HttpError(400, 'bad-name', 'Bad document name.')
        if (method === 'GET') {
          const got = ctx.docs.getText(a)
          if (!got) {
            const meta = ctx.docs.meta(a)
            throw new HttpError(404, meta?.deleted ? 'deleted' : 'not-found', meta?.deleted ? 'This document was deleted.' : 'No such document.', { rev: meta?.rev ?? 0 })
          }
          const text = `{"name":${JSON.stringify(a)},"rev":${got.meta.rev},"schemaVersion":${JSON.stringify(got.meta.schemaVersion)},"updatedAt":${JSON.stringify(got.meta.updatedAt)},"body":${got.text}}`
          return sendJsonText(res, 200, text)
        }
        if (method === 'PUT') {
          const body = await readJsonBody(req, putDocBody, MAX_DOC_BYTES + 4096)
          const r = await ctx.docs.put(a, body.baseRev, body.body, by)
          if (r.ok) return sendJson(res, 200, { rev: r.rev })
          if (r.reason === 'conflict') throw new HttpError(409, 'conflict', 'Someone else changed this document. Merge and try again.', { rev: r.rev, body: r.body, deleted: r.deleted })
          if (r.reason === 'schema') throw new HttpError(409, 'schema', 'This board was saved by a newer KRNL0. Update the app.', { storedSchemaVersion: r.storedSchemaVersion })
          throw new HttpError(400, 'invalid', r.message)
        }
        if (method === 'DELETE') {
          const baseRev = Number(query.get('baseRev'))
          if (!Number.isInteger(baseRev) || baseRev < 0) throw new HttpError(400, 'invalid', 'baseRev is required.')
          const r = await ctx.docs.delete(a, baseRev, by)
          if (r.ok) return sendJson(res, 200, { rev: r.rev })
          if (r.reason === 'conflict') throw new HttpError(409, 'conflict', 'Someone else changed this document.', { rev: r.rev, body: r.body, deleted: r.deleted })
          throw new HttpError(404, 'not-found', 'No such document.')
        }
      }
    }

    if (head === 'timelog') {
      if (!a && method === 'GET') return sendJson(res, 200, { boards: ctx.timelog.boards().map((id) => ({ id, months: ctx.timelog.months(id) })) })
      if (a && !b) {
        if (!BOARD_ID.test(a)) throw new HttpError(400, 'bad-board', 'Bad board id.')
        try {
          if (method === 'POST') {
            const body = await readJsonBody(req, appendBody, 8 * 1024 * 1024)
            const r = await ctx.timelog.append(a, body.entries, by)
            return sendJson(res, 200, r)
          }
          if (method === 'GET') {
            const from = query.get('from') ?? ''
            const to = query.get('to') ?? ''
            return sendJson(res, 200, { months: ctx.timelog.query(a, from, to) })
          }
          if (method === 'DELETE') {
            if (!ctx.timelog.removeBoard(a)) throw new HttpError(404, 'not-found', 'No time log for this board.')
            return sendJson(res, 200, { ok: true })
          }
        } catch (err) {
          if (err instanceof RangeError) throw new HttpError(400, 'invalid', err.message)
          throw err
        }
      }
    }

    if (head === 'assets') {
      if (!a && method === 'GET') return sendJson(res, 200, { assets: ctx.assets.list() })
      if (a && !b) {
        if (method === 'PUT') {
          const parsed = parseAssetFile(a)
          if (!parsed) throw new HttpError(400, 'bad-name', 'Name the file <id>.<ext>.')
          try {
            const size = await ctx.assets.put(parsed.id, parsed.ext, req, by)
            return sendJson(res, 201, { id: parsed.id, ext: parsed.ext, size })
          } catch (err) {
            if (err instanceof TooLargeError) throw new HttpError(413, 'too-large', err.message)
            throw err
          }
        }
        const id = a.includes('.') ? (parseAssetFile(a)?.id ?? '') : a
        if (!ASSET_ID.test(id)) throw new HttpError(400, 'bad-name', 'Bad asset id.')
        if (method === 'GET') return serveAsset(req, res, id)
        if (method === 'DELETE') {
          if (!ctx.assets.delete(id, by)) throw new HttpError(404, 'not-found', 'No such asset.')
          return sendJson(res, 200, { ok: true })
        }
      }
    }

    throw new HttpError(404, 'not-found', 'No such route.')
  }

  /** Assets are never active content (threat model); media supports Range for seeking. */
  function serveAsset(req: IncomingMessage, res: ServerResponse, id: string): void {
    const found = ctx.assets.find(id)
    if (!found) throw new HttpError(404, 'not-found', 'No such asset.')
    const kind = kindOf(found.ext)
    res.setHeader('Content-Type', mimeOf(found.ext))
    res.setHeader('Content-Security-Policy', ASSET_CSP)
    res.setHeader('Cache-Control', 'private, max-age=86400')
    res.setHeader('Accept-Ranges', 'bytes')
    res.setHeader('X-KRNL0-Asset', `${id}.${found.ext}`)
    if (kind === 'other') res.setHeader('Content-Disposition', `attachment; filename="${id}.${found.ext}"`)
    const range = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range ?? ''))
    if (range && (range[1] || range[2])) {
      let start = range[1] ? Number(range[1]) : found.size - Number(range[2])
      let end = range[1] && range[2] ? Number(range[2]) : found.size - 1
      start = Math.max(0, start)
      end = Math.min(found.size - 1, end)
      if (start > end || start >= found.size) {
        res.statusCode = 416
        res.setHeader('Content-Range', `bytes */${found.size}`)
        res.end()
        return
      }
      res.statusCode = 206
      res.setHeader('Content-Range', `bytes ${start}-${end}/${found.size}`)
      res.setHeader('Content-Length', end - start + 1)
      createReadStream(found.path, { start, end }).pipe(res)
      return
    }
    res.statusCode = 200
    res.setHeader('Content-Length', found.size)
    createReadStream(found.path).pipe(res)
  }

  // ── Website (F13) ────────────────────────────────────────────────────────

  /** What the pages say about this server (side panel, footer). */
  function facts(req: IncomingMessage): PageFacts {
    const t = ctx.tls()
    const host = String(req.headers.host ?? '').slice(0, 200)
    const encryption = t.mode === 'proxy' ? 'by your proxy' : t.mode === 'self-signed' ? 'self-signed' : 'certificate'
    return { host, encryption, fingerprint: t.fingerprint, website: cfg.website, appSync: cfg.appSync }
  }

  function pageAsset(res: ServerResponse, name: string): void {
    const file = join(PAGE_ASSETS_DIR, name)
    if (!PAGE_ASSET.test(name) || !existsSync(file)) throw new HttpError(404, 'not-found', 'Nothing here.')
    res.statusCode = 200
    res.setHeader('Content-Type', STATIC_TYPES[extname(name).toLowerCase()] ?? 'text/plain; charset=utf-8')
    res.setHeader('Cache-Control', 'public, max-age=86400')
    createReadStream(file).pipe(res)
  }

  function sendHtml(res: ServerResponse, status: number, html: string): void {
    res.statusCode = status
    res.setHeader('Content-Type', 'text/html; charset=utf-8')
    res.setHeader('Cache-Control', 'no-store')
    res.end(html)
  }

  function redirect(res: ServerResponse, to: string): void {
    res.statusCode = 303
    res.setHeader('Location', to)
    res.setHeader('Cache-Control', 'no-store')
    res.end()
  }

  async function website(req: IncomingMessage, res: ServerResponse, path: string): Promise<void> {
    const method = req.method ?? 'GET'
    if (!cfg.website) return sendHtml(res, 404, noticePage('Website is off', 'The website is turned off on this KRNL0 server. The desktop app can still sync.', facts(req)))

    if (WRITE_METHODS.has(method) && !formFromOurPage(req)) {
      return sendHtml(res, 403, noticePage('Refused', 'This form was not sent from this server\'s own page.', facts(req)))
    }

    if (path === '/setup') {
      if (auth.hasOwner()) return redirect(res, '/login')
      if (method === 'GET') return sendHtml(res, 200, setupPage(undefined, facts(req)))
      if (method === 'POST') {
        if (!ctx.authLimiter.take(ip(req))) return sendHtml(res, 429, setupPage('Too many attempts from this address. Wait 15 minutes.', facts(req)))
        const f = await readForm(req)
        const password = f.get('password') ?? ''
        if (password !== (f.get('password2') ?? '')) return sendHtml(res, 400, setupPage('The two passwords are not the same.', facts(req)))
        const problem = passwordProblem(password)
        if (problem) return sendHtml(res, 400, setupPage(problem, facts(req)))
        if (!ctx.setup.consume(f.get('code') ?? '')) return sendHtml(res, 401, setupPage('Wrong or expired setup code. The server\'s log shows the current one (or run krnl0 setup on the server).', facts(req)))
        await auth.setPassword(password)
        log.info('Owner account created', { via: 'setup page' })
        const { token } = auth.createSession(String(req.headers['user-agent'] ?? ''), ip(req))
        res.setHeader('Set-Cookie', sessionCookie(token, 30 * 24 * 3600))
        return redirect(res, '/')
      }
    }

    if (path === '/login') {
      if (!auth.hasOwner()) return redirect(res, '/setup')
      if (method === 'GET') return sendHtml(res, 200, loginPage(undefined, facts(req)))
      if (method === 'POST') {
        if (!ctx.authLimiter.take(ip(req))) return sendHtml(res, 429, loginPage('Too many attempts from this address. Wait 15 minutes.', facts(req)))
        const f = await readForm(req)
        const code = f.get('code') ?? ''
        const r = await auth.login(f.get('password') ?? '', code || undefined)
        if (r.kind !== 'ok') return sendHtml(res, r.kind === 'locked' ? 429 : 401, loginPage(loginFailure(r).message, facts(req)))
        const { token, session } = auth.createSession(String(req.headers['user-agent'] ?? ''), ip(req))
        res.setHeader('Set-Cookie', sessionCookie(token, 30 * 24 * 3600))
        log.info('Browser logged in', { session: session.id })
        return redirect(res, '/')
      }
    }

    if (path === '/logout' && method === 'POST') {
      const s = auth.findSession(cookie(req, SESSION_COOKIE))
      if (s) { auth.revokeSession(s.id); ctx.hub.closeFor('session', s.id) }
      res.setHeader('Set-Cookie', sessionCookie('', 0))
      return redirect(res, '/login')
    }

    if (method !== 'GET' && method !== 'HEAD') return sendHtml(res, 405, noticePage('Not allowed', 'This address only shows a page.', facts(req)))

    // Everything else is the app, for the owner only (nothing is shown before login).
    if (!auth.hasOwner()) return redirect(res, '/setup')
    if (!auth.findSession(cookie(req, SESSION_COOKIE))) return redirect(res, '/login')
    return serveStatic(res, path)
  }

  function serveStatic(res: ServerResponse, path: string): void {
    const root = cfg.webDir ? resolve(cfg.webDir) : null
    if (!root || !existsSync(join(root, 'index.html'))) return sendHtml(res, 200, homeWithoutWebBuild(facts(requestOf.get(res) ?? ({ headers: {} } as IncomingMessage))))
    let rel: string
    try { rel = decodeURIComponent(path) } catch { return sendHtml(res, 400, noticePage('Bad address', 'This address could not be read.')) }
    if (rel.includes('\0')) return sendHtml(res, 400, noticePage('Bad address', 'This address could not be read.'))
    let file = resolve(root, '.' + normalize('/' + rel))
    if (file !== root && !file.startsWith(root + sep)) return sendHtml(res, 404, noticePage('Not found', 'Nothing here.'))
    let isFile = false
    try { isFile = statSync(file).isFile() } catch { isFile = false }
    if (!isFile) {
      // Single-page app: unknown paths without an extension get the app.
      if (extname(file) !== '') return sendHtml(res, 404, noticePage('Not found', 'Nothing here.'))
      file = join(root, 'index.html')
    }
    const ext = extname(file).toLowerCase()
    res.statusCode = 200
    res.setHeader('Content-Type', STATIC_TYPES[ext] ?? 'application/octet-stream')
    const hashed = /[.-][A-Za-z0-9_-]{8,}\.(js|css|woff2?|png|jpg|svg|webp|mp3|wav|ogg|wasm)$/.test(file)
    res.setHeader('Cache-Control', ext === '.html' ? 'no-cache' : hashed ? 'private, max-age=31536000, immutable' : 'no-cache')
    if (ext === '.html') {
      res.end(readFileSync(file))
      return
    }
    createReadStream(file).pipe(res)
  }

  // ── Entry points ─────────────────────────────────────────────────────────

  const handle = (req: IncomingMessage, res: ServerResponse): void => {
    requestOf.set(res, req)
    // HSTS only for our own publicly trusted certificate; in proxy mode the proxy decides (Decision S3).
    securityHeaders(res, { hsts: ctx.tls().trusted && ctx.tls().secure })
    let url: URL
    try { url = new URL(req.url ?? '/', 'http://local') } catch { res.statusCode = 400; res.end(); return }
    const path = url.pathname

    const run = async (): Promise<void> => {
      if (path === '/ca.crt' && req.method === 'GET') {
        const ca = ctx.tls().caPem
        if (!ca) throw new HttpError(404, 'not-found', 'This server uses a public certificate; nothing to install.')
        res.statusCode = 200
        res.setHeader('Content-Type', 'application/x-x509-ca-cert')
        res.setHeader('Content-Disposition', 'attachment; filename="krnl0-server-ca.crt"')
        res.end(ca)
        return
      }
      if (path.startsWith('/_k0/') && (req.method === 'GET' || req.method === 'HEAD')) return pageAsset(res, path.slice(5))
      if (path === '/api' || path.startsWith('/api/')) {
        if (!path.startsWith('/api/v1/')) throw new HttpError(404, 'not-found', 'Unknown API version.')
        return api(req, res, path, url.searchParams)
      }
      return website(req, res, path)
    }

    run().catch((err: unknown) => {
      if (res.headersSent) { res.destroy(); return }
      if (err instanceof HttpError) {
        if (err.status === 429 && typeof err.extra.retryAfter === 'number') res.setHeader('Retry-After', String(err.extra.retryAfter))
        return sendError(res, err)
      }
      log.error('Request failed', { path, reason: err instanceof Error ? err.message : String(err) })
      sendError(res, new HttpError(500, 'server-error', 'Something went wrong on the server.'))
    })
  }

  const upgrade = (req: IncomingMessage, socket: Duplex, head: Buffer): void => {
    const refuse = (status: number, text: string): void => {
      socket.write(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`)
      socket.destroy()
    }
    let path: string
    try { path = new URL(req.url ?? '/', 'http://local').pathname } catch { return refuse(400, 'Bad Request') }
    if (path !== '/api/v1/sync') return refuse(404, 'Not Found')
    if (!originOk(req)) return refuse(403, 'Forbidden')
    const p = principalOf(req)
    if (!p) return refuse(401, 'Unauthorized')
    // A browser socket must come from our own page.
    if (p.kind === 'session' && req.headers.origin === undefined) return refuse(403, 'Forbidden')
    const principal = p.kind === 'session'
      ? { kind: 'session' as const, id: p.session.id, stillValid: () => cfg.website && auth.sessionStillValid(p.session.id) }
      : { kind: 'device' as const, id: p.device.id, stillValid: () => cfg.appSync && auth.deviceStillValid(p.device.id) }
    ctx.hub.accept(req, socket, head, principal)
  }

  return { handle, upgrade }
}
