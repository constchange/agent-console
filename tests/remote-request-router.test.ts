import { describe, expect, it } from 'vitest'
import type { AccessTokenVerifier, VerifiedSupabaseClaims } from '../core/auth/supabase-auth-service'
import { RemoteAuthorizationService } from '../core/remote/authorization-service'
import { canonicalRemoteRequest, p256PublicKeyFingerprint } from '../core/remote/device-signature'
import { PairingService } from '../core/remote/pairing-service'
import { RemoteIdempotencyService } from '../core/remote/idempotency-service'
import { CoreRemoteRequestRouter, type RemoteCoreActions } from '../core/remote/request-router'
import { RemoteStore } from '../core/remote/remote-store'
import type {
  RemoteAgentDetail,
  RemoteDashboard,
  RemoteEventsResult,
  RemoteTaskView,
} from '../shared/remote-protocol'
import type { RemotePublicAuthState } from '../shared/remote-validation'
import { p256Fixture, signedEnvelope } from './remote-test-helpers'

const workstationId = '11111111-1111-4111-8111-111111111111'
const deviceId = '22222222-2222-4222-8222-222222222222'
const ownerId = '33333333-3333-4333-8333-333333333333'

class Verifier implements AccessTokenVerifier {
  getPublicState(): RemotePublicAuthState {
    return {
      phase: 'signed_in',
      userId: ownerId,
      email: 'owner@example.com',
      emailConfirmed: true,
      sessionExpiresAt: new Date(Date.now() + 60_000).toISOString(),
      remoteAllowed: true,
      message: 'signed in',
    }
  }

  async verifyAccessToken(): Promise<VerifiedSupabaseClaims> {
    return {
      userId: ownerId,
      email: 'owner@example.com',
      expiresAt: Math.floor(Date.now() / 1_000) + 3_600,
      issuedAt: Math.floor(Date.now() / 1_000),
      sessionId: '66666666-6666-4666-8666-666666666666',
    }
  }
}

function task(id = 'task-current', active = true, agentId = 'agent-1'): RemoteTaskView {
  return {
    id,
    agentId,
    adapter: 'codex-structured',
    status: active ? 'running' : 'completed',
    summary: active ? 'Agent is running.' : 'Agent completed.',
    createdAt: '2026-08-07T10:00:00.000Z',
    updatedAt: '2026-08-07T10:01:00.000Z',
    version: active ? 1 : 2,
    active,
  }
}

function dashboard(): RemoteDashboard {
  return {
    capturedAt: '2026-08-07T10:01:00.000Z',
    agents: [{
      id: 'agent-1',
      projectId: 'project-1',
      name: 'Agent One',
      emoji: 'A',
      color: '#123456',
      status: 'working',
      updatedAt: '2026-08-07T10:01:00.000Z',
      task: task(),
      capabilities: { view: true, viewEvents: true, message: true, approve: true, interrupt: true },
    }, {
      id: 'agent-hidden',
      projectId: 'project-1',
      name: 'Hidden Agent',
      emoji: 'H',
      color: '#654321',
      status: 'working',
      updatedAt: '2026-08-07T10:01:00.000Z',
      task: null,
      capabilities: { view: true, viewEvents: true, message: false, approve: false, interrupt: false },
    }],
    cursor: { streamId: 'source-stream', oldestAvailableSeq: 1, latestSeq: 10 },
  }
}

