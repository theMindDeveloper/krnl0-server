import { afterEach, describe, expect, it } from 'vitest'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fingerprintOf } from '../src/tls/selfsigned.js'
import { browserLogin, claim, closed, nextMessage, opened, pair, PASSWORD, startTestServer, tempDir, type TestServer } from './helpers.js'

let server: TestServer | null = null
afterEach(async () => {
  await server?.stop()
  server = null
})

describe('TLS (F7, F8, NF5)', () => {
  it('serves HTTPS from its own CA, reports the fingerprint, sends no HSTS', async () => {
    server = await startTestServer()
    const r = await server.request('GET', '/api/v1/health')
    expect(r.status).toBe(200)
    expect(r.json()).toMatchObject({ protocol: 1, needsSetup: true, tls: { mode: 'self-signed', fingerprint: fingerprintOf(server.ca.toString()) } })
    expect(r.headers['strict-transport-security']).toBeUndefined()
    expect(r.headers['x-content-type-options']).toBe('nosniff')
    expect(String(r.headers['content-security-policy'])).toContain("frame-ancestors 'none'")
    const ca = await server.request('GET', '/ca.crt')
    expect(ca.text).toContain('BEGIN CERTIFICATE')
  })
})

describe('switches (F1)', () => {
  it('website off: no pages, no browser login', async () => {
    server = await startTestServer({ KRNL0_WEBSITE: 'off' })
    expect((await server.request('GET', '/')).status).toBe(404)
    await claim(server)
    const r = await server.request('POST', '/api/v1/auth/login', { json: { password: PASSWORD } })
    expect(r.status).toBe(404)
    expect((await pair(server)).token).toMatch(/^k0d_/)
  })

  it('app sync off: no pairing, device tokens refused', async () => {
    server = await startTestServer()
    await claim(server)
    const { token } = await pair(server)
    const dir = server.dir
    await server.close()
    server = await startTestServer({ KRNL0_APP_SYNC: 'off' }, dir)
    expect((await server.request('POST', '/api/v1/devices/pair', { json: { password: PASSWORD, name: 'x' } })).status).toBe(404)
    expect((await server.request('GET', '/api/v1/docs', { headers: { Authorization: `Bearer ${token}` } })).status).toBe(401)
  })
})

describe('setup and login (F2–F5)', () => {
  it('the setup code claims the server once', async () => {
    server = await startTestServer()
    const code = server.ctx.setup.current()
    const wrong = await server.request('POST', '/api/v1/setup', { json: { code: 'AAAA-BBBB-CC', password: PASSWORD } })
    expect(wrong.status).toBe(401)
    expect(server.ctx.auth.hasOwner()).toBe(false)
    const weak = await server.request('POST', '/api/v1/setup', { json: { code, password: 'short' } })
    expect(weak.status).toBe(400)
    expect((await server.request('POST', '/api/v1/setup', { json: { code, password: PASSWORD } })).status).toBe(201)
    expect((await server.request('POST', '/api/v1/setup', { json: { code, password: PASSWORD } })).status).toBe(409)
  })

  it('pages: setup, then login; nothing of the app before login', async () => {
    server = await startTestServer()
    expect((await server.request('GET', '/')).headers.location).toBe('/setup')
    const code = server.ctx.setup.current()
    const form = new URLSearchParams({ code, password: PASSWORD, password2: PASSWORD }).toString()
    const noOrigin = await server.request('POST', '/setup', { body: form, headers: { 'Content-Type': 'application/x-www-form-urlencoded' } })
    expect(noOrigin.status).toBe(403)
    const ok = await server.request('POST', '/setup', { body: form, headers: { 'Content-Type': 'application/x-www-form-urlencoded', Origin: server.origin } })
    expect(ok.status).toBe(303)
    const cookie = String(ok.headers['set-cookie']).split(';')[0] ?? ''
    expect(String(ok.headers['set-cookie'])).toMatch(/__Host-krnl0=.+; Path=\/; HttpOnly; Secure; SameSite=Strict/)
    expect((await server.request('GET', '/')).headers.location).toBe('/login')
    expect((await server.request('GET', '/', { headers: { Cookie: cookie } })).status).toBe(200)
  })

  it('a real browser form post works (Origin null + Sec-Fetch-Site), a cross-site one does not', async () => {
    server = await startTestServer()
    await claim(server)
    const h = await server.request('GET', '/login')
    expect(h.headers['referrer-policy']).toBe('same-origin')
    const form = new URLSearchParams({ password: PASSWORD }).toString()
    const type = { 'Content-Type': 'application/x-www-form-urlencoded' }
    const ok = await server.request('POST', '/login', { body: form, headers: { ...type, Origin: 'null', 'Sec-Fetch-Site': 'same-origin' } })
    expect(ok.status).toBe(303)
    expect(ok.headers.location).toBe('/')
    const cross = await server.request('POST', '/login', { body: form, headers: { ...type, Origin: 'null', 'Sec-Fetch-Site': 'cross-site' } })
    expect(cross.status).toBe(403)
    const evil = await server.request('POST', '/login', { body: form, headers: { ...type, Origin: 'https://evil.example', 'Sec-Fetch-Site': 'same-origin' } })
    expect(evil.status).toBe(403)
  })

  it('locks after 5 wrong passwords', async () => {
    server = await startTestServer()
    await claim(server)
    for (let i = 0; i < 5; i++) {
      const r = await server.request('POST', '/api/v1/auth/login', { json: { password: 'wrong password here' } })
      expect(r.status).toBe(401)
    }
    const r = await server.request('POST', '/api/v1/auth/login', { json: { password: PASSWORD } })
    expect(r.status).toBe(429)
    expect(r.headers['retry-after']).toBeDefined()
  })

  it('browser writes need the CSRF token and our Origin', async () => {
    server = await startTestServer()
    await claim(server)
    const { cookie, csrf } = await browserLogin(server)
    const body = { baseRev: 0, body: { schemaVersion: 2 } }
    expect((await server.request('PUT', '/api/v1/docs/d', { json: body, headers: { Cookie: cookie, Origin: server.origin } })).status).toBe(403)
    expect((await server.request('PUT', '/api/v1/docs/d', { json: body, headers: { Cookie: cookie, 'X-KRNL0-CSRF': csrf } })).status).toBe(403)
    expect((await server.request('PUT', '/api/v1/docs/d', { json: body, headers: { Cookie: cookie, 'X-KRNL0-CSRF': csrf, Origin: 'https://evil.example' } })).status).toBe(403)
    expect((await server.request('PUT', '/api/v1/docs/d', { json: body, headers: { Cookie: cookie, 'X-KRNL0-CSRF': csrf, Origin: server.origin } })).status).toBe(200)
  })
})

