import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const verifier = readFileSync(
  path.resolve(import.meta.dirname, '../scripts/verify-systemd-core.mjs'),
  'utf8',
)

describe('systemd Core release verifier policy', () => {
  it('requires desktop events and rejects raw Gateway subscriptions', () => {
    expect(verifier).toContain("initialized.channel === 'desktop'")
    expect(verifier).toContain("initialized.capabilities?.events === true")
    expect(verifier).toContain("initialized.channel === 'gateway'")
    expect(verifier).toContain("initialized.capabilities?.events === false")
    expect(verifier).toMatch(
      /await expectRpcError\(\s*gatewayRpc,\s*'events\.subscribe',[\s\S]*?CORE_RPC_ERROR\.METHOD_NOT_FOUND,/u,
    )
  })
})
