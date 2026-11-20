// The owner account, browser sessions and paired devices (F2–F6, Decision S4).
// Files under <data>/auth/ are mode 0600 and hold only hashes, except the TOTP
// secret, which must be readable to check codes.

import { z } from 'zod'
import type { DataPaths } from '../paths.js'
import { JsonFile } from '../fsutil.js'
import { dummyVerify, hashPassword, needsRehash, passwordProblem, verifyPassword } from './password.js'
import { AccountBackoff } from './ratelimit.js'
import { matchTotp, newTotpSecret } from './totp.js'
import { newRecoveryCode, normalizeSetupCode, randomToken, safeEqual, sha256Hex } from './tokens.js'

export const SESSION_IDLE_MS = 14 * 24 * 3600_000
export const SESSION_MAX_MS = 30 * 24 * 3600_000
const TOUCH_EVERY_MS = 5 * 60_000

const ownerSchema = z.object({
  passwordHash: z.string(),
  createdAt: z.string(),
  passwordChangedAt: z.string(),
  totp: z.object({
    secret: z.string(),
    lastStep: z.number().nullable(),
    recovery: z.array(z.string()),
    enabledAt: z.string(),
  }).nullable(),
  pendingTotp: z.object({ secret: z.string(), createdAt: z.string() }).nullable().optional(),
})
export type Owner = z.infer<typeof ownerSchema>

const sessionSchema = z.object({
  id: z.string(),
  hash: z.string(),
  csrf: z.string(),
  createdAt: z.number(),
  lastSeenAt: z.number(),
  agent: z.string(),
  ip: z.string(),
})
export type Session = z.infer<typeof sessionSchema>
const sessionsSchema = z.object({ sessions: z.array(sessionSchema) })

const deviceSchema = z.object({
  id: z.string(),
  name: z.string(),
  platform: z.string(),
  tokenHash: z.string(),
  createdAt: z.number(),
  lastSeenAt: z.number(),
})
export type Device = z.infer<typeof deviceSchema>
const devicesSchema = z.object({ devices: z.array(deviceSchema) })

/** What a login attempt came to. */
export type LoginResult =
  | { kind: 'ok' }
  | { kind: 'bad' }
  | { kind: 'totp-required' }
  | { kind: 'locked'; waitMs: number }
  | { kind: 'no-owner' }

const shortId = (hash: string): string => hash.slice(0, 12)
const clip = (s: string, n: number): string => (s.length > n ? s.slice(0, n) : s)

export class AuthStore {
  private readonly owner: JsonFile<Owner | null>
  private readonly sessions: JsonFile<z.infer<typeof sessionsSchema>>
  private readonly devices: JsonFile<z.infer<typeof devicesSchema>>
  readonly backoff = new AccountBackoff()

  constructor(paths: DataPaths, private readonly now: () => number = Date.now) {
    this.owner = new JsonFile(paths.owner, ownerSchema.nullable(), () => null)
    this.sessions = new JsonFile(paths.sessions, sessionsSchema, () => ({ sessions: [] }))
    this.devices = new JsonFile(paths.devices, devicesSchema, () => ({ devices: [] }))
  }

  hasOwner(): boolean {
    return this.owner.get() !== null
  }

  getOwner(): Owner | null {
    return this.owner.get()
  }

  /** Creates the owner, or replaces the password. Signs out every browser. */
  async setPassword(password: string): Promise<void> {
    const problem = passwordProblem(password)
    if (problem) throw new Error(problem)
    const hash = await hashPassword(password)
    const now = new Date(this.now()).toISOString()
    const prev = this.owner.get()
    this.owner.set({
      passwordHash: hash,
      createdAt: prev?.createdAt ?? now,
      passwordChangedAt: now,
      totp: prev?.totp ?? null,
      pendingTotp: prev?.pendingTotp ?? null,
    })
    this.sessions.set({ sessions: [] })
    this.backoff.succeed()
  }

