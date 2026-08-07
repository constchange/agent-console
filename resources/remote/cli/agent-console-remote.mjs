#!/usr/bin/env node

import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const CLI_FILE = fileURLToPath(import.meta.url)
const RESOURCE_ROOT = path.resolve(path.dirname(CLI_FILE), '..')
const MAX_CONFIG_BYTES = 64 * 1024
const MAX_KEY_BYTES = 1024 * 1024
const GATEWAY_UNIT = 'agent-console-gateway.service'
const TUNNEL_UNIT = 'agent-console-tunnel.service'
const CORE_UNIT = 'agent-console-core.service'
const REQUIRED_KEYS = [
  'AGENT_CONSOLE_REMOTE_ARMED',
  'AGENT_CONSOLE_SUPABASE_URL',
  'AGENT_CONSOLE_SUPABASE_PUBLISHABLE_KEY',
  'AGENT_CONSOLE_PUBLIC_BASE_URL',
  'AGENT_CONSOLE_GATEWAY_LOCAL_HOST',
  'AGENT_CONSOLE_GATEWAY_LOCAL_PORT',
  'AGENT_CONSOLE_GATEWAY_VPS_PORT',
  'AGENT_CONSOLE_VPS_HOST',
  'AGENT_CONSOLE_VPS_USER',
  'AGENT_CONSOLE_VPS_SSH_PORT',
  'AGENT_CONSOLE_VPS_HOST_ED25519_SHA256',
  'AGENT_CONSOLE_SSH_KEY_PATH',
  'AGENT_CONSOLE_SSH_PUBLIC_KEY_PATH',
  'AGENT_CONSOLE_SSH_KNOWN_HOSTS_PATH',
  'AGENT_CONSOLE_VPS_PROXY',
]
const RESERVED_GATEWAY_PORTS = new Set([4000, 5173, 32222, 34000, 35900])

function fail(message) {
  throw new Error(message)
}

function assert(condition, message) {
  if (!condition) fail(message)
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error)
}

function homePath(...parts) {
  return path.join(os.homedir(), ...parts)
}

function configHome() {
  const value = process.env.XDG_CONFIG_HOME
  return value && path.isAbsolute(value) ? value : homePath('.config')
}

function dataHome() {
  const value = process.env.XDG_DATA_HOME
  return value && path.isAbsolute(value) ? value : homePath('.local', 'share')
}

function defaultPaths() {
  const remoteConfigDirectory = path.join(configHome(), 'agent-console', 'remote')
  const remoteDataDirectory = path.join(dataHome(), 'agent-console', 'remote')
  return {
    environmentFile: path.join(remoteConfigDirectory, 'remote.env'),
    dataDirectory: remoteDataDirectory,
    systemdDirectory: path.join(configHome(), 'systemd', 'user'),
  }
}

function parseArguments(argv) {
  const command = argv[0] || 'help'
  const options = new Map()
  const positionals = []
  for (let index = 1; index < argv.length; index += 1) {
    const argument = argv[index]
    if (!argument.startsWith('--')) {
      positionals.push(argument)
      continue
    }
    const separator = argument.indexOf('=')
    const name = separator >= 0 ? argument.slice(2, separator) : argument.slice(2)
    assert(/^[a-z][a-z0-9-]*$/.test(name), `Invalid option: ${argument}`)
    assert(!options.has(name), `Option --${name} may only be supplied once.`)
    let value = separator >= 0 ? argument.slice(separator + 1) : true
    if (separator < 0 && argv[index + 1] && !argv[index + 1].startsWith('--')) {
      value = argv[index + 1]
      index += 1
    }
    options.set(name, value)
  }
  return { command, options, positionals }
}

function optionString(options, name, fallback = null) {
  const value = options.get(name)
  if (value === undefined) return fallback
  assert(value !== true && value.length > 0, `--${name} requires a value.`)
  return value
}

function optionBoolean(options, name) {
  const value = options.get(name)
  if (value === undefined) return false
  assert(value === true, `--${name} does not accept a value.`)
  return true
}

function assertOptions(options, allowed) {
  for (const name of options.keys()) assert(allowed.includes(name), `Unknown option --${name}.`)
}

