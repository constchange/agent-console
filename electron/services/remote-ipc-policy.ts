export interface RemoteIpcEventLike {
  sender: unknown
  senderFrame: unknown
}

export interface RemoteIpcWindowLike {
  isDestroyed(): boolean
  webContents: {
    mainFrame: unknown
  }
}

/** Fail-closed identity and arity check shared by every Remote settings IPC. */
export function assertRemoteIpcInvocation(
  event: RemoteIpcEventLike,
  window: RemoteIpcWindowLike | null,
  args: readonly unknown[],
  expectedArguments: number,
): void {
  if (!window
    || window.isDestroyed()
    || event.sender !== window.webContents
    || event.senderFrame !== window.webContents.mainFrame) {
    throw new Error('Remote settings IPC is available only to the Agent Console main renderer.')
  }
  if (args.length !== expectedArguments) throw new Error('Remote settings IPC arguments are invalid.')
}
