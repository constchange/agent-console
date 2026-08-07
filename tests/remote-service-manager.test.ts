import { execFile } from 'node:child_process'
import { chmod, mkdtemp, mkdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'
import { renderGatewayServiceUnit, renderTunnelServiceUnit } from '../core/services/remote-service-unit'
import {
  RemoteServiceManager,
  type RemoteServiceManagerOptions,
} from '../electron/services/remote-service-manager'

const execFileAsync = promisify(execFile)
const projectRoot = path.resolve(import.meta.dirname, '..')
const fixtures: string[] = []

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((fixture) => rm(fixture, { recursive: true, force: true })))
})

async function createFixture(packagedRemoteDirectory = path.join(projectRoot, 'resources', 'remote')): Promise<{
  fixture: string
  options: RemoteServiceManagerOptions
  secret: string
}> {
  const fixture = await mkdtemp(path.join(os.tmpdir(), 'agent-console-remote-manager-'))
  fixtures.push(fixture)
  const config = path.join(fixture, 'config')
  const data = path.join(fixture, 'data')
  const systemd = path.join(fixture, 'systemd')
  const runtime = path.join(fixture, 'run')
  const appDirectory = path.join(fixture, 'app')
  const appExecutable = path.join(appDirectory, 'Agent-Console.AppImage')
  const secret = 'sb_publishable_must_stay_only_in_remote_env_1234567890'
  await Promise.all([
    mkdir(config, { recursive: true, mode: 0o700 }),
    mkdir(systemd, { recursive: true, mode: 0o700 }),
    mkdir(appDirectory, { recursive: true, mode: 0o700 }),
  ])
  const environmentFile = path.join(config, 'remote.env')
  const sshKeyPath = path.join(config, 'id_ed25519')
  const sshPublicKeyPath = path.join(config, 'id_ed25519.pub')
  const knownHostsPath = path.join(config, 'known_hosts')
  await Promise.all([
    writeFile(environmentFile, `AGENT_CONSOLE_SUPABASE_PUBLISHABLE_KEY=${secret}\n`, { mode: 0o600 }),
    writeFile(sshKeyPath, 'private-key-fixture\n', { mode: 0o600 }),
    writeFile(sshPublicKeyPath, 'ssh-ed25519 public-key-fixture\n', { mode: 0o644 }),
    writeFile(knownHostsPath, 'remote.example ssh-ed25519 host-key-fixture\n', { mode: 0o600 }),
    writeFile(appExecutable, '#!/bin/sh\nexec node "$@"\n', { mode: 0o700 }),
  ])
  const options: RemoteServiceManagerOptions = {
    appExecutable,
    launcher: path.join(data, 'bin', 'agent-console-remote-service'),
    packagedRemoteDirectory,
    remoteEnvironmentFile: environmentFile,
    gatewaySocketPath: path.join(runtime, 'gateway', 'core.sock'),
    desktopCoreSocketPath: path.join(runtime, 'desktop', 'core.sock'),
    sshKeyPath,
    sshPublicKeyPath,
    knownHostsPath,
    systemdUserDirectory: systemd,
  }
  await Promise.all([
    writeFile(path.join(systemd, 'agent-console-gateway.service'), renderGatewayServiceUnit({
      executable: options.appExecutable,
      remoteEnvironmentFile: options.remoteEnvironmentFile,
      gatewaySocketPath: options.gatewaySocketPath,
      desktopCoreSocketPath: options.desktopCoreSocketPath,
    }), { mode: 0o600 }),
    writeFile(path.join(systemd, 'agent-console-tunnel.service'), renderTunnelServiceUnit({
      launcher: options.launcher,
      remoteEnvironmentFile: options.remoteEnvironmentFile,
      sshKeyPath: options.sshKeyPath,
      sshPublicKeyPath: options.sshPublicKeyPath,
      knownHostsPath: options.knownHostsPath,
    }), { mode: 0o600 }),
  ])
  return { fixture, options, secret }
}

describe('Remote service runtime bootstrap', () => {
  it('atomically installs a private CLI and stable launcher from packaged resources', async () => {
    const { options, secret } = await createFixture()
    const manager = new RemoteServiceManager(options)

    await manager.prepare()

    const installedCli = path.join(path.dirname(path.dirname(options.launcher)), 'cli', 'agent-console-remote.mjs')
    const [launcher, cli, launcherStat, cliStat] = await Promise.all([
      readFile(options.launcher, 'utf8'),
      readFile(installedCli, 'utf8'),
      stat(options.launcher),
      stat(installedCli),
    ])
    expect(launcher).toContain(`ELECTRON_RUN_AS_NODE=1 '${options.appExecutable}' '${installedCli}' "$@"`)
    expect(cli).toBe(await readFile(path.join(options.packagedRemoteDirectory, 'cli', 'agent-console-remote.mjs'), 'utf8'))
    expect(launcher).not.toContain(secret)
    expect(cli).not.toContain(secret)
    expect(launcherStat.mode & 0o777).toBe(0o700)
    expect(cliStat.mode & 0o777).toBe(0o700)
    expect(launcherStat.nlink).toBe(1)
    expect(cliStat.nlink).toBe(1)

    const help = await execFileAsync(options.launcher, ['help'], { timeout: 10_000 })
    expect(help.stdout).toContain('Remote deployment helper')
  })

  it('refuses to replace a linked launcher and leaves its target untouched', async () => {
    const { fixture, options } = await createFixture()
    const sentinel = path.join(fixture, 'sentinel')
    await writeFile(sentinel, 'do-not-replace\n', { mode: 0o600 })
    await mkdir(path.dirname(options.launcher), { recursive: true, mode: 0o700 })
    await symlink(sentinel, options.launcher)

    await expect(new RemoteServiceManager(options).prepare()).rejects.toThrow('unsafe Remote runtime file')
    await expect(readFile(sentinel, 'utf8')).resolves.toBe('do-not-replace\n')
  })

  it('rejects a linked packaged CLI instead of copying through it', async () => {
    const packaged = await mkdtemp(path.join(os.tmpdir(), 'agent-console-linked-remote-'))
    fixtures.push(packaged)
    await mkdir(path.join(packaged, 'cli'), { recursive: true, mode: 0o755 })
    await symlink(
      path.join(projectRoot, 'resources', 'remote', 'cli', 'agent-console-remote.mjs'),
      path.join(packaged, 'cli', 'agent-console-remote.mjs'),
    )
    const { options } = await createFixture(packaged)

    await expect(new RemoteServiceManager(options).prepare()).rejects.toThrow('trusted packaged regular file')
  })

  it('rejects a group/world-writable SSH public key while allowing mode 0644', async () => {
    const { options } = await createFixture()
    const manager = new RemoteServiceManager(options)

    await expect(manager.installUnits()).resolves.toEqual({ changed: false })
    await chmod(options.sshPublicKeyPath, 0o666)
    await expect(manager.installUnits()).rejects.toThrow('must not be writable by group or other users')
  })

  it('refuses to generate a launcher for a group/world-writable runtime executable', async () => {
    const { options } = await createFixture()
    await chmod(options.appExecutable, 0o722)

    await expect(new RemoteServiceManager(options).prepare()).rejects.toThrow('trusted executable regular file')
  })
})
