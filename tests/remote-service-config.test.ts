import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { readRemoteServicePrivatePaths } from '../electron/services/remote-service-config'

const fixtures: string[] = []

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((item) => rm(item, { recursive: true, force: true })))
})

describe('Remote desktop service configuration', () => {
  it('extracts only normalized private service paths from a 0600 environment file', async () => {
    const fixture = await mkdtemp(path.join(os.tmpdir(), 'agent-console-remote-service-config-'))
    fixtures.push(fixture)
    const file = path.join(fixture, 'remote.env')
    await writeFile(file, [
      'AGENT_CONSOLE_REMOTE_ARMED=1',
      `AGENT_CONSOLE_SSH_KEY_PATH="${fixture}/id_ed25519"`,
      `AGENT_CONSOLE_SSH_PUBLIC_KEY_PATH="${fixture}/id_ed25519.pub"`,
      `AGENT_CONSOLE_SSH_KNOWN_HOSTS_PATH='${fixture}/known_hosts'`,
      'AGENT_CONSOLE_SUPABASE_PUBLISHABLE_KEY=not-returned',
      '',
    ].join('\n'), { mode: 0o600 })
    await expect(readRemoteServicePrivatePaths(file)).resolves.toEqual({
      sshKeyPath: `${fixture}/id_ed25519`,
      sshPublicKeyPath: `${fixture}/id_ed25519.pub`,
      knownHostsPath: `${fixture}/known_hosts`,
    })
    await chmod(file, 0o644)
    await expect(readRemoteServicePrivatePaths(file)).rejects.toThrow('0600')
  })
})
