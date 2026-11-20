// Argon2id password hashes (F3, Decision S4), PHC string format:
//   $argon2id$v=19$m=19456,t=2,p=1$<salt b64>$<hash b64>

import { argon2, randomBytes, timingSafeEqual } from 'node:crypto'

export const PASSWORD_MIN = 12
export const PASSWORD_MAX = 256

export interface Argon2Params { memory: number; passes: number; parallelism: number }

/** OWASP's Argon2id minimum (19 MiB, 2 passes, 1 lane). */
export const DEFAULT_PARAMS: Argon2Params = { memory: 19456, passes: 2, parallelism: 1 }

const TAG_LENGTH = 32

function derive(password: string, salt: Buffer, p: Argon2Params): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    argon2('argon2id', {
      message: Buffer.from(password.normalize('NFC'), 'utf8'),
      nonce: salt,
      parallelism: p.parallelism,
      tagLength: TAG_LENGTH,
      memory: p.memory,
      passes: p.passes,
    }, (err, key) => (err ? reject(err) : resolve(Buffer.from(key))))
  })
}

/** A password problem in plain words, or null when it is acceptable. */
export function passwordProblem(password: string): string | null {
  const len = [...password.normalize('NFC')].length
  if (len < PASSWORD_MIN) return `The password needs at least ${PASSWORD_MIN} characters.`
  if (len > PASSWORD_MAX) return `The password can have at most ${PASSWORD_MAX} characters.`
  return null
}

export async function hashPassword(password: string, params: Argon2Params = DEFAULT_PARAMS): Promise<string> {
  const salt = randomBytes(16)
  const hash = await derive(password, salt, params)
  return `$argon2id$v=19$m=${params.memory},t=${params.passes},p=${params.parallelism}$${salt.toString('base64')}$${hash.toString('base64')}`
}

const PHC = /^\$argon2id\$v=19\$m=(\d+),t=(\d+),p=(\d+)\$([A-Za-z0-9+/=]+)\$([A-Za-z0-9+/=]+)$/

export async function verifyPassword(password: string, phc: string): Promise<boolean> {
  const m = PHC.exec(phc)
  if (!m) return false
  const params: Argon2Params = { memory: Number(m[1]), passes: Number(m[2]), parallelism: Number(m[3]) }
  const salt = Buffer.from(m[4] ?? '', 'base64')
  const expected = Buffer.from(m[5] ?? '', 'base64')
  if (expected.length !== TAG_LENGTH) return false
  const actual = await derive(password, salt, params)
  return timingSafeEqual(actual, expected)
}

/** True when a stored hash uses weaker parameters than today's default (rehash on next login). */
export function needsRehash(phc: string): boolean {
  const m = PHC.exec(phc)
  if (!m) return true
  return Number(m[1]) < DEFAULT_PARAMS.memory || Number(m[2]) < DEFAULT_PARAMS.passes
}

/** Spend about as long as a real check, so a missing owner is not visible by timing. */
export async function dummyVerify(password: string): Promise<void> {
  await derive(password, Buffer.alloc(16), DEFAULT_PARAMS)
}