  /** Password (+ TOTP or a recovery code when 2FA is on). */
  async login(password: string, secondFactor?: string): Promise<LoginResult> {
    const wait = this.backoff.waitMs(this.now())
    if (wait > 0) return { kind: 'locked', waitMs: wait }
    const owner = this.owner.get()
    if (!owner) {
      await dummyVerify(password)
      return { kind: 'no-owner' }
    }
    const ok = await verifyPassword(password, owner.passwordHash)
    if (!ok) {
      this.backoff.fail(this.now())
      return { kind: 'bad' }
    }
    if (owner.totp) {
      if (!secondFactor) return { kind: 'totp-required' }
      if (!this.useSecondFactor(owner, secondFactor)) {
        this.backoff.fail(this.now())
        return { kind: 'bad' }
      }
    }
    this.backoff.succeed()
    if (needsRehash(owner.passwordHash)) {
      const fresh = await hashPassword(password)
      this.owner.update((o) => (o ? { ...o, passwordHash: fresh } : o))
    }
    return { kind: 'ok' }
  }

  private useSecondFactor(owner: Owner, code: string): boolean {
    const totp = owner.totp
    if (!totp) return true
    const step = matchTotp(totp.secret, code, this.now(), totp.lastStep)
    if (step !== null) {
      this.owner.set({ ...owner, totp: { ...totp, lastStep: step } })
      return true
    }
    const hash = sha256Hex(normalizeSetupCode(code))
    const idx = totp.recovery.findIndex((h) => safeEqual(h, hash))
    if (idx >= 0) {
      const recovery = totp.recovery.filter((_, i) => i !== idx)
      this.owner.set({ ...owner, totp: { ...totp, recovery } })
      return true
    }
    return false
  }

  // ── Browser sessions (F5) ────────────────────────────────────────────────

  createSession(agent: string, ip: string): { token: string; session: Session } {
    const token = randomToken()
    const hash = sha256Hex(token)
    const now = this.now()
    const session: Session = { id: shortId(hash), hash, csrf: randomToken(), createdAt: now, lastSeenAt: now, agent: clip(agent, 200), ip: clip(ip, 64) }
    this.sessions.update((s) => ({ sessions: [...this.live(s.sessions), session] }))
    return { token, session }
  }

  findSession(token: string | undefined): Session | null {
    if (!token || token.length > 200) return null
    const hash = sha256Hex(token)
    const now = this.now()
    const found = this.sessions.get().sessions.find((s) => safeEqual(s.hash, hash))
    if (!found || !this.isLive(found, now)) return null
    if (now - found.lastSeenAt > TOUCH_EVERY_MS) {
      this.sessions.update((s) => ({ sessions: this.live(s.sessions).map((x) => (x.id === found.id ? { ...x, lastSeenAt: now } : x)) }))
    }
    return found
  }

  sessionStillValid(id: string): boolean {
    const s = this.sessions.get().sessions.find((x) => x.id === id)
    return !!s && this.isLive(s, this.now())
  }

  listSessions(): Session[] {
    return this.live(this.sessions.get().sessions)
  }

  revokeSession(id: string): boolean {
    let found = false
    this.sessions.update((s) => ({ sessions: s.sessions.filter((x) => { if (x.id === id) { found = true; return false } return true }) }))
    return found
  }

  revokeAllSessions(): number {
    const n = this.sessions.get().sessions.length
    this.sessions.set({ sessions: [] })
    return n
  }

  private isLive(s: Session, now: number): boolean {
    return now - s.lastSeenAt < SESSION_IDLE_MS && now - s.createdAt < SESSION_MAX_MS
  }

  private live(list: Session[]): Session[] {
    const now = this.now()
    return list.filter((s) => this.isLive(s, now))
  }

  // ── Devices (F6) ─────────────────────────────────────────────────────────

  createDevice(name: string, platform: string): { token: string; device: Device } {
    const token = randomToken('k0d_')
    const tokenHash = sha256Hex(token)
    const now = this.now()
    const device: Device = { id: shortId(sha256Hex(tokenHash)), name: clip(name.trim() || 'KRNL0 app', 80), platform: clip(platform, 40), tokenHash, createdAt: now, lastSeenAt: now }
    this.devices.update((d) => ({ devices: [...d.devices, device] }))
    return { token, device }
  }