describe('every route refuses a stranger (threat model)', () => {
  it('401 without a session or token', async () => {
    server = await startTestServer()
    await claim(server)
    const routes: Array<[string, string]> = [
      ['GET', '/api/v1/server'], ['GET', '/api/v1/devices'], ['DELETE', '/api/v1/devices/abc'],
      ['GET', '/api/v1/sessions'], ['DELETE', '/api/v1/sessions/abc'], ['GET', '/api/v1/docs'],
      ['GET', '/api/v1/docs/d'], ['PUT', '/api/v1/docs/d'], ['DELETE', '/api/v1/docs/d?baseRev=0'],
      ['GET', '/api/v1/timelog'], ['GET', '/api/v1/timelog/b1?from=2026-01&to=2026-02'], ['POST', '/api/v1/timelog/b1'],
      ['DELETE', '/api/v1/timelog/b1'], ['GET', '/api/v1/assets'], ['PUT', '/api/v1/assets/01HXYZABCDEFGH.png'],
      ['GET', '/api/v1/assets/01HXYZABCDEFGH'], ['DELETE', '/api/v1/assets/01HXYZABCDEFGH'],
      ['GET', '/api/v1/auth/session'], ['POST', '/api/v1/auth/logout'],
    ]
    for (const [method, path] of routes) {
      const r = await server.request(method, path, { headers: { Authorization: 'Bearer k0d_not-a-real-token' } })
      expect(r.status, `${method} ${path}`).toBe(401)
      const r2 = await server.request(method, path)
      expect(r2.status, `${method} ${path} (no auth)`).toBe(401)
    }
  })
})

