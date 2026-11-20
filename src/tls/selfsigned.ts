// Self-signed mode (F7, F8, Decision S3): the server's own certificate
// authority and a leaf certificate for every name it can be reached by.

import { createHash, randomBytes, webcrypto } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { hostname, networkInterfaces } from 'node:os'
import { isIP } from 'node:net'
import { dirname, join } from 'node:path'
import * as x509 from '@peculiar/x509'
import { ensureDir, writeFileAtomic, writeJsonAtomic } from '../fsutil.js'

x509.cryptoProvider.set(webcrypto as unknown as Parameters<typeof x509.cryptoProvider.set>[0])

const ALG = { name: 'ECDSA', namedCurve: 'P-256', hash: 'SHA-256' } as const
const SIGN = { name: 'ECDSA', hash: 'SHA-256' } as const
const DAY = 24 * 3600_000
export const CA_DAYS = 3650
export const LEAF_DAYS = 397
export const RENEW_BEFORE_DAYS = 30

export interface SelfSigned {
  caPem: string
  certPem: string
  keyPem: string
  /** SHA-256 of the CA certificate, "AB:CD:…" — what the app pins. */
  fingerprint: string
  names: string[]
  notAfter: Date
  /** True when this call made a new leaf certificate. */
  renewed: boolean
}

/** localhost, the host name, every non-internal IP, plus `extra`. */
export function localNames(extra: string[] = []): string[] {
  const names = new Set<string>(['localhost', '127.0.0.1', '::1'])
  const host = hostname().toLowerCase()
  if (host) {
    names.add(host)
    if (!host.includes('.')) names.add(`${host}.local`)
  }
  for (const list of Object.values(networkInterfaces())) {
    for (const addr of list ?? []) {
      if (addr.internal) continue
      if (addr.family === 'IPv6' && addr.address.toLowerCase().startsWith('fe80')) continue
      names.add(addr.address)
    }
  }
  for (const e of extra) {
    const v = e.trim().toLowerCase()
    if (v) names.add(v)
  }
  return [...names].sort()
}

function pem(label: string, der: ArrayBuffer): string {
  const b64 = Buffer.from(der).toString('base64').replace(/(.{64})/g, '$1\n').trimEnd()
  return `-----BEGIN ${label}-----\n${b64}\n-----END ${label}-----\n`
}

function derOf(pemText: string): Buffer {
  return Buffer.from(pemText.replace(/-----[^-]+-----/g, '').replace(/\s+/g, ''), 'base64')
}

export function fingerprintOf(certPem: string): string {
  const hex = createHash('sha256').update(derOf(certPem)).digest('hex').toUpperCase()
  return hex.match(/.{2}/g)?.join(':') ?? hex
}

/** A positive random serial number. */
function serial(): string {
  const b = randomBytes(16)
  b[0] = (b[0] ?? 0) & 0x7f
  return b.toString('hex')
}

function sanEntries(names: string[]): x509.JsonGeneralName[] {
  return names.map((n) => (isIP(n) ? { type: 'ip' as const, value: n } : { type: 'dns' as const, value: n }))
}

async function makeCa(now: Date): Promise<{ certPem: string; keyPem: string }> {
  const keys = await webcrypto.subtle.generateKey(ALG, true, ['sign', 'verify'])
  const cert = await x509.X509CertificateGenerator.createSelfSigned({
    serialNumber: serial(),
    name: `CN=KRNL0 server CA ${randomBytes(3).toString('hex')}, O=KRNL0 self-hosted`,
    notBefore: new Date(now.getTime() - 3600_000),
    notAfter: new Date(now.getTime() + CA_DAYS * DAY),
    keys,
    signingAlgorithm: SIGN,
    extensions: [
      new x509.BasicConstraintsExtension(true, 0, true),
      new x509.KeyUsagesExtension(x509.KeyUsageFlags.keyCertSign | x509.KeyUsageFlags.cRLSign, true),
      await x509.SubjectKeyIdentifierExtension.create(keys.publicKey),
    ],
  })
  const keyDer = await webcrypto.subtle.exportKey('pkcs8', keys.privateKey)
  return { certPem: cert.toString('pem') + '\n', keyPem: pem('PRIVATE KEY', keyDer) }
}

