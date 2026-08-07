const MAX_AUTH_CALLBACK_BYTES = 4_096
const AUTH_CODE_PATTERN = /^[A-Za-z0-9._~-]{8,2048}$/

/** Strictly validates the only custom-protocol URL accepted by the desktop. */
export function validateAuthCallbackUrl(input: unknown): string {
  if (typeof input !== 'string'
    || Buffer.byteLength(input, 'utf8') > MAX_AUTH_CALLBACK_BYTES
    || /[\0\r\n]/.test(input)) {
    throw new Error('Authentication callback is invalid.')
  }
  let callback: URL
  try {
    callback = new URL(input)
  } catch {
    throw new Error('Authentication callback is invalid.')
  }
  if (callback.protocol !== 'agent-console:'
    || callback.hostname !== 'auth'
    || callback.port
    || callback.username
    || callback.password
    || callback.pathname !== '/callback'
    || callback.hash) {
    throw new Error('Authentication callback target is invalid.')
  }
  const keys = [...new Set(callback.searchParams.keys())]
  if (keys.length !== 1 || keys[0] !== 'code') throw new Error('Authentication callback query is invalid.')
  const codes = callback.searchParams.getAll('code')
  if (codes.length !== 1 || !AUTH_CODE_PATTERN.test(codes[0])) {
    throw new Error('Authentication callback code is invalid.')
  }
  return callback.toString()
}

export function authCallbackFromArguments(argv: readonly string[]): string | null {
  const candidates = argv.filter((value) => value.toLowerCase().startsWith('agent-console:'))
  if (candidates.length === 0) return null
  if (candidates.length !== 1) throw new Error('Only one authentication callback may be handled at a time.')
  return validateAuthCallbackUrl(candidates[0])
}
