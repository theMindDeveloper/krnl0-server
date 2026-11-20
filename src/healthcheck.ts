// Docker HEALTHCHECK: is the server answering on this machine? Exit 0 or 1.

import http from 'node:http'
import https from 'node:https'
import { loadConfig } from './config.js'
import { dataPaths, defaultDataDir } from './paths.js'

const cfg = loadConfig(dataPaths(defaultDataDir()).config)
const host = cfg.bind === '0.0.0.0' || cfg.bind === '::' ? '127.0.0.1' : cfg.bind
const opts = { host, port: cfg.port, path: '/api/v1/health', timeout: 4000 }
// Liveness only, on the loopback address: the certificate is checked by real clients.
const req = cfg.tls.mode === 'proxy'
  ? http.get(opts, (res) => { res.resume(); process.exit(res.statusCode === 200 ? 0 : 1) })
  : https.get({ ...opts, rejectUnauthorized: false }, (res) => { res.resume(); process.exit(res.statusCode === 200 ? 0 : 1) })
req.on('timeout', () => { req.destroy(); process.exit(1) })
req.on('error', () => process.exit(1))
