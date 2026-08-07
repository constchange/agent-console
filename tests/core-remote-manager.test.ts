import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  CoreRemoteManager,
  type CoreRemoteComponents,
} from '../core/remote/core-remote-manager'
import type {
  RemoteControlStatus,
  RemoteGrantUpdateInput,
} from '../core/remote/remote-control-service'
import type { CoreRemoteStreamOpenResult } from '../core/remote/request-router'
import { createDefaultState } from '../core/services/state-store'
import {
  CORE_RPC_ERROR,
  DESKTOP_CORE_METHODS,
  GATEWAY_CORE_METHODS,
  type CoreRequestContext,
} from '../shared/core-protocol'
import type { RemoteEventStreamPollResult } from '../shared/remote-validation'

const directories: string[] = []
const workstationId = '11111111-1111-4111-8111-111111111111'
const ownerId = '33333333-3333-4333-8333-333333333333'
const deviceOne = '22222222-2222-4222-8222-222222222222'
const deviceTwo = '44444444-4444-4444-8444-444444444444'

const desktopContext: CoreRequestContext = {
  connectionId: 'desktop-connection',
  channel: 'desktop',
  client: { name: 'test-desktop', version: '0.5.0' },
}
const gatewayContext: CoreRequestContext = {
  connectionId: 'gateway-connection',
  channel: 'gateway',
  client: { name: 'test-gateway', version: '0.5.0' },
}

function environment(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    AGENT_CONSOLE_REMOTE_ARMED: '1',
    AGENT_CONSOLE_SUPABASE_URL: 'https://project.supabase.co',
    AGENT_CONSOLE_SUPABASE_PUBLISHABLE_KEY: `sb_publishable_${'a'.repeat(32)}`,
    AGENT_CONSOLE_PUBLIC_BASE_URL: 'https://remote.example.test',
    AGENT_CONSOLE_GATEWAY_LOCAL_HOST: '127.0.0.1',
    AGENT_CONSOLE_GATEWAY_LOCAL_PORT: '43127',
    ...overrides,
  }
}

function bridgeEnvelope() {
  return {
    method: 'GET',
    target: '/v1/events/stream?afterSeq=0',
    headers: {
      authorization: 'Bearer header.payload.signature',
      protocol: '1',
      workstationId,
      deviceId: deviceOne,
      requestId: '55555555-5555-4555-8555-555555555555',
      timestamp: String(Math.floor(Date.now() / 1_000)),
      nonce: 'A'.repeat(22),
      bodySha256: 'A'.repeat(43),
      signature: 'A'.repeat(86),
    },
    bodyBase64: '',
  }
}

async function temporaryDirectory(): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-console-remote-manager-'))
  directories.push(directory)
  return directory
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })))
})

function status(agentId: string): RemoteControlStatus {
  const now = new Date().toISOString()
  const grant = (deviceId: string, canMessage: boolean) => ({
    deviceId,
    agentId,
    canView: true,
    canMessage,
    canInterrupt: true,
    canApprove: false,
    revision: 1,
    updatedAt: now,
  })
  return {
    auth: {
      phase: 'signed_in',
      userId: ownerId,
      email: 'owner@example.test',
      emailConfirmed: true,
      sessionExpiresAt: new Date(Date.now() + 60_000).toISOString(),
      remoteAllowed: true,
      message: 'Signed in securely.',
    },
    workstation: {
      id: workstationId,
      ownerUserId: ownerId,
      name: 'Office PC',
      remoteEnabled: true,
      authEpoch: 1,
      createdAt: now,
      updatedAt: now,
      pendingCloudSync: false,
    },
    devices: [
      {
        id: deviceOne,
        name: 'Phone',
        fingerprint: 'A'.repeat(43),
        state: 'active',
        pairedAt: now,
        revokedAt: null,
        syncError: '',
        pendingCloudSync: false,
        grants: [grant(deviceOne, true)],
      },
      {
        id: deviceTwo,
        name: 'Tablet',
        fingerprint: 'B'.repeat(43),
        state: 'active',
        pairedAt: now,
        revokedAt: null,
        syncError: '',
        pendingCloudSync: false,
        grants: [grant(deviceTwo, false)],
      },
    ],
    pendingPairings: [],
  }
}