function decodeQuotedValue(raw, lineNumber) {
  if (!raw.startsWith('"') && !raw.startsWith("'")) return raw.trim()
  const quote = raw[0]
  assert(raw.endsWith(quote), `remote.env line ${lineNumber} has an unterminated quoted value.`)
  const body = raw.slice(1, -1)
  if (quote === "'") {
    assert(!body.includes("'"), `remote.env line ${lineNumber} contains an unsupported quote.`)
    return body
  }
  assert(!/\\(?![\\"nrt])/u.test(body), `remote.env line ${lineNumber} contains an unsupported escape.`)
  return body.replace(/\\n/g, '\n').replace(/\\r/g, '\r').replace(/\\t/g, '\t').replace(/\\"/g, '"').replace(/\\\\/g, '\\')
}

async function readEnvironmentFile(filePath) {
  const contents = await readPrivateFile(filePath, 'Remote environment file', MAX_CONFIG_BYTES, { exactMode: 0o600 })
  const values = Object.create(null)
  for (const [index, original] of contents.split(/\r?\n/u).entries()) {
    const line = original.trim()
    if (!line || line.startsWith('#')) continue
    const match = line.match(/^([A-Z][A-Z0-9_]*)=(.*)$/u)
    assert(match, `remote.env line ${index + 1} must use NAME=value syntax.`)
    const [, name, raw] = match
    assert(REQUIRED_KEYS.includes(name), `remote.env line ${index + 1} uses unsupported key ${name}.`)
    assert(values[name] === undefined, `remote.env defines ${name} more than once.`)
    const value = decodeQuotedValue(raw, index + 1)
    assert(!/[\0\r\n]/u.test(value), `remote.env ${name} must be one line.`)
    values[name] = value
  }
  for (const name of REQUIRED_KEYS) assert(values[name] !== undefined && values[name] !== '', `remote.env is missing ${name}.`)
  return validateConfiguration(values)
}

async function assertOwnedRegularFile(filePath, label, { privateMode = false, exactMode = null, maxBytes = MAX_KEY_BYTES } = {}) {
  assert(path.isAbsolute(filePath), `${label} path must be absolute.`)
  const stat = await fs.lstat(filePath)
  assert(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1, `${label} must be one regular file, not a link.`)
  if (typeof process.getuid === 'function') assert(stat.uid === process.getuid(), `${label} must be owned by the current user.`)
  if (exactMode !== null) assert((stat.mode & 0o777) === exactMode, `${label} must use exact mode ${exactMode.toString(8).padStart(4, '0')}.`)
  else if (privateMode) assert((stat.mode & 0o077) === 0, `${label} must use mode 0600 or stricter.`)
  else assert((stat.mode & 0o022) === 0, `${label} must not be group- or world-writable.`)
  assert(stat.size > 0 && stat.size <= maxBytes, `${label} has an invalid size.`)
  return stat
}

async function readPrivateFile(filePath, label, maxBytes, options = {}) {
  await assertOwnedRegularFile(filePath, label, { privateMode: true, maxBytes, ...options })
  return fs.readFile(filePath, 'utf8')
}

function validateAbsolutePath(value, label) {
  assert(path.isAbsolute(value), `${label} must be an absolute path.`)
  assert(path.normalize(value) === value, `${label} must be normalized.`)
  assert(!/[\0\r\n]/u.test(value), `${label} must be one path.`)
  return value
}

function validatePort(value, label, { gateway = false, minimum = 1024 } = {}) {
  assert(/^[0-9]{1,5}$/u.test(value), `${label} must be a decimal port.`)
  const port = Number(value)
  assert(Number.isSafeInteger(port) && port >= minimum && port <= 65535, `${label} must be between ${minimum} and 65535.`)
  if (gateway) assert(!RESERVED_GATEWAY_PORTS.has(port), `${label} collides with an Agent Console reserved port.`)
  return port
}

function validateUrl(value, label, { originOnly = false } = {}) {
  let parsed
  try {
    parsed = new URL(value)
  } catch {
    fail(`${label} must be a valid HTTPS URL.`)
  }
  assert(parsed.protocol === 'https:', `${label} must use HTTPS.`)
  assert(!parsed.username && !parsed.password, `${label} must not include credentials.`)
  assert(parsed.hostname && parsed.hostname !== 'localhost' && parsed.hostname !== '127.0.0.1' && parsed.hostname !== '::1', `${label} must use a non-loopback host.`)
  if (originOnly) assert((parsed.pathname === '/' || parsed.pathname === '') && !parsed.search && !parsed.hash, `${label} must be an origin without a path, query, or fragment.`)
  return parsed
}

function validateHost(value, label) {
  assert(value.length <= 253 && /^[a-zA-Z0-9.-]+$/u.test(value), `${label} must be a DNS name or IP address.`)
  assert(value !== 'localhost' && value !== '127.0.0.1' && value !== '::1', `${label} must not be loopback.`)
  assert(!/(^|\.)example\.(com|net|org)$/iu.test(value), `${label} still contains the example host.`)
  assert(!value.includes('..') && !value.startsWith('.') && !value.endsWith('.'), `${label} is malformed.`)
  return value
}

function decodeJwtRole(value) {
  if (!value.startsWith('eyJ')) return null
  try {
    const payload = JSON.parse(Buffer.from(value.split('.')[1] || '', 'base64url').toString('utf8'))
    return typeof payload.role === 'string' ? payload.role : null
  } catch {
    return null
  }
}

function validatePublishableKey(value) {
  const lowered = value.toLowerCase()
  assert(!lowered.includes('service_role') && !lowered.startsWith('sb_secret_'), 'Supabase secret/service_role keys are forbidden on the workstation.')
  assert(!/replace|your[_-]?key|changeme/iu.test(value), 'Supabase publishable key still contains a placeholder.')
  assert(value.length >= 20 && value.length <= 4096 && !/\s/u.test(value), 'Supabase publishable key has an invalid format.')
  const role = decodeJwtRole(value)
  assert(role !== 'service_role', 'Supabase service_role JWTs are forbidden on the workstation.')
  if (value.startsWith('sb_')) assert(value.startsWith('sb_publishable_'), 'Only a Supabase publishable key may use the sb_ prefix.')
  return value
}

function validateFingerprint(value) {
  assert(/^SHA256:[A-Za-z0-9+/]{43}$/u.test(value), 'VPS ED25519 fingerprint must use the SHA256:base64 format.')
  return value
}

function validateConfiguration(values) {
  assert(values.AGENT_CONSOLE_REMOTE_ARMED === '0' || values.AGENT_CONSOLE_REMOTE_ARMED === '1', 'AGENT_CONSOLE_REMOTE_ARMED must be 0 or 1.')
  const supabaseUrl = validateUrl(values.AGENT_CONSOLE_SUPABASE_URL, 'Supabase URL', { originOnly: true })
  assert(!/YOUR_PROJECT/iu.test(supabaseUrl.hostname), 'Supabase URL still contains a placeholder.')
  validatePublishableKey(values.AGENT_CONSOLE_SUPABASE_PUBLISHABLE_KEY)
  const publicBaseUrl = validateUrl(values.AGENT_CONSOLE_PUBLIC_BASE_URL, 'Public base URL', { originOnly: true })
  assert(!/(^|\.)example\.(com|net|org)$/iu.test(publicBaseUrl.hostname), 'Public base URL still contains the example domain.')
  assert(values.AGENT_CONSOLE_GATEWAY_LOCAL_HOST === '127.0.0.1', 'Gateway local host must be exactly 127.0.0.1.')
  const localPort = validatePort(values.AGENT_CONSOLE_GATEWAY_LOCAL_PORT, 'Gateway local port', { gateway: true })
  const vpsPort = validatePort(values.AGENT_CONSOLE_GATEWAY_VPS_PORT, 'Gateway VPS port', { gateway: true })
  assert(localPort !== vpsPort, 'Gateway local and VPS ports must be different.')
  const sshPort = validatePort(values.AGENT_CONSOLE_VPS_SSH_PORT, 'VPS SSH port', { minimum: 1 })
  const vpsHost = validateHost(values.AGENT_CONSOLE_VPS_HOST, 'VPS host')
  const vpsUser = values.AGENT_CONSOLE_VPS_USER
  assert(/^[a-z_][a-z0-9_-]{0,31}$/u.test(vpsUser) && vpsUser !== 'root', 'VPS user must be a dedicated non-root Unix account name.')
  const fingerprint = validateFingerprint(values.AGENT_CONSOLE_VPS_HOST_ED25519_SHA256)
  const sshKeyPath = validateAbsolutePath(values.AGENT_CONSOLE_SSH_KEY_PATH, 'SSH private key')
  const sshPublicKeyPath = validateAbsolutePath(values.AGENT_CONSOLE_SSH_PUBLIC_KEY_PATH, 'SSH public key')
  const knownHostsPath = validateAbsolutePath(values.AGENT_CONSOLE_SSH_KNOWN_HOSTS_PATH, 'SSH known_hosts')
  assert(new Set([sshKeyPath, sshPublicKeyPath, knownHostsPath]).size === 3, 'SSH key and known_hosts paths must be different files.')
  const proxy = values.AGENT_CONSOLE_VPS_PROXY
  assert(proxy === 'caddy' || proxy === 'nginx', 'VPS proxy must be caddy or nginx.')
  return {
    ...values,
    armed: values.AGENT_CONSOLE_REMOTE_ARMED === '1',
    supabaseUrl,
    publicBaseUrl,
    localPort,
    vpsPort,
    sshPort,
    vpsHost,
    vpsUser,
    fingerprint,
    sshKeyPath,
    sshPublicKeyPath,
    knownHostsPath,
    proxy,
  }
}

function systemdEscape(value) {
  return value
    .replace(/%/g, '%%')
    .replace(/\\/g, '\\x5c')
    .replace(/ /g, '\\x20')
    .replace(/\t/g, '\\x09')
    .replace(/"/g, '\\x22')
}

function replaceTemplate(contents, replacements) {
  let rendered = contents
  for (const [key, value] of Object.entries(replacements)) rendered = rendered.replaceAll(`@@${key}@@`, value)
  const unresolved = rendered.match(/@@[A-Z0-9_]+@@/u)
  assert(!unresolved, `Template still contains unresolved placeholder ${unresolved?.[0]}.`)
  return rendered
}

async function readResource(relativePath) {
  const target = path.join(RESOURCE_ROOT, ...relativePath.split('/'))
  return fs.readFile(target, 'utf8')
}

async function syncDirectory(directory) {
  const handle = await fs.open(directory, 'r')
  try {
    await handle.sync()
  } catch (error) {
    const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : ''
    if (!['EINVAL', 'ENOTSUP', 'EISDIR'].includes(code)) throw error
  } finally {
    await handle.close()
  }
}

async function atomicWrite(filePath, contents, mode) {
  await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 })
  const existing = await fs.lstat(filePath).catch((error) => {
    if (error && typeof error === 'object' && error.code === 'ENOENT') return null
    throw error
  })
  if (existing) {
    assert(existing.isFile() && !existing.isSymbolicLink() && existing.nlink === 1, `Refusing to replace non-regular file ${filePath}.`)
    if (typeof process.getuid === 'function') assert(existing.uid === process.getuid(), `Refusing to replace file not owned by the current user: ${filePath}.`)
  }
  const temporary = `${filePath}.${process.pid}-${Date.now()}.tmp`
  try {
    await fs.writeFile(temporary, contents, { mode, flag: 'wx' })
    const handle = await fs.open(temporary, 'r')
    try {
      await handle.sync()
    } finally {
      await handle.close()
    }
    await fs.rename(temporary, filePath)
    await fs.chmod(filePath, mode)
    await syncDirectory(path.dirname(filePath))
  } finally {
    await fs.rm(temporary, { force: true })
  }
}

function shellQuote(value) {
  assert(!/[\0\r\n]/u.test(value), 'Launcher values must be one line.')
  return `'${value.replace(/'/g, `'"'"'`)}'`
}

function inferAppExecutable(options) {
  const explicit = optionString(options, 'app-executable')
  const candidate = explicit || process.env.APPIMAGE || process.env.AGENT_CONSOLE_APP_EXECUTABLE || (process.versions.electron ? process.execPath : '/usr/bin/agent-console')
  return validateAbsolutePath(path.resolve(candidate), 'Agent Console executable')
}

async function copyRuntimeResources(dataDirectory, appExecutable) {
  const installedCli = path.join(dataDirectory, 'cli', 'agent-console-remote.mjs')
  const installedLauncher = path.join(dataDirectory, 'bin', 'agent-console-remote-service')
  const resources = [
    ['remote.env.example', 'remote.env.example', 0o600],
    ['systemd/agent-console-gateway.service.tmpl', 'systemd/agent-console-gateway.service.tmpl', 0o600],
    ['systemd/agent-console-tunnel.service.tmpl', 'systemd/agent-console-tunnel.service.tmpl', 0o600],
    ['vps/caddy/agent-console.caddy.tmpl', 'vps/caddy/agent-console.caddy.tmpl', 0o600],
    ['vps/nginx/agent-console.conf.tmpl', 'vps/nginx/agent-console.conf.tmpl', 0o600],
    ['vps/install.sh', 'vps/install.sh', 0o700],
    ['vps/uninstall.sh', 'vps/uninstall.sh', 0o700],
  ]
  await atomicWrite(installedCli, await fs.readFile(CLI_FILE), 0o700)
  for (const [source, destination, mode] of resources) {
    await atomicWrite(path.join(dataDirectory, destination), await readResource(source), mode)
  }
  const launcher = `#!/bin/sh\nset -eu\nexec env ELECTRON_RUN_AS_NODE=1 ${shellQuote(appExecutable)} ${shellQuote(installedCli)} "$@"\n`
  await atomicWrite(installedLauncher, launcher, 0o700)
  return { installedCli, installedLauncher }
}

function unitReplacements({ envFile, appExecutable, launcher, gatewaySocket, desktopCoreSocket, config, applicationReadOnlyPath, dataDirectory }) {
  const readOnlyLine = applicationReadOnlyPath ? `BindReadOnlyPaths=${systemdEscape(applicationReadOnlyPath)}` : ''
  return {
    REMOTE_ENV_FILE: systemdEscape(envFile),
    APP_EXECUTABLE: systemdEscape(appExecutable),
    REMOTE_LAUNCHER: systemdEscape(launcher),
    GATEWAY_SOCKET: systemdEscape(gatewaySocket),
    DESKTOP_CORE_SOCKET: systemdEscape(desktopCoreSocket),
    SSH_KEY_PATH: systemdEscape(config.sshKeyPath),
    SSH_PUBLIC_KEY_PATH: systemdEscape(config.sshPublicKeyPath),
    KNOWN_HOSTS_PATH: systemdEscape(config.knownHostsPath),
    REMOTE_RUNTIME_PATH: systemdEscape(dataDirectory),
    APPLICATION_READ_ONLY_LINE: readOnlyLine,
  }
}

async function runFile(command, args, { timeout = 20_000, allowFailure = false, env = process.env } = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', timeout, maxBuffer: 4 * 1024 * 1024, env })
  if (result.error) throw result.error
  if (!allowFailure && result.status !== 0) {
    const detail = (result.stderr || result.stdout || '').trim()
    fail(`${path.basename(command)} failed${detail ? `: ${detail}` : '.'}`)
  }
  return result
}

async function renderUnits(options, config, envFile, appExecutable, launcher, dataDirectory) {
  const runtimeDirectory = process.env.XDG_RUNTIME_DIR && path.isAbsolute(process.env.XDG_RUNTIME_DIR)
    ? process.env.XDG_RUNTIME_DIR
    : `/run/user/${typeof process.getuid === 'function' ? process.getuid() : 'USER'}`
  const gatewaySocket = validateAbsolutePath(optionString(options, 'gateway-socket', path.join(runtimeDirectory, 'agent-console', 'gateway', 'core.sock')), 'Gateway Core socket')
  const desktopCoreSocket = validateAbsolutePath(optionString(options, 'desktop-core-socket', path.join(runtimeDirectory, 'agent-console', 'desktop', 'core.sock')), 'Desktop Core socket')
  assert(gatewaySocket !== desktopCoreSocket, 'Gateway and desktop Core sockets must be different.')
  const applicationReadOnlyPath = optionString(options, 'application-read-only-path', appExecutable.startsWith(`${os.homedir()}${path.sep}`) ? appExecutable : null)
  if (applicationReadOnlyPath) validateAbsolutePath(applicationReadOnlyPath, 'Application read-only path')
  const replacements = unitReplacements({ envFile, appExecutable, launcher, gatewaySocket, desktopCoreSocket, config, applicationReadOnlyPath, dataDirectory })
  const [gatewayTemplate, tunnelTemplate] = await Promise.all([
    fs.readFile(path.join(dataDirectory, 'systemd', 'agent-console-gateway.service.tmpl'), 'utf8'),
    fs.readFile(path.join(dataDirectory, 'systemd', 'agent-console-tunnel.service.tmpl'), 'utf8'),
  ])
  return {
    gateway: replaceTemplate(gatewayTemplate, replacements),
    tunnel: replaceTemplate(tunnelTemplate, replacements),
  }
}

async function commandValidate(options, positionals) {
  assertOptions(options, ['env-file', 'json'])
  assert(positionals.length === 0, 'validate does not accept positional arguments.')
  const envFile = validateAbsolutePath(path.resolve(optionString(options, 'env-file', defaultPaths().environmentFile)), 'Remote environment file')
  const config = await readEnvironmentFile(envFile)
  const result = {
    ok: true,
    armed: config.armed,
    publicOrigin: config.publicBaseUrl.origin,
    localGateway: `127.0.0.1:${config.localPort}`,
    vpsLoopbackPort: config.vpsPort,
    proxy: config.proxy,
  }
  if (optionBoolean(options, 'json')) process.stdout.write(`${JSON.stringify(result)}\n`)
  else process.stdout.write(`Configuration is valid (${result.publicOrigin}; proxy ${result.proxy}; armed ${result.armed ? 'yes' : 'no'}).\n`)
}

async function commandInstall(options, positionals) {
  assertOptions(options, ['env-file', 'target-env-file', 'data-directory', 'systemd-directory', 'app-executable', 'gateway-socket', 'desktop-core-socket', 'application-read-only-path', 'enable', 'offline'])
  assert(positionals.length === 0, 'install does not accept positional arguments.')
  const defaults = defaultPaths()
  const sourceEnvironment = validateAbsolutePath(path.resolve(optionString(options, 'env-file', defaults.environmentFile)), 'Source remote environment file')
  const targetEnvironment = validateAbsolutePath(path.resolve(optionString(options, 'target-env-file', defaults.environmentFile)), 'Installed remote environment file')
  const dataDirectory = validateAbsolutePath(path.resolve(optionString(options, 'data-directory', defaults.dataDirectory)), 'Remote data directory')
  const systemdDirectory = validateAbsolutePath(path.resolve(optionString(options, 'systemd-directory', defaults.systemdDirectory)), 'systemd user directory')
  const config = await readEnvironmentFile(sourceEnvironment)
  const offline = optionBoolean(options, 'offline')
  const enable = optionBoolean(options, 'enable')
  assert(!(offline && enable), '--offline cannot be combined with --enable.')
  await Promise.all([
    assertOwnedRegularFile(config.sshKeyPath, 'Dedicated SSH private key', { privateMode: true }),
    assertOwnedRegularFile(config.sshPublicKeyPath, 'Dedicated SSH public key'),
    assertOwnedRegularFile(config.knownHostsPath, 'Dedicated SSH known_hosts file', { privateMode: true }),
  ])
  const appExecutable = inferAppExecutable(options)
  await fs.access(appExecutable, 0o1)
  const sourceContents = await fs.readFile(sourceEnvironment)
  if (sourceEnvironment !== targetEnvironment) await atomicWrite(targetEnvironment, sourceContents, 0o600)
  else await fs.chmod(targetEnvironment, 0o600)
  const runtime = await copyRuntimeResources(dataDirectory, appExecutable)
  const installedConfig = await readEnvironmentFile(targetEnvironment)
  const units = await renderUnits(options, installedConfig, targetEnvironment, appExecutable, runtime.installedLauncher, dataDirectory)
  const gatewayUnitPath = path.join(systemdDirectory, GATEWAY_UNIT)
  const tunnelUnitPath = path.join(systemdDirectory, TUNNEL_UNIT)
  await atomicWrite(gatewayUnitPath, units.gateway, 0o600)
  await atomicWrite(tunnelUnitPath, units.tunnel, 0o600)
  await runFile('systemd-analyze', ['verify', gatewayUnitPath, tunnelUnitPath])
  if (!offline) {
    await runFile('systemctl', ['--user', 'daemon-reload'])
    const coreState = await runFile('systemctl', ['--user', 'is-active', CORE_UNIT], { allowFailure: true })
    if (['active', 'activating', 'reloading'].includes(coreState.stdout.trim())) {
      // remote.env is consumed by the long-lived Core as well as the two new
      // services. Restart it before opening the Gateway so an ARMED 0 -> 1
      // transition cannot leave the Core enforcing stale configuration.
      await runFile('systemctl', ['--user', 'restart', CORE_UNIT])
    }
  }
  if (enable) {
    assert(installedConfig.armed, 'Refusing to enable Remote services while AGENT_CONSOLE_REMOTE_ARMED is 0.')
    try {
      await runFile('systemctl', ['--user', 'enable', '--now', GATEWAY_UNIT, TUNNEL_UNIT])
    } catch (error) {
      await runFile('systemctl', ['--user', 'disable', '--now', GATEWAY_UNIT, TUNNEL_UNIT], { allowFailure: true })
      throw error
    }
  }
  process.stdout.write(`Installed Remote configuration and verified ${GATEWAY_UNIT} / ${TUNNEL_UNIT}.${installedConfig.armed ? '' : ' Services remain disabled until configuration is armed and install --enable is run.'}\n`)
}

function validatePublicKey(contents) {
  const line = contents.trim()
  const match = line.match(/^ssh-ed25519 ([A-Za-z0-9+/]+={0,2})(?: [^\r\n]+)?$/u)
  assert(match, 'Dedicated SSH public key must be one ssh-ed25519 public key.')
  const decoded = Buffer.from(match[1], 'base64')
  assert(decoded.length >= 32 && decoded.length <= 1024, 'Dedicated SSH public key payload is invalid.')
  return { line, algorithm: 'ssh-ed25519', encoded: match[1] }
}

function authorizedKeyLine(config, publicKey) {
  const destination = `127.0.0.1:${config.vpsPort}`
  return `restrict,port-forwarding,permitlisten="${destination}",permitopen="127.0.0.1:1" ${publicKey.algorithm} ${publicKey.encoded} agent-console-remote\n`
}

async function commandRender(options, positionals) {
  assertOptions(options, ['env-file', 'output'])
  assert(positionals.length === 0, 'render does not accept positional arguments.')
  const envFile = validateAbsolutePath(path.resolve(optionString(options, 'env-file', defaultPaths().environmentFile)), 'Remote environment file')
  const outputDirectory = optionString(options, 'output')
  assert(outputDirectory, 'render requires --output with an absolute directory.')
  const output = validateAbsolutePath(path.resolve(outputDirectory), 'Rendered VPS output directory')
  assert(output !== path.parse(output).root && output !== os.homedir(), 'Refusing to render into a broad directory.')
  const config = await readEnvironmentFile(envFile)
  await assertOwnedRegularFile(config.sshPublicKeyPath, 'Dedicated SSH public key')
  const publicKey = validatePublicKey(await fs.readFile(config.sshPublicKeyPath, 'utf8'))
  const domain = config.publicBaseUrl.hostname
  const [caddyTemplate, nginxTemplate, installScript, uninstallScript] = await Promise.all([
    readResource('vps/caddy/agent-console.caddy.tmpl'),
    readResource('vps/nginx/agent-console.conf.tmpl'),
    readResource('vps/install.sh'),
    readResource('vps/uninstall.sh'),
  ])
  const replacements = { REMOTE_DOMAIN: domain, VPS_GATEWAY_PORT: String(config.vpsPort) }
  await Promise.all([
    atomicWrite(path.join(output, 'agent-console.caddy'), replaceTemplate(caddyTemplate, replacements), 0o600),
    atomicWrite(path.join(output, 'agent-console.nginx.conf'), replaceTemplate(nginxTemplate, replacements), 0o600),
    atomicWrite(path.join(output, 'authorized_key'), authorizedKeyLine(config, publicKey), 0o600),
    atomicWrite(path.join(output, 'install.sh'), installScript, 0o700),
    atomicWrite(path.join(output, 'uninstall.sh'), uninstallScript, 0o700),
    atomicWrite(path.join(output, 'deployment.env'), `REMOTE_DOMAIN=${domain}\nVPS_GATEWAY_PORT=${config.vpsPort}\nVPS_TUNNEL_USER=${config.vpsUser}\nVPS_PROXY=${config.proxy}\n`, 0o600),
  ])
  process.stdout.write(`Rendered a secret-free VPS bundle in ${output}. Review it locally, then transfer it through your approved administrative channel.\n`)
}

function fingerprintFromEncodedKey(encoded) {
  return `SHA256:${createHash('sha256').update(Buffer.from(encoded, 'base64')).digest('base64').replace(/=+$/u, '')}`
}

async function inspectKnownHosts(config) {
  const contents = await readPrivateFile(config.knownHostsPath, 'Dedicated SSH known_hosts file', MAX_KEY_BYTES)
  const expectedHost = config.sshPort === 22 ? config.vpsHost : `[${config.vpsHost}]:${config.sshPort}`
  for (const line of contents.split(/\r?\n/u)) {
    if (!line || line.startsWith('#')) continue
    const fields = line.trim().split(/\s+/u)
    if (fields.length < 3 || fields[1] !== 'ssh-ed25519') continue
    if (!fields[0].split(',').includes(expectedHost)) continue
    if (fingerprintFromEncodedKey(fields[2]) === config.fingerprint) return true
  }
  return false
}

async function inspectKeyPair(config) {
  await Promise.all([
    assertOwnedRegularFile(config.sshKeyPath, 'Dedicated SSH private key', { privateMode: true }),
    assertOwnedRegularFile(config.sshPublicKeyPath, 'Dedicated SSH public key'),
  ])
  const publicKey = validatePublicKey(await fs.readFile(config.sshPublicKeyPath, 'utf8'))
  const derived = await runFile('ssh-keygen', ['-y', '-P', '', '-f', config.sshKeyPath], { allowFailure: true, timeout: 10_000 })
  assert(derived.status === 0, 'Dedicated SSH key must be readable without a passphrase for unattended autossh.')
  const derivedKey = validatePublicKey(derived.stdout)
  assert(derivedKey.encoded === publicKey.encoded, 'Dedicated SSH public and private keys do not match.')
}

function addCheck(checks, name, status, detail) {
  checks.push({ name, status, detail })
}

async function serviceState(name) {
  const result = await runFile('systemctl', ['--user', 'show', name, '--property=LoadState,ActiveState', '--value'], { allowFailure: true })
  if (result.status !== 0) return 'not-installed'
  const values = result.stdout.trim().split(/\r?\n/u)
  return values.includes('active') ? 'active' : values.includes('loaded') ? 'inactive' : 'not-installed'
}

async function localListenerState(port) {
  const result = await runFile('ss', ['-H', '-ltn'], { allowFailure: true })
  if (result.status !== 0) return { status: 'unavailable', detail: 'ss is unavailable' }
  const endpoints = result.stdout.split(/\r?\n/u).map((line) => line.trim().split(/\s+/u)[3]).filter(Boolean)
  const matches = endpoints.filter((endpoint) => endpoint.endsWith(`:${port}`))
  if (matches.length === 0) return { status: 'missing', detail: `nothing listens on 127.0.0.1:${port}` }
  if (matches.every((endpoint) => endpoint === `127.0.0.1:${port}`)) return { status: 'loopback', detail: `listening only on 127.0.0.1:${port}` }
  return { status: 'exposed', detail: `port ${port} is not restricted to IPv4 loopback` }
}

async function commandDoctor(options, positionals) {
  assertOptions(options, ['env-file', 'json', 'network'])
  assert(positionals.length === 0, 'doctor does not accept positional arguments.')
  const envFile = validateAbsolutePath(path.resolve(optionString(options, 'env-file', defaultPaths().environmentFile)), 'Remote environment file')
  const json = optionBoolean(options, 'json')
  const network = optionBoolean(options, 'network')
  const checks = []
  let config
  try {
    config = await readEnvironmentFile(envFile)
    addCheck(checks, 'configuration', 'pass', 'remote.env is private and valid')
  } catch (error) {
    addCheck(checks, 'configuration', 'fail', errorMessage(error))
  }
  if (config) {
    try {
      await inspectKeyPair(config)
      addCheck(checks, 'ssh-key', 'pass', 'dedicated ED25519 key pair matches and is unattended')
    } catch (error) {
      addCheck(checks, 'ssh-key', 'fail', errorMessage(error))
    }
    try {
      assert(await inspectKnownHosts(config), 'known_hosts has no exact ED25519 host key matching the configured fingerprint.')
      addCheck(checks, 'known-hosts', 'pass', 'exact host, port, algorithm, and fingerprint match')
    } catch (error) {
      addCheck(checks, 'known-hosts', 'fail', errorMessage(error))
    }
    const listener = await localListenerState(config.localPort)
    const listenerStatus = listener.status === 'loopback' ? 'pass' : config.armed || listener.status === 'exposed' ? 'fail' : 'warn'
    addCheck(checks, 'gateway-listener', listenerStatus, listener.detail)
    for (const service of [GATEWAY_UNIT, TUNNEL_UNIT]) {
      const state = await serviceState(service)
      addCheck(checks, service, state === 'active' ? 'pass' : config.armed ? 'fail' : 'warn', state)
    }
    if (network) {
      try {
        const response = await fetch(new URL('/healthz', config.publicBaseUrl), { signal: AbortSignal.timeout(10_000), redirect: 'error' })
        assert(response.ok, `HTTPS health check returned ${response.status}.`)
        addCheck(checks, 'public-health', 'pass', 'HTTPS /healthz responded successfully')
      } catch (error) {
        addCheck(checks, 'public-health', 'fail', errorMessage(error))
      }
    } else {
      addCheck(checks, 'public-health', 'skip', 'network checks require explicit --network')
    }
  }
  const ok = !checks.some((check) => check.status === 'fail')
  if (json) process.stdout.write(`${JSON.stringify({ ok, checks })}\n`)
  else for (const check of checks) process.stdout.write(`${check.status.toUpperCase().padEnd(5)} ${check.name}: ${check.detail}\n`)
  if (!ok) process.exitCode = 1
}

async function commandTunnelRun(options, positionals) {
  assertOptions(options, ['env-file'])
  assert(positionals.length === 0, 'tunnel-run does not accept positional arguments.')
  const envFile = validateAbsolutePath(path.resolve(optionString(options, 'env-file', defaultPaths().environmentFile)), 'Remote environment file')
  const config = await readEnvironmentFile(envFile)
  assert(config.armed, 'Remote tunnel is disarmed in remote.env.')
  await inspectKeyPair(config)
  assert(await inspectKnownHosts(config), 'known_hosts does not match the configured ED25519 fingerprint.')
  const remoteForward = `127.0.0.1:${config.vpsPort}:127.0.0.1:${config.localPort}`
  const args = [
    '-M', '0', '-N', '-T',
    '-o', 'BatchMode=yes',
    '-o', 'PasswordAuthentication=no',
    '-o', 'KbdInteractiveAuthentication=no',
    '-o', 'PreferredAuthentications=publickey',
    '-o', 'StrictHostKeyChecking=yes',
    '-o', `UserKnownHostsFile=${config.knownHostsPath}`,
    '-o', 'GlobalKnownHostsFile=/dev/null',
    '-o', 'HostKeyAlgorithms=ssh-ed25519',
    '-o', 'UpdateHostKeys=no',
    '-o', 'IdentitiesOnly=yes',
    '-o', 'ExitOnForwardFailure=yes',
    '-o', 'ServerAliveInterval=30',
    '-o', 'ServerAliveCountMax=3',
    '-i', config.sshKeyPath,
    '-p', String(config.sshPort),
    '-R', remoteForward,
    `${config.vpsUser}@${config.vpsHost}`,
  ]
  const child = spawn('/usr/bin/autossh', args, {
    stdio: 'inherit',
    env: { PATH: '/usr/bin:/bin', AUTOSSH_GATETIME: '0', AUTOSSH_PORT: '0' },
  })
  child.once('error', (error) => {
    process.stderr.write(`Could not start autossh: ${errorMessage(error)}\n`)
    process.exitCode = 1
  })
  const signal = (name) => {
    if (!child.killed) child.kill(name)
  }
  process.once('SIGTERM', () => signal('SIGTERM'))
  process.once('SIGINT', () => signal('SIGINT'))
  await new Promise((resolve) => child.once('exit', (code, signalName) => {
    if (code !== 0) process.exitCode = typeof code === 'number' ? code : signalName ? 1 : 0
    resolve()
  }))
}

async function removeExactFile(target) {
  const stat = await fs.lstat(target).catch((error) => {
    if (error && typeof error === 'object' && error.code === 'ENOENT') return null
    throw error
  })
  if (!stat) return false
  assert(stat.isFile() && !stat.isSymbolicLink(), `Refusing to remove non-regular path ${target}.`)
  if (typeof process.getuid === 'function') assert(stat.uid === process.getuid(), `Refusing to remove path not owned by the current user: ${target}.`)
  await fs.unlink(target)
  return true
}

async function commandUninstall(options, positionals) {
  assertOptions(options, ['data-directory', 'systemd-directory', 'offline'])
  assert(positionals.length === 0, 'uninstall does not accept positional arguments.')
  const defaults = defaultPaths()
  const dataDirectory = validateAbsolutePath(path.resolve(optionString(options, 'data-directory', defaults.dataDirectory)), 'Remote data directory')
  const systemdDirectory = validateAbsolutePath(path.resolve(optionString(options, 'systemd-directory', defaults.systemdDirectory)), 'systemd user directory')
  const offline = optionBoolean(options, 'offline')
  if (!offline) await runFile('systemctl', ['--user', 'disable', '--now', TUNNEL_UNIT, GATEWAY_UNIT], { allowFailure: true })
  const files = [
    path.join(systemdDirectory, GATEWAY_UNIT),
    path.join(systemdDirectory, TUNNEL_UNIT),
    path.join(dataDirectory, 'bin', 'agent-console-remote-service'),
    path.join(dataDirectory, 'cli', 'agent-console-remote.mjs'),
    path.join(dataDirectory, 'remote.env.example'),
    path.join(dataDirectory, 'systemd', 'agent-console-gateway.service.tmpl'),
    path.join(dataDirectory, 'systemd', 'agent-console-tunnel.service.tmpl'),
    path.join(dataDirectory, 'vps', 'caddy', 'agent-console.caddy.tmpl'),
    path.join(dataDirectory, 'vps', 'nginx', 'agent-console.conf.tmpl'),
    path.join(dataDirectory, 'vps', 'install.sh'),
    path.join(dataDirectory, 'vps', 'uninstall.sh'),
  ]
  let removed = 0
  for (const target of files) if (await removeExactFile(target)) removed += 1
  if (!offline) {
    await runFile('systemctl', ['--user', 'daemon-reload'], { allowFailure: true })
    await runFile('systemctl', ['--user', 'reset-failed', GATEWAY_UNIT, TUNNEL_UNIT], { allowFailure: true })
  }
  process.stdout.write(`Removed ${removed} generated service/runtime files. remote.env and SSH keys were preserved.\n`)
}

function printHelp() {
  process.stdout.write(`Agent Console Remote deployment helper\n\n`)
  process.stdout.write(`  validate  --env-file PATH [--json]\n`)
  process.stdout.write(`  install   --env-file PATH [--enable] [--app-executable PATH]\n`)
  process.stdout.write(`  render    --env-file PATH --output DIRECTORY\n`)
  process.stdout.write(`  doctor    --env-file PATH [--json] [--network]\n`)
  process.stdout.write(`  uninstall\n`)
  process.stdout.write(`\nNo command contacts a VPS except doctor --network and the systemd-only tunnel-run command.\n`)
}

async function main() {
  const { command, options, positionals } = parseArguments(process.argv.slice(2))
  if (command === 'help' || command === '--help' || command === '-h') {
    printHelp()
    return
  }
  const commands = {
    validate: commandValidate,
    install: commandInstall,
    render: commandRender,
    doctor: commandDoctor,
    'tunnel-run': commandTunnelRun,
    uninstall: commandUninstall,
  }
  assert(commands[command], `Unknown command ${command}. Run with help for usage.`)
  await commands[command](options, positionals)
}

main().catch((error) => {
  process.stderr.write(`agent-console-remote: ${errorMessage(error)}\n`)
  process.exitCode = 1
})
