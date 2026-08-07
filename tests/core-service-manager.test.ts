import { describe, expect, it } from 'vitest'
import { renderCoreServiceUnit } from '../core/services/core-service-unit'
import { compareReleaseVersions } from '../core/services/release-version'
import { privateRemoteEnvironmentFile } from '../core/services/remote-environment-file'
import { chmod, mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

describe('Console Core user service', () => {
  it('never treats an older AppImage as a safe replacement for the stable copy', () => {
    expect(compareReleaseVersions('0.4.1', '0.4.0')).toBe(1)
    expect(compareReleaseVersions('0.4.0', '0.4.0')).toBe(0)
    expect(compareReleaseVersions('0.3.9', '0.4.0')).toBe(-1)
  })

  it('runs as the current user with a private umask and does not kill Agent child processes', () => {
    const unit = renderCoreServiceUnit('/opt/Agent Console/agent-console', '/home/user/.config/Agent Console')
    expect(unit).toContain('ExecStart="/opt/Agent Console/agent-console" --console-core "--console-core-user-data=/home/user/.config/Agent Console"')
    expect(unit).toContain('ExecCondition=/usr/bin/test -x "/opt/Agent Console/agent-console"')
    expect(unit.match(/ExecCondition=/gu)).toHaveLength(1)
    expect(unit).toContain('UMask=0077')
    expect(unit).toContain('KillMode=process')
    expect(unit).toContain('NoNewPrivileges=yes')
    expect(unit).toContain('LockPersonality=yes')
    expect(unit).toContain('RestrictSUIDSGID=yes')
    expect(unit).toContain('--ozone-platform=headless')
    expect(unit).not.toContain('graphical-session.target')
    expect(unit).not.toContain('PrivateTmp=')
    expect(unit).not.toContain('ProtectHome=')
    expect(unit).not.toContain('ListenStream=')
  })

  it('references a private remote.env without copying configuration values into the unit', () => {
    const unit = renderCoreServiceUnit(
      '/usr/bin/agent-console',
      '/home/user/.config/agent-console',
      '/home/user/.config/agent-console/remote/remote.env',
    )
    expect(unit).toContain('EnvironmentFile=-/home/user/.config/agent-console/remote/remote.env')
    expect(unit).not.toContain('AGENT_CONSOLE_SUPABASE_PUBLISHABLE_KEY=')
  })

  it('only exposes an owned 0600 regular remote.env to systemd', async () => {
    const fixture = await mkdtemp(path.join(os.tmpdir(), 'agent-console-core-env-'))
    const remoteDirectory = path.join(fixture, 'agent-console', 'remote')
    await mkdir(remoteDirectory, { recursive: true, mode: 0o700 })
    const environmentFile = path.join(remoteDirectory, 'remote.env')
    await writeFile(environmentFile, 'AGENT_CONSOLE_REMOTE_ARMED=0\n', { mode: 0o600 })
    expect(await privateRemoteEnvironmentFile(fixture)).toBe(environmentFile)
    await chmod(environmentFile, 0o644)
    expect(await privateRemoteEnvironmentFile(fixture)).toBeNull()
    await chmod(environmentFile, 0o600)
    await chmod(remoteDirectory, 0o777)
    expect(await privateRemoteEnvironmentFile(fixture)).toBeNull()
    await chmod(remoteDirectory, 0o700)
    const linkHome = await mkdtemp(path.join(os.tmpdir(), 'agent-console-core-env-link-'))
    await mkdir(path.join(linkHome, 'agent-console', 'remote'), { recursive: true })
    await symlink(environmentFile, path.join(linkHome, 'agent-console', 'remote', 'remote.env'))
    expect(await privateRemoteEnvironmentFile(linkHome)).toBeNull()
    const parentLinkHome = await mkdtemp(path.join(os.tmpdir(), 'agent-console-core-env-parent-link-'))
    await symlink(path.join(fixture, 'agent-console'), path.join(parentLinkHome, 'agent-console'))
    expect(await privateRemoteEnvironmentFile(parentLinkHome)).toBeNull()
    await Promise.all([
      rm(fixture, { recursive: true, force: true }),
      rm(linkHome, { recursive: true, force: true }),
      rm(parentLinkHome, { recursive: true, force: true }),
    ])
  })
})