function fakeComponents(initial: RemoteControlStatus): {
  components: CoreRemoteComponents
  grantBatches: RemoteGrantUpdateInput[][]
  closedConnections: string[]
  emit(): void
} {
  let current = initial
  let listener: ((status: RemoteControlStatus) => void) | null = null
  const grantBatches: RemoteGrantUpdateInput[][] = []
  const closedConnections: string[] = []
  const same = async () => current
  const control = {
    initialize: same,
    status: () => current,
    subscribe: (next: (status: RemoteControlStatus) => void) => {
      listener = next
      next(current)
      return () => { listener = null }
    },
    signUp: same,
    resendSignupVerification: async () => undefined,
    signIn: same,
    signOut: same,
    requestPasswordRecovery: same,
    handleAuthCallback: same,
    completePasswordRecovery: same,
    enableRemote: () => current,
    disableRemote: () => current,
    beginPairing: async () => ({ pairingId: '', workstationId, expiresAt: '', qrDataUrl: '' }),
    cancelPairing: () => current,
    confirmPairing: () => current,
    revokeDevice: () => current,
    retryDeviceSync: () => current,
    setGrants: (inputs: RemoteGrantUpdateInput[]) => {
      grantBatches.push(inputs)
      return current
    },
    renameWorkstation: () => current,
    close: async () => undefined,
  }
  const router = {
    handle: vi.fn(async () => ({ status: 200, body: { ok: true } })),
    openStream: vi.fn(async (_envelope, connectionId): Promise<CoreRemoteStreamOpenResult> => ({
      streamId: `stream-${connectionId}`,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    })),
    pollStream: vi.fn(async (_streamId, _connectionId): Promise<RemoteEventStreamPollResult> => ({
      closed: false,
      currentSeq: 0,
      events: [],
    })),
    closeStream: vi.fn(() => true),
    closeConnectionStreams: (connectionId: string) => { closedConnections.push(connectionId) },
    close: () => undefined,
  }
  return {
    components: {
      control,
      router,
      hasPendingAgentSync: () => false,
      close: async () => undefined,
    },
    grantBatches,
    closedConnections,
    emit: () => listener?.(current),
  }
}

