// The data folder (Decisions S5, S6). Everything the server keeps lives here.
//
//   <data>/config.json                 settings (krnl0 setup / config set)
//   <data>/format.json                 data format + last server version that ran
//   <data>/server.lock                 pid of the running server
//   <data>/tls/                        CA and server certificate with their private keys (0600)
//   <data>/public/ca.crt               the CA certificate alone (safe to share with a proxy)
//   <data>/auth/                       owner.json, sessions.json, devices.json
//   <data>/users/owner/docs/           documents (<name>.json + <name>.meta.json)
//   <data>/users/owner/timelog/<id>/   time log, YYYY-MM.jsonl per board
//   <data>/users/owner/assets/         images and media
//   <data>/backups/<stamp>/            backups (F15)
//   <data>/state/                      update check

import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

export const OWNER = 'owner'

export interface DataPaths {
  root: string
  config: string
  format: string
  lock: string
  tls: string
  auth: string
  owner: string
  sessions: string
  devices: string
  user: string
  docs: string
  timelog: string
  assets: string
  backups: string
  state: string
}

export function defaultDataDir(env: NodeJS.ProcessEnv = process.env): string {
  if (env.KRNL0_DATA_DIR) return resolve(env.KRNL0_DATA_DIR)
  return join(homedir(), '.krnl0-server')
}

export function dataPaths(root: string): DataPaths {
  const user = join(root, 'users', OWNER)
  const auth = join(root, 'auth')
  return {
    root,
    config: join(root, 'config.json'),
    format: join(root, 'format.json'),
    lock: join(root, 'server.lock'),
    tls: join(root, 'tls'),
    auth,
    owner: join(auth, 'owner.json'),
    sessions: join(auth, 'sessions.json'),
    devices: join(auth, 'devices.json'),
    user,
    docs: join(user, 'docs'),
    timelog: join(user, 'timelog'),
    assets: join(user, 'assets'),
    backups: join(root, 'backups'),
    state: join(root, 'state'),
  }
}
