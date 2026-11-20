// What GET /api/v1/server says about updates (F31): the check, how this server
// updates, the updater's last job, and auto on/off.

import type { UpdateInfo } from './check.js'
import { readAuto, readStatus, type Job } from './files.js'

const RELEASES = 'https://github.com/theMindDeveloper/krnl0-server/releases/latest/download'
export const DOCKER_INSTALL = `curl -fsSL ${RELEASES}/docker.sh | sh`
export const DOCKER_INSTALL_WINDOWS = `irm ${RELEASES}/docker.ps1 | iex`
export const LINUX_INSTALL = `curl -fsSL ${RELEASES}/install.sh | sh`
export const COMPOSE_UPDATE = 'cd ~/krnl0 && docker compose pull && docker compose up -d'

export type Channel = 'one-click' | 'command' | 'none'

export interface ServerUpdate extends UpdateInfo {
  channel: Channel
  /** The command to run on the server when it can't update itself (channel 'command'). */
  command: string | null
  commandWindows: string | null
  /** Why this server can't update itself, in plain words. */
  reason: string | null
  auto: boolean
  job: Job | null
}

export interface InstallFacts {
  env: NodeJS.ProcessEnv
  inDocker: boolean
  /** The program path (process.argv[1]): a Linux bundle runs from /opt/krnl0. */
  program: string
  now: number
}

export function serverUpdate(check: UpdateInfo, updateDir: string, f: InstallFacts): ServerUpdate {
  const status = readStatus(updateDir)
  const kind = f.env.KRNL0_UPDATER
  const autoDefault = f.env.KRNL0_AUTO_UPDATE === 'on'
  const base = { ...check, auto: readAuto(updateDir, autoDefault), job: status?.job ?? null, command: null, commandWindows: null, reason: null }
  const aliveFor = (ms: number): boolean => !!status && f.now - Date.parse(status.updater.aliveAt) < ms

  if (kind === 'docker') {
    const tag = f.env.KRNL0_IMAGE_TAG ?? 'latest'
    if (tag !== 'latest' && tag !== '') {
      return { ...base, channel: 'command', command: COMPOSE_UPDATE, commandWindows: null, reason: `This server is pinned to ${tag} (KRNL0_VERSION in ~/krnl0/.env). Change it there, then run the command.` }
    }
    // Alive: a heartbeat in the last 3 minutes, or an update running (a slow pull) in the last 45.
    if (status?.updater.kind === 'docker' && (aliveFor(3 * 60_000) || (status.job.state === 'running' && aliveFor(45 * 60_000)))) return { ...base, channel: 'one-click' }
    return { ...base, channel: 'command', command: COMPOSE_UPDATE, commandWindows: null, reason: 'The updater container is not running. Run the command once on the server, or start it: docker compose up -d.' }
  }
  // The helper writes its status as it runs; `sudo krnl0 update` runs without the unit's env.
  if (!f.inDocker && status?.updater.kind === 'systemd') return { ...base, channel: 'one-click' }
  if (f.inDocker) {
    return { ...base, channel: 'command', command: DOCKER_INSTALL, commandWindows: DOCKER_INSTALL_WINDOWS, reason: 'This server was started with plain docker run. Run this once on the server: it keeps your data and adds the updater, so later updates are one click.' }
  }
  if (f.program.startsWith('/opt/krnl0/') || kind === 'systemd') {
    return { ...base, channel: 'command', command: LINUX_INSTALL, commandWindows: null, reason: 'Run this once on the server: it updates and adds the updater, so later updates are one click.' }
  }
  return { ...base, channel: 'none', reason: 'This server runs from source; update it with git.' }
}