describe('CoreRemoteManager production boundary', () => {
  it('exposes only authenticated bridge methods to Gateway', () => {
    expect(GATEWAY_CORE_METHODS).toEqual([
      'remote.health',
      'remote.request',
      'remote.stream.open',
      'remote.stream.poll',
      'remote.stream.close',
    ])
    expect(GATEWAY_CORE_METHODS).not.toContain('remote.events.list' as never)
    expect(GATEWAY_CORE_METHODS).not.toContain('remote.task.message' as never)
    expect(DESKTOP_CORE_METHODS).toContain('remote.settings.get')
    expect(DESKTOP_CORE_METHODS).toContain('remote.auth.completePasswordRecovery')
  })

  it('starts honestly when config is absent or secure storage is unavailable', async () => {
    const directory = await temporaryDirectory()
    const consoleState = createDefaultState()
    const absent = new CoreRemoteManager({
      userDataPath: directory,
      appVersion: '0.5.0',
      startedAt: new Date().toISOString(),
      environment: {},
      actions: {} as never,
      getConsoleState: () => consoleState,
      publishDesktop: () => undefined,
    })
    await absent.start()
    expect(absent.settings()).toMatchObject({
      phase: 'unconfigured',
      secureStorageReady: false,
      capabilities: { canRemoveWorkstation: false },
    })
    await expect(absent.handle('remote.request', { envelope: {} }, gatewayContext)).rejects.toMatchObject({
      code: CORE_RPC_ERROR.NOT_ACTIONABLE,
    })
    await absent.stop()

    const invalid = new CoreRemoteManager({
      userDataPath: directory,
      appVersion: '0.5.0',
      startedAt: new Date().toISOString(),
      environment: environment({ AGENT_CONSOLE_GATEWAY_LOCAL_HOST: '0.0.0.0' }),
      actions: {} as never,
      getConsoleState: () => consoleState,
      publishDesktop: () => undefined,
    })
    await invalid.start()
    expect(invalid.settings()).toMatchObject({
      phase: 'degraded',
      secureStorageReady: false,
      gateway: { enabled: false },
      capabilities: { canEnable: false, canPair: false, canRemoveWorkstation: false },
    })
    await invalid.stop()

    const locked = new CoreRemoteManager({
      userDataPath: directory,
      appVersion: '0.5.0',
      startedAt: new Date().toISOString(),
      environment: environment(),
      safeStorage: null,
      actions: {} as never,
      getConsoleState: () => consoleState,
      publishDesktop: () => undefined,
    })
    await locked.start()
    expect(locked.settings()).toMatchObject({
      phase: 'secure-storage-unavailable',
      secureStorageReady: false,
      gateway: { enabled: false },
      capabilities: { canEnable: false, canPair: false, canRemoveWorkstation: false },
    })
    await locked.stop()
  })

  it('enforces the ARMED kill switch on every request and stream bridge call', async () => {
    const directory = await temporaryDirectory()
    const consoleState = createDefaultState()
    const agentId = consoleState.agents[0].id
    const fake = fakeComponents(status(agentId))
    const manager = new CoreRemoteManager({
      userDataPath: directory,
      appVersion: '0.5.0',
      startedAt: new Date().toISOString(),
      environment: environment({ AGENT_CONSOLE_REMOTE_ARMED: '0' }),
      componentFactory: async () => fake.components,
      actions: {} as never,
      getConsoleState: () => consoleState,
      publishDesktop: () => undefined,
    })
    await manager.start()

    for (const [method, params] of [
      ['remote.request', { envelope: bridgeEnvelope() }],
      ['remote.stream.open', { envelope: bridgeEnvelope() }],
      ['remote.stream.poll', { streamId: 'stream-gateway-connection' }],
    ] as const) {
      await expect(manager.handle(method, params, gatewayContext)).rejects.toMatchObject({
        code: CORE_RPC_ERROR.NOT_ACTIONABLE,
      })
    }
    expect(fake.components.router.handle).not.toHaveBeenCalled()
    expect(fake.components.router.openStream).not.toHaveBeenCalled()
    expect(fake.components.router.pollStream).not.toHaveBeenCalled()
    await manager.stop()
  })

  it('intersects active-device grants, fans updates to every active device and binds streams to connectionId', async () => {
    const directory = await temporaryDirectory()
    const consoleState = createDefaultState()
    const agentId = consoleState.agents[0].id
    const fake = fakeComponents(status(agentId))
    const published: string[] = []
    const manager = new CoreRemoteManager({
      userDataPath: directory,
      appVersion: '0.5.0',
      startedAt: new Date().toISOString(),
      environment: environment(),
      componentFactory: async () => fake.components,
      actions: {} as never,
      getConsoleState: () => consoleState,
      publishDesktop: (type) => published.push(type),
    })
    await manager.start()

    const settings = manager.settings()
    expect(settings.agents[0].permissions).toEqual({
      viewStatus: true,
      viewEvents: true,
      message: false,
      approve: false,
      interrupt: true,
    })
    expect(settings.capabilities.canRemoveWorkstation).toBe(false)
    await manager.handle('remote.agent.setPermission', {
      agentId,
      permissions: { viewStatus: true, viewEvents: true, message: true, approve: false, interrupt: false },
    }, desktopContext)
    expect(fake.grantBatches).toHaveLength(1)
    expect(fake.grantBatches[0].map((call) => call.deviceId)).toEqual([deviceOne, deviceTwo])
    await expect(manager.handle('remote.agent.setPermission', {
      agentId,
      permissions: { viewStatus: true, viewEvents: false, message: false, approve: false, interrupt: false },
    }, desktopContext)).rejects.toMatchObject({ code: CORE_RPC_ERROR.INVALID_PARAMS })

    const opened = await manager.handle('remote.stream.open', { envelope: bridgeEnvelope() }, gatewayContext) as CoreRemoteStreamOpenResult
    expect(opened.streamId).toBe('stream-gateway-connection')
    manager.closeConnection('gateway-connection')
    expect(fake.closedConnections).toEqual(['gateway-connection'])
    fake.emit()
    expect(published).toContain('remote.settings')
    await manager.stop()
  })
})
