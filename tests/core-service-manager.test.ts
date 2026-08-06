import { describe, expect, it } from 'vitest'
import { renderCoreServiceUnit } from '../core/services/core-service-unit'
import { compareReleaseVersions } from '../core/services/release-version'

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
})
