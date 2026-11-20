import { describe, expect, it } from 'vitest'
import { hashPassword, passwordProblem, verifyPassword } from '../src/auth/password.js'
import { base32Decode, base32Encode, matchTotp, stepAt, totpCode } from '../src/auth/totp.js'
import { AccountBackoff, WindowLimiter } from '../src/auth/ratelimit.js'
import { AuthStore, SESSION_IDLE_MS, SetupCodeKeeper } from '../src/auth/store.js'
import { newSetupCode } from '../src/auth/tokens.js'
import { dataPaths } from '../src/paths.js'
import { tempDir } from './helpers.js'
import { readFileSync } from 'node:fs'

describe('passwords (F3)', () => {
  it('hashes with Argon2id and verifies', async () => {
    const h = await hashPassword('correct horse battery staple')
    expect(h).toMatch(/^\$argon2id\$v=19\$m=19456,t=2,p=1\$/)
    expect(await verifyPassword('correct horse battery staple', h)).toBe(true)
    expect(await verifyPassword('correct horse battery stapl', h)).toBe(false)
  })

  it('needs 12 to 256 characters', () => {
    expect(passwordProblem('short')).toMatch(/12/)
    expect(passwordProblem('a'.repeat(12))).toBeNull()
    expect(passwordProblem('a'.repeat(257))).toMatch(/256/)
  })
})

describe('TOTP (F3)', () => {
  // RFC 6238 test secret "12345678901234567890" (SHA-1).
  const secret = base32Encode(Buffer.from('12345678901234567890'))

  it('round-trips base32', () => {
    expect(base32Decode(secret).toString()).toBe('12345678901234567890')
  })

  it('matches the RFC 6238 vectors (last 6 digits)', () => {
    expect(totpCode(secret, stepAt(59_000))).toBe('287082')
    expect(totpCode(secret, stepAt(1_111_111_109_000))).toBe('081804')
    expect(totpCode(secret, stepAt(2_000_000_000_000))).toBe('279037')
  })

  it('refuses a code that was already used', () => {
    const now = 1_111_111_109_000
    const code = totpCode(secret, stepAt(now))
    const step = matchTotp(secret, code, now, null)
    expect(step).toBe(stepAt(now))
    expect(matchTotp(secret, code, now, step)).toBeNull()
  })
})

describe('rate limits (F4)', () => {
  it('allows 10 per window per key', () => {
    const l = new WindowLimiter(10, 15 * 60_000)
    for (let i = 0; i < 10; i++) expect(l.take('1.2.3.4', 1000)).toBe(true)
    expect(l.take('1.2.3.4', 1000)).toBe(false)
    expect(l.take('5.6.7.8', 1000)).toBe(true)
    expect(l.take('1.2.3.4', 1000 + 15 * 60_000 + 1)).toBe(true)
  })

  it('waits 1 minute after 5 wrong passwords, doubling to 1 hour', () => {
    const b = new AccountBackoff()
    for (let i = 0; i < 4; i++) b.fail(0)
    expect(b.waitMs(0)).toBe(0)
    b.fail(0)
    expect(b.waitMs(0)).toBe(60_000)
    b.fail(0)
    expect(b.waitMs(0)).toBe(120_000)
    for (let i = 0; i < 20; i++) b.fail(0)
    expect(b.waitMs(0)).toBe(3_600_000)
    b.succeed()
    expect(b.waitMs(0)).toBe(0)
  })
})

describe('setup code (F2)', () => {
  it('is single use and expires after 60 minutes', () => {
    let now = 0
    const announced: string[] = []
    const k = new SetupCodeKeeper(newSetupCode, (c) => announced.push(c), () => now)
    const code = k.current()
    expect(code).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{2}$/)
    expect(k.consume('WRONG-CODE-00')).toBe(false)
    expect(k.consume(code.toLowerCase().replace(/-/g, ' '))).toBe(true)
    expect(k.consume(code)).toBe(false)

    const second = k.current()
    now += 60 * 60_000
    expect(k.consume(second)).toBe(false)
    expect(announced.length).toBe(2)
  })
})

describe('AuthStore (F3, F5, F6)', () => {
  it('stores only hashes on disk', async () => {
    const paths = dataPaths(tempDir())
    const auth = new AuthStore(paths)
    await auth.setPassword('correct horse battery staple')
    const { token } = auth.createSession('agent', '127.0.0.1')
    const dev = auth.createDevice('Laptop', 'win32')
    const disk = readFileSync(paths.owner, 'utf8') + readFileSync(paths.sessions, 'utf8') + readFileSync(paths.devices, 'utf8')
    expect(disk).not.toContain('correct horse')
    expect(disk).not.toContain(token)
    expect(disk).not.toContain(dev.token)
  })

  it('locks the account after 5 wrong passwords, even for the right one', async () => {
    const auth = new AuthStore(dataPaths(tempDir()))
    await auth.setPassword('correct horse battery staple')
    for (let i = 0; i < 5; i++) expect((await auth.login('wrong password here')).kind).toBe('bad')
    const r = await auth.login('correct horse battery staple')
    expect(r.kind).toBe('locked')
  })

  it('asks for the second factor and accepts a recovery code once', async () => {
    let now = 1_700_000_000_000
    const auth = new AuthStore(dataPaths(tempDir()), () => now)
    await auth.setPassword('correct horse battery staple')
    const secret = auth.beginTotp()
    const codes = auth.confirmTotp(totpCode(secret, stepAt(now)))
    expect(codes).toHaveLength(10)
    now += 120_000
    expect((await auth.login('correct horse battery staple')).kind).toBe('totp-required')
    expect((await auth.login('correct horse battery staple', totpCode(secret, stepAt(now)))).kind).toBe('ok')
    const rc = codes?.[0] ?? ''
    expect((await auth.login('correct horse battery staple', rc)).kind).toBe('ok')
    expect((await auth.login('correct horse battery staple', rc)).kind).toBe('bad')
    expect(auth.recoveryCodesLeft()).toBe(9)
  })

  it('expires idle sessions and revokes devices', async () => {
    let now = 1_700_000_000_000
    const auth = new AuthStore(dataPaths(tempDir()), () => now)
    const { token } = auth.createSession('a', 'ip')
    expect(auth.findSession(token)).not.toBeNull()
    now += SESSION_IDLE_MS + 1
    expect(auth.findSession(token)).toBeNull()

    const d = auth.createDevice('Laptop', 'linux')
    expect(auth.findDevice(d.token)?.id).toBe(d.device.id)
    auth.revokeDevice(d.device.id)
    expect(auth.findDevice(d.token)).toBeNull()
  })

  it('a new password signs out every browser', async () => {
    const auth = new AuthStore(dataPaths(tempDir()))
    await auth.setPassword('correct horse battery staple')
    const { token } = auth.createSession('a', 'ip')
    await auth.setPassword('another long password')
    expect(auth.findSession(token)).toBeNull()
  })

  it('sees a revoke made by another process (the CLI)', () => {
    const paths = dataPaths(tempDir())
    const server = new AuthStore(paths)
    const d = server.createDevice('Laptop', 'linux')
    expect(server.findDevice(d.token)).not.toBeNull()
    new AuthStore(paths).revokeDevice(d.device.id)
    expect(server.findDevice(d.token)).toBeNull()
  })
})