  findDevice(token: string | undefined): Device | null {
    if (!token || !token.startsWith('k0d_') || token.length > 200) return null
    const hash = sha256Hex(token)
    const found = this.devices.get().devices.find((d) => safeEqual(d.tokenHash, hash))
    if (!found) return null
    const now = this.now()
    if (now - found.lastSeenAt > TOUCH_EVERY_MS) {
      this.devices.update((d) => ({ devices: d.devices.map((x) => (x.id === found.id ? { ...x, lastSeenAt: now } : x)) }))
    }
    return found
  }

  deviceStillValid(id: string): boolean {
    return this.devices.get().devices.some((d) => d.id === id)
  }

  listDevices(): Device[] {
    return this.devices.get().devices
  }

  revokeDevice(id: string): boolean {
    let found = false
    this.devices.update((d) => ({ devices: d.devices.filter((x) => { if (x.id === id) { found = true; return false } return true }) }))
    return found
  }

  revokeAllDevices(): number {
    const n = this.devices.get().devices.length
    this.devices.set({ devices: [] })
    return n
  }

  // ── Two-factor (F3) ──────────────────────────────────────────────────────

  totpEnabled(): boolean {
    return !!this.owner.get()?.totp
  }

  /** Starts enrolment: a new secret, active only once a code from it is confirmed. */
  beginTotp(): string {
    const owner = this.owner.get()
    if (!owner) throw new Error('Set up the owner account first: krnl0 setup')
    const secret = newTotpSecret()
    this.owner.set({ ...owner, pendingTotp: { secret, createdAt: new Date(this.now()).toISOString() } })
    return secret
  }

  /** Confirms enrolment with a code; returns the recovery codes (shown once). */
  confirmTotp(code: string): string[] | null {
    const owner = this.owner.get()
    const pending = owner?.pendingTotp
    if (!owner || !pending) return null
    const step = matchTotp(pending.secret, code, this.now(), null)
    if (step === null) return null
    const codes = Array.from({ length: 10 }, () => newRecoveryCode())
    this.owner.set({
      ...owner,
      pendingTotp: null,
      totp: { secret: pending.secret, lastStep: step, recovery: codes.map((c) => sha256Hex(normalizeSetupCode(c))), enabledAt: new Date(this.now()).toISOString() },
    })
    return codes
  }

  disableTotp(): boolean {
    const owner = this.owner.get()
    if (!owner?.totp) return false
    this.owner.set({ ...owner, totp: null, pendingTotp: null })
    return true
  }

  recoveryCodesLeft(): number {
    return this.owner.get()?.totp?.recovery.length ?? 0
  }
}

/** The first-run setup code (F2): memory only, single use, 60 minutes, renewed when it runs out. */
export class SetupCodeKeeper {
  private code: string | null = null
  private expiresAt = 0

  constructor(
    private readonly make: () => string,
    private readonly onNew: (code: string, expiresAt: number) => void,
    private readonly now: () => number = Date.now,
    private readonly ttlMs = 60 * 60_000,
  ) {}

  /** The current code, renewing (and announcing) it when missing or expired. */
  current(): string {
    if (!this.code || this.now() >= this.expiresAt) {
      this.code = this.make()
      this.expiresAt = this.now() + this.ttlMs
      this.onNew(this.code, this.expiresAt)
    }
    return this.code
  }

  /** True once for the right, unexpired code; the code is then spent. An expired code is renewed (and announced). */
  consume(input: string): boolean {
    if (this.code && this.now() >= this.expiresAt) {
      this.current()
      return false
    }
    if (!this.code) return false
    const ok = safeEqual(normalizeSetupCode(input), normalizeSetupCode(this.code))
    if (ok) {
      this.code = null
      this.expiresAt = 0
    }
    return ok
  }

  clear(): void {
    this.code = null
    this.expiresAt = 0
  }
}