describe('CoreRemoteRequestRouter', () => {
  it('authenticates in Core, intersects grants, preserves completed-task events and binds streams to one connection', async () => {
    const key = p256Fixture()
    const store = new RemoteStore(':memory:')
    const verifier = new Verifier()
    store.bindWorkstation({ id: workstationId, ownerUserId: ownerId, name: 'Office PC' })
    store.setRemoteEnabled(true)
    store.activateDevice({
      id: deviceId,
      ownerUserId: ownerId,
      publicJwk: key.publicJwk,
      fingerprint: p256PublicKeyFingerprint(key.publicJwk),
      name: 'Phone',
    })
    store.setGrant({
      deviceId,
      agentId: 'agent-1',
      canView: true,
      canMessage: true,
      canInterrupt: false,
      canApprove: false,
    })
    let resetEvents = false
    let cursorBatches = false
    let messageCalls = 0
    const actions: RemoteCoreActions = {
      dashboard,
      agent: (agentId): RemoteAgentDetail => ({
        agent: dashboard().agents.find((agent) => agent.id === agentId)!,
        approvals: [],
        cursor: dashboard().cursor,
      }),
      task: (taskId) => task(taskId, taskId !== 'task-completed', taskId === 'task-hidden' ? 'agent-hidden' : 'agent-1'),
      events: (params): RemoteEventsResult => cursorBatches
        ? params.afterSeq < 12
          ? {
              streamId: 'source-stream', oldestAvailableSeq: 1, latestSeq: 13, resetRequired: false,
              events: [{
                seq: 12, taskId: 'task-hidden', taskVersion: 1, type: 'task.updated', status: 'running',
                summary: 'Hidden task changed.', createdAt: '2026-08-07T10:03:00.000Z',
              }],
            }
          : {
              streamId: 'source-stream', oldestAvailableSeq: 1, latestSeq: 13, resetRequired: false,
              events: [{
                seq: 13, taskId: 'task-current', taskVersion: 1, type: 'task.updated', status: 'running',
                summary: 'Visible task changed.', createdAt: '2026-08-07T10:04:00.000Z',
              }],
            }
        : resetEvents
        ? { streamId: 'source-new', oldestAvailableSeq: 4, latestSeq: 9, events: [], resetRequired: true }
        : {
            streamId: 'source-stream',
            oldestAvailableSeq: 1,
            latestSeq: 11,
            resetRequired: false,
            events: [{
              seq: 11,
              taskId: 'task-completed',
              taskVersion: 2,
              type: 'task.completed',
              status: 'completed',
              summary: 'Agent completed.',
              createdAt: '2026-08-07T10:02:00.000Z',
            }],
          },
      message: (params, effectGuard) => {
        effectGuard()
        messageCalls += 1
        return { ok: true, requestId: params.requestId }
      },
      interrupt: () => ({ ok: true }),
      decideApproval: () => ({ ok: true }),
    }
    const authorization = new RemoteAuthorizationService(store, verifier)
    const pairing = new PairingService(store, verifier)
    const router = new CoreRemoteRequestRouter(actions, authorization, pairing, new RemoteIdempotencyService(store))

    const dashboardResponse = await router.handle(signedEnvelope({ privateKey: key.privateKey, workstationId, deviceId }))
    expect(dashboardResponse.status).toBe(200)
    expect((dashboardResponse.body as RemoteDashboard).agents).toHaveLength(1)
    expect((dashboardResponse.body as RemoteDashboard).agents[0].capabilities).toEqual({
      view: true,
      viewEvents: true,
      message: true,
      approve: false,
      interrupt: false,
    })

    const eventsResponse = await router.handle(signedEnvelope({
      privateKey: key.privateKey,
      workstationId,
      deviceId,
      target: '/v1/events?afterSeq=10',
    }))
    expect((eventsResponse.body as RemoteEventsResult).events).toHaveLength(1)
    expect((eventsResponse.body as RemoteEventsResult).events[0].taskId).toBe('task-completed')

    const messageBody = Buffer.from(JSON.stringify({ expectedTaskVersion: 1, message: 'Continue.' }))
    const messageRequestId = '77777777-7777-4777-8777-777777777777'
    const messageEnvelope = signedEnvelope({
      privateKey: key.privateKey,
      workstationId,
      deviceId,
      method: 'POST',
      target: '/v1/tasks/task-current/messages',
      requestId: messageRequestId,
      body: messageBody,
    })
    expect((await router.handle(messageEnvelope)).status).toBe(200)
    // An exact transport retry has a repeated signature nonce, but it may only
    // read the already-completed durable receipt.
    expect((await router.handle(messageEnvelope)).status).toBe(200)
    // A newly signed retry has a new timestamp/nonce; the outer operation hash
    // intentionally ignores those transport fields and replays the response.
    expect((await router.handle(signedEnvelope({
      privateKey: key.privateKey,
      workstationId,
      deviceId,
      method: 'POST',
      target: '/v1/tasks/task-current/messages',
      requestId: messageRequestId,
      timestampSeconds: Number(messageEnvelope.headers.timestamp) + 1,
      body: messageBody,
    }))).status).toBe(200)
    expect(messageCalls).toBe(1)

    const conflicting = await router.handle(signedEnvelope({
      privateKey: key.privateKey,
      workstationId,
      deviceId,
      method: 'POST',
      target: '/v1/tasks/task-current/messages',
      requestId: messageRequestId,
      body: Buffer.from(JSON.stringify({ expectedTaskVersion: 1, message: 'Different.' })),
    }))
    expect(conflicting).toMatchObject({
      status: 409,
      body: { error: { code: 'IDEMPOTENCY_CONFLICT' } },
    })
    expect(messageCalls).toBe(1)

    const uncertainEnvelope = signedEnvelope({
      privateKey: key.privateKey,
      workstationId,
      deviceId,
      method: 'POST',
      target: '/v1/tasks/task-current/messages',
      requestId: '88888888-8888-4888-8888-888888888888',
      body: messageBody,
    })
    store.claimRequest({
      deviceId,
      requestId: uncertainEnvelope.headers.requestId,
      operationHash: canonicalRemoteRequest(uncertainEnvelope).operationHash,
    })
    store.markRequestUncertain(deviceId, uncertainEnvelope.headers.requestId)
    expect(await router.handle(uncertainEnvelope)).toMatchObject({
      status: 409,
      body: { error: { code: 'ACTION_RESULT_UNCERTAIN' } },
    })
    expect(messageCalls).toBe(1)

    const authenticatedWriteStatuses: number[] = []
    let noncesBeforeLimitedRequest = -1
    for (let index = 1; index <= 6; index += 1) {
      if (index === 6) noncesBeforeLimitedRequest = store.countSeenNonces(deviceId)
      const response = await router.handle(signedEnvelope({
        privateKey: key.privateKey,
        workstationId,
        deviceId,
        method: 'POST',
        target: '/v1/tasks/task-current/messages',
        requestId: `90000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
        body: messageBody,
      }))
      authenticatedWriteStatuses.push(response.status)
    }
    // The five earlier write candidates plus these first five consume the
    // verified device's 10/minute Core budget. Header-only impostors at the
    // HTTP layer cannot reserve this bucket.
    expect(authenticatedWriteStatuses).toEqual([200, 200, 200, 200, 200, 429])
    expect(messageCalls).toBe(6)
    expect(store.countSeenNonces(deviceId)).toBe(noncesBeforeLimitedRequest)

    cursorBatches = true
    const sparseStream = await router.openStream(signedEnvelope({
      privateKey: key.privateKey,
      workstationId,
      deviceId,
      target: '/v1/events/stream?afterSeq=11&streamId=source-stream',
    }), 'gateway-sparse-grants')
    const hidden = await router.pollStream(sparseStream.streamId, 'gateway-sparse-grants')
    expect(hidden.events).toEqual([])
    expect(hidden.currentSeq).toBe(12)
    const visible = await router.pollStream(sparseStream.streamId, 'gateway-sparse-grants')
    expect(visible.events).toMatchObject([{ seq: 13, type: 'task.updated' }])
    expect(visible.currentSeq).toBe(13)
    cursorBatches = false

    resetEvents = true
    const stream = await router.openStream(signedEnvelope({
      privateKey: key.privateKey,
      workstationId,
      deviceId,
      target: '/v1/events/stream?afterSeq=0&streamId=source-old',
    }), 'gateway-connection-1')
    await expect(router.pollStream(stream.streamId, 'gateway-connection-2')).rejects.toMatchObject({ code: 'STREAM_NOT_FOUND' })
    const polled = await router.pollStream(stream.streamId, 'gateway-connection-1')
    expect(polled.events).toMatchObject([{ seq: 0, type: 'stream.reset' }])
    expect(polled.currentSeq).toBe(9)
    router.close()
    pairing.close()
    store.close()
  })
})