async function makeLeaf(caCertPem: string, caKeyPem: string, names: string[], now: Date): Promise<{ certPem: string; keyPem: string; notAfter: Date }> {
  const ca = new x509.X509Certificate(caCertPem)
  const caKey = await webcrypto.subtle.importKey('pkcs8', derOf(caKeyPem), ALG, false, ['sign'])
  const keys = await webcrypto.subtle.generateKey(ALG, true, ['sign', 'verify'])
  const notAfter = new Date(now.getTime() + LEAF_DAYS * DAY)
  const cn = names.find((n) => !isIP(n) && n !== 'localhost') ?? 'krnl0'
  const cert = await x509.X509CertificateGenerator.create({
    serialNumber: serial(),
    subject: `CN=${cn}`,
    issuer: ca.subject,
    notBefore: new Date(now.getTime() - 3600_000),
    notAfter,
    signingKey: caKey,
    publicKey: keys.publicKey,
    signingAlgorithm: SIGN,
    extensions: [
      new x509.BasicConstraintsExtension(false, undefined, true),
      new x509.KeyUsagesExtension(x509.KeyUsageFlags.digitalSignature, true),
      new x509.ExtendedKeyUsageExtension([x509.ExtendedKeyUsage.serverAuth], false),
      new x509.SubjectAlternativeNameExtension(sanEntries(names), false),
      await x509.AuthorityKeyIdentifierExtension.create(ca, false),
      await x509.SubjectKeyIdentifierExtension.create(keys.publicKey),
    ],
  })
  const keyDer = await webcrypto.subtle.exportKey('pkcs8', keys.privateKey)
  // Serve the chain, so a device that trusts the CA can verify the leaf.
  return { certPem: cert.toString('pem') + '\n' + caCertPem, keyPem: pem('PRIVATE KEY', keyDer), notAfter }
}

/**
 * Makes the CA once, and the leaf when it is missing, expires within 30 days,
 * or the names changed. Keys are written 0600.
 */
export async function ensureSelfSigned(tlsDir: string, names: string[], now = new Date()): Promise<SelfSigned> {
  ensureDir(tlsDir)
  const caCert = join(tlsDir, 'ca.crt')
  const caKey = join(tlsDir, 'ca.key')
  const leafCert = join(tlsDir, 'server.crt')
  const leafKey = join(tlsDir, 'server.key')
  const meta = join(tlsDir, 'server.json')

  if (!existsSync(caCert) || !existsSync(caKey)) {
    const ca = await makeCa(now)
    writeFileAtomic(caKey, ca.keyPem, 0o600)
    writeFileAtomic(caCert, ca.certPem, 0o644)
    // A new CA invalidates any old leaf.
    writeFileAtomic(leafCert, '', 0o644)
  }
  const caPem = readFileSync(caCert, 'utf8')
  const caKeyPem = readFileSync(caKey, 'utf8')
  // A copy with nothing secret next to it, for a reverse proxy to trust (compose "domain" profile).
  ensureDir(join(dirname(tlsDir), 'public'), 0o755)
  writeFileAtomic(join(dirname(tlsDir), 'public', 'ca.crt'), caPem, 0o644)

  let renewed = false
  let current: { names: string[]; notAfter: string } | null = null
  try { current = JSON.parse(readFileSync(meta, 'utf8')) as { names: string[]; notAfter: string } } catch { current = null }
  const leafText = existsSync(leafCert) ? readFileSync(leafCert, 'utf8') : ''
  const sameNames = current !== null && JSON.stringify([...current.names].sort()) === JSON.stringify([...names].sort())
  const fresh = current !== null && new Date(current.notAfter).getTime() - now.getTime() > RENEW_BEFORE_DAYS * DAY
  let notAfter = current ? new Date(current.notAfter) : now
  if (!leafText.includes('BEGIN CERTIFICATE') || !existsSync(leafKey) || !sameNames || !fresh) {
    const leaf = await makeLeaf(caPem, caKeyPem, names, now)
    writeFileAtomic(leafKey, leaf.keyPem, 0o600)
    writeFileAtomic(leafCert, leaf.certPem, 0o644)
    writeJsonAtomic(meta, { names, notAfter: leaf.notAfter.toISOString() }, 0o644)
    notAfter = leaf.notAfter
    renewed = true
  }
  return {
    caPem,
    certPem: readFileSync(leafCert, 'utf8'),
    keyPem: readFileSync(leafKey, 'utf8'),
    fingerprint: fingerprintOf(caPem),
    names,
    notAfter,
    renewed,
  }
}
