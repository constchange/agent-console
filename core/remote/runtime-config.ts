const RESERVED_GATEWAY_PORTS = new Set([4000, 5173, 32222, 34000, 35900])

const RUNTIME_KEYS = [
  'AGENT_CONSOLE_REMOTE_ARMED',
  'AGENT_CONSOLE_SUPABASE_URL',
  'AGENT_CONSOLE_SUPABASE_PUBLISHABLE_KEY',
  'AGENT_CONSOLE_PUBLIC_BASE_URL',
  'AGENT_CONSOLE_GATEWAY_LOCAL_HOST',
  'AGENT_CONSOLE_GATEWAY_LOCAL_PORT',
] as const

export interface RemoteRuntimeConfig {
  armed: boolean
  supabaseUrl: string
  publishableKey: string
  publicBaseUrl: string
  gatewayHost: '127.0.0.1'
  gatewayPort: number
}

export type RemoteRuntimeConfigResult =
  | { configured: false; message: string }
  | { configured: true; config: RemoteRuntimeConfig }

function value(environment: NodeJS.ProcessEnv, key: typeof RUNTIME_KEYS[number]): string {
  const result = environment[key]
  if (typeof result !== 'string' || !result || /[\0\r\n]/.test(result)) {
    throw new Error(`Remote configuration is missing or has an invalid ${key}.`)
  }
  return result
}

function httpsOrigin(input: string, label: string): string {
  let parsed: URL
  try {
    parsed = new URL(input)
  } catch {
    throw new Error(`${label} must be a valid HTTPS origin.`)
  }
  if (parsed.protocol !== 'https:'
    || !parsed.hostname
    || parsed.username
    || parsed.password
    || parsed.search
    || parsed.hash
    || (parsed.pathname !== '/' && parsed.pathname !== '')) {
    throw new Error(`${label} must be a valid HTTPS origin.`)
  }
  if (['localhost', '127.0.0.1', '::1'].includes(parsed.hostname)) {
    throw new Error(`${label} must not use a loopback host.`)
  }
  return parsed.origin
}

function jwtRole(candidate: string): string | null {
  const parts = candidate.split('.')
  if (parts.length !== 3) return null
  try {
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')) as { role?: unknown }
    return typeof payload.role === 'string' ? payload.role : null
  } catch {
    return null
  }
}

function publishableKey(candidate: string): string {
  const lowered = candidate.toLowerCase()
  if (candidate.length < 20
    || candidate.length > 4_096
    || /\s/.test(candidate)
    || lowered.includes('service_role')
    || lowered.startsWith('sb_secret_')
    || jwtRole(candidate) === 'service_role'
    || candidate.startsWith('sb_') && !candidate.startsWith('sb_publishable_')) {
    throw new Error('Remote configuration must use only a Supabase publishable/anon key.')
  }
  return candidate
}

/**
 * Parses only the public values needed by the long-lived Core and localhost
 * Gateway. VPS credentials and SSH paths are intentionally outside this
 * composition. A partial configuration is an error; an entirely absent one is
 * an honest, fail-closed unconfigured state.
 */
export function parseRemoteRuntimeConfig(environment: NodeJS.ProcessEnv = process.env): RemoteRuntimeConfigResult {
  const present = RUNTIME_KEYS.filter((key) => typeof environment[key] === 'string' && environment[key] !== '')
  if (present.length === 0) {
    return {
      configured: false,
      message: 'Install a private remote.env file and restart the Console Core before using Mobile Remote.',
    }
  }
  if (present.length !== RUNTIME_KEYS.length) {
    throw new Error('Remote configuration is incomplete; Mobile Remote remains disabled.')
  }

  const armedValue = value(environment, 'AGENT_CONSOLE_REMOTE_ARMED')
  if (armedValue !== '0' && armedValue !== '1') {
    throw new Error('AGENT_CONSOLE_REMOTE_ARMED must be exactly 0 or 1.')
  }
  const gatewayHost = value(environment, 'AGENT_CONSOLE_GATEWAY_LOCAL_HOST')
  if (gatewayHost !== '127.0.0.1') throw new Error('Remote Gateway host must be exactly 127.0.0.1.')
  const portText = value(environment, 'AGENT_CONSOLE_GATEWAY_LOCAL_PORT')
  if (!/^\d{4,5}$/.test(portText)) throw new Error('Remote Gateway port is invalid.')
  const gatewayPort = Number(portText)
  if (gatewayPort < 1_024 || gatewayPort > 65_535 || RESERVED_GATEWAY_PORTS.has(gatewayPort)) {
    throw new Error('Remote Gateway port must be an unused high port.')
  }

  return {
    configured: true,
    config: {
      armed: armedValue === '1',
      supabaseUrl: httpsOrigin(value(environment, 'AGENT_CONSOLE_SUPABASE_URL'), 'Supabase URL'),
      publishableKey: publishableKey(value(environment, 'AGENT_CONSOLE_SUPABASE_PUBLISHABLE_KEY')),
      publicBaseUrl: httpsOrigin(value(environment, 'AGENT_CONSOLE_PUBLIC_BASE_URL'), 'Public Remote URL'),
      gatewayHost,
      gatewayPort,
    },
  }
}

export function requireArmedRemoteRuntimeConfig(
  environment: NodeJS.ProcessEnv = process.env,
): RemoteRuntimeConfig {
  const result = parseRemoteRuntimeConfig(environment)
  if (!result.configured) throw new Error(result.message)
  if (!result.config.armed) {
    throw new Error('Mobile Remote is disarmed. Set AGENT_CONSOLE_REMOTE_ARMED=1 only after deployment checks pass.')
  }
  return result.config
}
