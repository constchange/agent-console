import { describe, expect, it } from 'vitest'
import { renderGatewayServiceUnit, renderTunnelServiceUnit } from '../core/services/remote-service-unit'

describe('Remote systemd unit rendering', () => {
  it('isolates the Gateway from the desktop socket and non-loopback IP traffic', () => {
    const unit = renderGatewayServiceUnit({
      executable: '/opt/Agent Console/agent-console',
      remoteEnvironmentFile: '/home/operator/.config/agent-console/remote/remote.env',
      gatewaySocketPath: '/run/user/1000/agent-console/gateway/core.sock',
      desktopCoreSocketPath: '/run/user/1000/agent-console/desktop/core.sock',
      applicationReadOnlyPath: '/opt/Agent Console',
    })

    expect(unit).toContain('EnvironmentFile=-/home/operator/.config/agent-console/remote/remote.env')
    expect(unit).toContain('ExecStart="/opt/Agent Console/agent-console" --disable-gpu --ozone-platform=headless --remote-gateway ')
    expect(unit).toContain('"--remote-gateway-socket=/run/user/1000/agent-console/gateway/core.sock"')
    expect(unit).toContain('InaccessiblePaths=/run/user/1000/agent-console/desktop/core.sock')
    expect(unit).toContain('IPAddressDeny=any')
    expect(unit).toContain('IPAddressAllow=localhost')
    expect(unit).toContain('ProtectHome=tmpfs')
    expect(unit).toContain('BindReadOnlyPaths=/opt/Agent\\x20Console')
  })

  it('allows the autossh unit to reach the VPS but binds only declared files', () => {
    const unit = renderTunnelServiceUnit({
      launcher: '/opt/Agent Console/resources/remote/bin/agent-console-remote',
      remoteEnvironmentFile: '/home/operator/.config/agent-console/remote/remote.env',
      sshKeyPath: '/home/operator/.config/agent-console/remote/ssh/id_ed25519',
      sshPublicKeyPath: '/home/operator/.config/agent-console/remote/ssh/id_ed25519.pub',
      knownHostsPath: '/home/operator/.config/agent-console/remote/ssh/known_hosts',
    })

    expect(unit).toContain('agent-console-remote" tunnel-run')
    expect(unit).toContain('BindReadOnlyPaths=/home/operator/.config/agent-console/remote/remote.env')
    expect(unit).toContain('BindReadOnlyPaths=/home/operator/.config/agent-console/remote/ssh/id_ed25519')
    expect(unit).toContain('BindReadOnlyPaths=/home/operator/.config/agent-console/remote/ssh/id_ed25519.pub')
    expect(unit).toContain('BindReadOnlyPaths=/home/operator/.config/agent-console/remote/ssh/known_hosts')
    expect(unit).toContain('BindReadOnlyPaths=/opt/Agent\\x20Console/resources/remote')
    expect(unit).not.toContain('IPAddressDeny=any')
    expect(unit).toContain('PartOf=agent-console-gateway.service')
  })

  it('rejects relative paths and socket aliasing', () => {
    expect(() => renderGatewayServiceUnit({
      executable: 'agent-console',
      remoteEnvironmentFile: '/tmp/remote.env',
      gatewaySocketPath: '/tmp/gateway.sock',
      desktopCoreSocketPath: '/tmp/desktop.sock',
    })).toThrow(/absolute path/u)

    expect(() => renderGatewayServiceUnit({
      executable: '/usr/bin/agent-console',
      remoteEnvironmentFile: '/tmp/remote.env',
      gatewaySocketPath: '/tmp/core.sock',
      desktopCoreSocketPath: '/tmp/core.sock',
    })).toThrow(/must be different/u)
  })
})
