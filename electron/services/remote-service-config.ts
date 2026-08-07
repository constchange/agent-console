import { promises as fs } from 'node:fs'
import path from 'node:path'
import { assertPrivateRegularFile } from './remote-service-manager'

const MAX_ENVIRONMENT_BYTES = 64 * 1_024
const REQUIRED_PATHS = ['AGENT_CONSOLE_SSH_KEY_PATH', 'AGENT_CONSOLE_SSH_PUBLIC_KEY_PATH', 'AGENT_CONSOLE_SSH_KNOWN_HOSTS_PATH'] as const

function decodeValue(raw: string, lineNumber: number): string {
  const value = raw.trim()
  if (!value.startsWith('"') && !value.startsWith("'")) return value
  const quote = value[0]
  if (value.length < 2 || value[value.length - 1] !== quote) throw new Error(`Remote environment line ${lineNumber} is malformed.`)
  const body = value.slice(1, -1)
  if (quote === "'") {
    if (body.includes("'")) throw new Error(`Remote environment line ${lineNumber} is malformed.`)
    return body
  }
  if (/\\(?![\\"nrt])/.test(body)) throw new Error(`Remote environment line ${lineNumber} has an unsupported escape.`)
  return body.replace(/\\n/g, '\n').replace(/\\r/g, '\r').replace(/\\t/g, '\t').replace(/\\"/g, '"').replace(/\\\\/g, '\\')
}

function privateAbsolutePath(value: string, label: string): string {
  if (!value
    || !path.isAbsolute(value)
    || path.normalize(value) !== value
    || Buffer.byteLength(value, 'utf8') > 4_096
    || /[\0\r\n]/.test(value)) {
    throw new Error(`${label} is invalid.`)
  }
  return value
}

/** Reads only the SSH paths needed to render user service units. */
export async function readRemoteServicePrivatePaths(environmentFile: string): Promise<{
  sshKeyPath: string
  sshPublicKeyPath: string
  knownHostsPath: string
}> {
  await assertPrivateRegularFile(environmentFile, 'Remote environment file')
  const stat = await fs.stat(environmentFile)
  if (stat.size > MAX_ENVIRONMENT_BYTES) throw new Error('Remote environment file is too large.')
  const values = new Map<string, string>()
  const contents = await fs.readFile(environmentFile, 'utf8')
  for (const [index, original] of contents.split(/\r?\n/).entries()) {
    const line = original.trim()
    if (!line || line.startsWith('#')) continue
    const match = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line)
    if (!match) throw new Error(`Remote environment line ${index + 1} is malformed.`)
    if (!REQUIRED_PATHS.includes(match[1] as typeof REQUIRED_PATHS[number])) continue
    if (values.has(match[1])) throw new Error(`Remote environment defines ${match[1]} more than once.`)
    values.set(match[1], decodeValue(match[2], index + 1))
  }
  const sshKeyPath = privateAbsolutePath(values.get(REQUIRED_PATHS[0]) ?? '', 'Dedicated SSH private-key path')
  const sshPublicKeyPath = privateAbsolutePath(values.get(REQUIRED_PATHS[1]) ?? '', 'Dedicated SSH public-key path')
  const knownHostsPath = privateAbsolutePath(values.get(REQUIRED_PATHS[2]) ?? '', 'Dedicated SSH known-hosts path')
  if (new Set([sshKeyPath, sshPublicKeyPath, knownHostsPath]).size !== 3) throw new Error('SSH key and known-hosts paths must be different.')
  return { sshKeyPath, sshPublicKeyPath, knownHostsPath }
}