describe('sync (F6, F9, F10, F14)', () => {
  it('two devices: a write reaches the other as a change', async () => {
    server = await startTestServer()
    await claim(server)
    const a = await pair(server, 'A')
    const b = await pair(server, 'B')
    const wsB = server.ws({ Authorization: `Bearer ${b.token}` })
    await opened(wsB)
    wsB.send(JSON.stringify({ type: 'hello', protocol: 1, client: 'desktop', version: '0.13.0' }))
    const hello = await nextMessage(wsB)
    expect(hello).toMatchObject({ type: 'hello', protocol: 1, timeZone: 'Europe/Berlin' })

    const change = nextMessage(wsB, (m) => m.type === 'change')
    const put = await server.request('PUT', '/api/v1/docs/board:b1', { json: { baseRev: 0, body: { schemaVersion: 2, nodes: [] } }, headers: { Authorization: `Bearer ${a.token}`, 'X-KRNL0-Connection': 'connA' } })
    expect(put.json()).toEqual({ rev: 1 })
    expect(await change).toMatchObject({ type: 'change', kind: 'doc', name: 'board:b1', rev: 1, by: 'connA' })

    const stale = await server.request('PUT', '/api/v1/docs/board:b1', { json: { baseRev: 0, body: { schemaVersion: 2 } }, headers: { Authorization: `Bearer ${b.token}` } })
    expect(stale.status).toBe(409)
    expect(stale.json()).toMatchObject({ error: { code: 'conflict', rev: 1, body: { schemaVersion: 2, nodes: [] } } })
    wsB.close()
  })

  it('an old app is told to update', async () => {
    server = await startTestServer()
    await claim(server)
    const d = await pair(server)
    const ws = server.ws({ Authorization: `Bearer ${d.token}` })
    await opened(ws)
    const done = closed(ws)
    ws.send(JSON.stringify({ type: 'hello', protocol: 0, client: 'desktop' }))
    expect(await nextMessage(ws)).toMatchObject({ type: 'error', code: 'protocol', message: expect.stringMatching(/update the KRNL0 app/) })
    expect((await done).code).toBe(4000)
  })

  it('refuses a socket without auth or from another site', async () => {
    server = await startTestServer()
    await claim(server)
    await expect(opened(server.ws())).rejects.toThrow(/401/)
    const { cookie } = await browserLogin(server)
    await expect(opened(server.ws({ Cookie: cookie, Origin: 'https://evil.example' }))).rejects.toThrow(/403/)
    const ok = server.ws({ Cookie: cookie, Origin: server.origin })
    await opened(ok)
    ok.close()
  })

  it('a revoked device is refused at once', async () => {
    server = await startTestServer()
    await claim(server)
    const d = await pair(server)
    const auth = { Authorization: `Bearer ${d.token}` }
    expect((await server.request('GET', '/api/v1/docs', { headers: auth })).status).toBe(200)
    expect((await server.request('DELETE', `/api/v1/devices/${d.deviceId}`, { headers: auth })).status).toBe(200)
    expect((await server.request('GET', '/api/v1/docs', { headers: auth })).status).toBe(401)
  })
})

describe('assets and website (F12, F13)', () => {
  it('serves an SVG as inert content and supports ranges', async () => {
    server = await startTestServer()
    await claim(server)
    const d = await pair(server)
    const auth = { Authorization: `Bearer ${d.token}` }
    const svg = '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'
    expect((await server.request('PUT', '/api/v1/assets/01HXYZABCDEFGH.svg', { body: svg, headers: auth })).status).toBe(201)
    const r = await server.request('GET', '/api/v1/assets/01HXYZABCDEFGH', { headers: auth })
    expect(r.headers['content-type']).toBe('image/svg+xml')
    expect(String(r.headers['content-security-policy'])).toContain('sandbox')
    const part = await server.request('GET', '/api/v1/assets/01HXYZABCDEFGH', { headers: { ...auth, Range: 'bytes=0-3' } })
    expect(part.status).toBe(206)
    expect(part.text).toBe('<svg')

    await server.request('PUT', '/api/v1/assets/01HXYZABCDEFGJ.zip', { body: 'PK', headers: auth })
    const zip = await server.request('GET', '/api/v1/assets/01HXYZABCDEFGJ', { headers: auth })
    expect(zip.headers['content-disposition']).toMatch(/^attachment/)
  })

  it('serves the web build to the owner only, and never outside its folder', async () => {
    const web = tempDir('krnl0-web-')
    writeFileSync(join(web, 'index.html'), '<!doctype html><title>KRNL0</title>')
    mkdirSync(join(web, 'assets'))
    writeFileSync(join(web, 'assets', 'app-abcdef12.js'), 'console.log(1)')
    server = await startTestServer({ KRNL0_WEB_DIR: web })
    await claim(server)
    const { cookie } = await browserLogin(server)
    const h = { Cookie: cookie }
    expect((await server.request('GET', '/assets/app-abcdef12.js')).status).toBe(303)
    const js = await server.request('GET', '/assets/app-abcdef12.js', { headers: h })
    expect(js.headers['cache-control']).toContain('immutable')
    expect((await server.request('GET', '/board/today', { headers: h })).text).toContain('<title>KRNL0</title>')
    expect((await server.request('GET', '/%2e%2e/%2e%2e/config.json', { headers: h })).status).toBe(404)
    expect((await server.request('GET', '/..%5c..%5cconfig.json', { headers: h })).status).toBe(404)
  })
})
