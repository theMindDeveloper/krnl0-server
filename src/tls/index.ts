// TLS modes (F7, Decision S3): self-signed (default), files, proxy.

import { readFileSync, statSync } from 'node:fs'
import { createSecureContext } from 'node:tls'
import * as x509 from '@peculiar/x509'
import type { Config, TlsMode } from '../config.js'
import type { DataPaths } from '../paths.js'
import { log } from '../log.js'
import { ensureSelfSigned, localNames } from './selfsigned.js'

export interface TlsMaterial { key: string; cert: string }

export interface TlsInfo {
  mode: TlsMode
  /** The server itself speaks HTTPS (false only in proxy mode). */
  secure: boolean
  /** The certificate is publicly trusted, so HSTS is safe to send (NF5). */
  trusted: boolean
  /** CA fingerprint in self-signed mode — what the desktop app pins (F8). */
  fingerprint: string | null
  caPem: string | null
  names: string[]
  notAfter: Date | null
}

const CHECK_EVERY_MS = 12 * 3600_000

function certInfo(certPem: string): { names: string[]; notAfter: Date } {
  const first = certPem.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/)?.[0]
  if (!first) throw new Error('The certificate file holds no certificate.')
  const cert = new x509.X509Certificate(first)
  const san = cert.getExtension(x509.SubjectAlternativeNameExtension)
  const names = san ? san.names.toJSON().map((n) => n.value) : []
  return { names, notAfter: cert.notAfter }
}

export class TlsManager {
  private listeners: Array<(m: TlsMaterial) => void> = []
  private timer: NodeJS.Timeout | null = null
  private filesStamp = ''

  private constructor(
    private readonly cfg: Config,
    private readonly paths: DataPaths,
    private state: TlsInfo,
    private mat: TlsMaterial | null,
  ) {}

  static async create(cfg: Config, paths: DataPaths): Promise<TlsManager> {
    const m = new TlsManager(cfg, paths, { mode: cfg.tls.mode, secure: cfg.tls.mode !== 'proxy', trusted: false, fingerprint: null, caPem: null, names: [], notAfter: null }, null)
    await m.refresh(true)
    return m
  }

  info(): TlsInfo { return this.state }
  material(): TlsMaterial | null { return this.mat }

  onChange(cb: (m: TlsMaterial) => void): void { this.listeners.push(cb) }

  startRenewal(): void {
    if (this.timer || this.cfg.tls.mode === 'proxy') return
    this.timer = setInterval(() => {
      this.refresh(false).catch((err: unknown) => log.error('Could not renew the certificate', { reason: err instanceof Error ? err.message : String(err) }))
    }, this.cfg.tls.mode === 'files' ? 3600_000 : CHECK_EVERY_MS)
    this.timer.unref()
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  private emit(m: TlsMaterial): void {
    for (const cb of this.listeners) cb(m)
  }

  private async refresh(first: boolean): Promise<void> {
    const mode = this.cfg.tls.mode
    if (mode === 'proxy') {
      this.state = { ...this.state, secure: false, trusted: true }
      return
    }
    if (mode === 'self-signed') {
      const s = await ensureSelfSigned(this.paths.tls, localNames(this.cfg.hosts))
      this.mat = { key: s.keyPem, cert: s.certPem }
      this.state = { mode, secure: true, trusted: false, fingerprint: s.fingerprint, caPem: s.caPem, names: s.names, notAfter: s.notAfter }
      if (s.renewed && !first) {
        log.info('Made a new certificate', { until: s.notAfter.toISOString().slice(0, 10) })
        this.emit(this.mat)
      }
      return
    }
    // files
    const certFile = this.cfg.tls.certFile ?? ''
    const keyFile = this.cfg.tls.keyFile ?? ''
    const stamp = `${statSync(certFile).mtimeMs}:${statSync(keyFile).mtimeMs}`
    if (stamp === this.filesStamp) return
    const cert = readFileSync(certFile, 'utf8')
    const key = readFileSync(keyFile, 'utf8')
    createSecureContext({ cert, key }) // throws when the key does not match the certificate
    const info = certInfo(cert)
    this.filesStamp = stamp
    this.mat = { key, cert }
    this.state = { mode, secure: true, trusted: true, fingerprint: null, caPem: null, names: info.names, notAfter: info.notAfter }
    if (!first) {
      log.info('Loaded the renewed certificate files', { until: info.notAfter.toISOString().slice(0, 10) })
      this.emit(this.mat)
    }
  }
}
