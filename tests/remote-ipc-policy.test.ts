import { describe, expect, it } from 'vitest'
import { assertRemoteIpcInvocation } from '../electron/services/remote-ipc-policy'

describe('Remote settings IPC policy', () => {
  const mainFrame = {}
  const webContents = { mainFrame }
  const window = { isDestroyed: () => false, webContents }

  it('accepts only the expected main-window sender, frame, and arity', () => {
    expect(() => assertRemoteIpcInvocation(
      { sender: webContents, senderFrame: mainFrame },
      window,
      [{}],
      1,
    )).not.toThrow()
    expect(() => assertRemoteIpcInvocation(
      { sender: webContents, senderFrame: {} },
      window,
      [{}],
      1,
    )).toThrow('main renderer')
    expect(() => assertRemoteIpcInvocation(
      { sender: { mainFrame }, senderFrame: mainFrame },
      window,
      [{}],
      1,
    )).toThrow('main renderer')
    expect(() => assertRemoteIpcInvocation(
      { sender: webContents, senderFrame: mainFrame },
      window,
      [{}, 'smuggled'],
      1,
    )).toThrow('arguments')
  })

  it('fails closed without a live main window', () => {
    const event = { sender: webContents, senderFrame: mainFrame }
    expect(() => assertRemoteIpcInvocation(event, null, [], 0)).toThrow('main renderer')
    expect(() => assertRemoteIpcInvocation(
      event,
      { isDestroyed: () => true, webContents },
      [],
      0,
    )).toThrow('main renderer')
  })
})
