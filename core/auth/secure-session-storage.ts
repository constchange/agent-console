import { promises as fs } from 'node:fs'
import path from 'node:path'

const STORAGE_VERSION = 1
const MAX_KEY_LENGTH = 200
const MAX_VALUE_LENGTH = 128 * 1024
const MAX_STORAGE_BYTES = 256 * 1024

export interface SafeStorageLike {
  isEncryptionAvailable(): boolean
  getSelectedStorageBackend(): string
  encryptString(plainText: string): Buffer
  decryptString(encrypted: Buffer): string
}

export interface AsyncStringStorage {
  getItem(key: string): Promise<string | null>
  setItem(key: string, value: string): Promise<void>
  removeItem(key: string): Promise<void>
}

interface EncryptedFile {
  version: number
  ciphertext: string
}

function errorCode(error: unknown): string {
  return error && typeof error === 'object' && 'code' in error ? String(error.code) : ''
}

function validateKey(key: string): string {
  if (!key || key.length > MAX_KEY_LENGTH || !/^[a-zA-Z0-9_.:-]+$/.test(key)) {
    throw new Error('Secure storage key is invalid.')
  }
  return key
}

function validateValue(value: string): string {
  if (typeof value !== 'string' || Buffer.byteLength(value, 'utf8') > MAX_VALUE_LENGTH) {
    throw new Error('Secure storage value is too large.')
  }
  return value
}

async function syncDirectory(directory: string): Promise<void> {
  const handle = await fs.open(directory, 'r')
  try {
    await handle.sync()
  } catch (error) {
    if (!['EINVAL', 'ENOTSUP', 'EISDIR'].includes(errorCode(error))) throw error
  } finally {
    await handle.close()
  }
}

/**
 * A Supabase-compatible storage adapter whose entire payload is encrypted by
 * Electron safeStorage. On Linux, the `basic_text` fallback is intentionally
 * rejected: remote control stays locked instead of silently writing a refresh
 * token with reversible, machine-local obfuscation.
 */
export class SecureSessionStorage implements AsyncStringStorage {
  private entries: Record<string, string> | null = null
  private operationQueue: Promise<void> = Promise.resolve()

  constructor(
    private readonly filePath: string,
    private readonly safeStorage: SafeStorageLike,
  ) {
    if (!path.isAbsolute(filePath)) throw new Error('Secure session storage path must be absolute.')
  }

  assertSecureBackend(): void {
    if (!this.safeStorage.isEncryptionAvailable()) {
      throw new Error('The operating-system keyring is unavailable. Remote control remains locked.')
    }
    const backend = this.safeStorage.getSelectedStorageBackend().trim().toLowerCase()
    if (!backend || backend === 'basic_text') {
      throw new Error('The operating-system keyring did not provide secure encryption. Remote control remains locked.')
    }
  }

  async initialize(): Promise<void> {
    await this.serialize(async () => {
      this.assertSecureBackend()
      await this.ensureDirectory()
      await this.loadUnlocked()
    })
  }

  async getItem(key: string): Promise<string | null> {
    const safeKey = validateKey(key)
    await this.ready()
    return this.entries?.[safeKey] ?? null
  }

  async setItem(key: string, value: string): Promise<void> {
    const safeKey = validateKey(key)
    const safeValue = validateValue(value)
    await this.serialize(async () => {
      await this.readyUnlocked()
      const next = { ...this.entries, [safeKey]: safeValue }
      await this.persistUnlocked(next)
      this.entries = next
    })
  }

  async removeItem(key: string): Promise<void> {
    const safeKey = validateKey(key)
    await this.serialize(async () => {
      await this.readyUnlocked()
      if (!Object.prototype.hasOwnProperty.call(this.entries, safeKey)) return
      const next = { ...this.entries }
      delete next[safeKey]
      await this.persistUnlocked(next)
      this.entries = next
    })
  }

  async clear(): Promise<void> {
    await this.serialize(async () => {
      await this.readyUnlocked()
      await this.persistUnlocked({})
      this.entries = {}
    })
  }

  async close(): Promise<void> {
    await this.operationQueue
    this.entries = null
  }

  private async ready(): Promise<void> {
    if (this.entries) return
    await this.initialize()
  }

  private async readyUnlocked(): Promise<void> {
    this.assertSecureBackend()
    await this.ensureDirectory()
    if (!this.entries) await this.loadUnlocked()
  }

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operationQueue.then(operation, operation)
    this.operationQueue = result.then(() => undefined, () => undefined)
    return result
  }

  private async ensureDirectory(): Promise<void> {
    const directory = path.dirname(this.filePath)
    await fs.mkdir(directory, { recursive: true, mode: 0o700 })
    const stat = await fs.lstat(directory)
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new Error('Secure session storage directory must be a real directory.')
    }
    if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) {
      throw new Error('Secure session storage directory is owned by another user.')
    }
    await fs.chmod(directory, 0o700)
  }

  private async loadUnlocked(): Promise<void> {
    let encoded: string
    try {
      const stat = await fs.lstat(this.filePath)
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Secure session storage must be a regular file.')
      if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) {
        throw new Error('Secure session storage is owned by another user.')
      }
      if (stat.size > MAX_STORAGE_BYTES * 2) throw new Error('Secure session storage file is too large.')
      await fs.chmod(this.filePath, 0o600)
      encoded = await fs.readFile(this.filePath, 'utf8')
    } catch (error) {
      if (errorCode(error) === 'ENOENT') {
        this.entries = {}
        return
      }
      throw error
    }

    let wrapper: EncryptedFile
    try {
      wrapper = JSON.parse(encoded) as EncryptedFile
    } catch {
      throw new Error('Secure session storage is damaged and was not replaced.')
    }
    if (wrapper.version !== STORAGE_VERSION || typeof wrapper.ciphertext !== 'string' || !wrapper.ciphertext) {
      throw new Error('Secure session storage format is unsupported.')
    }

    let plainText: string
    try {
      plainText = this.safeStorage.decryptString(Buffer.from(wrapper.ciphertext, 'base64'))
    } catch {
      throw new Error('Secure session storage could not be unlocked with the operating-system keyring.')
    }
    if (Buffer.byteLength(plainText, 'utf8') > MAX_STORAGE_BYTES) {
      throw new Error('Decrypted secure session storage is too large.')
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(plainText)
    } catch {
      throw new Error('Decrypted secure session storage is damaged.')
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('Decrypted secure session storage is invalid.')
    }
    const entries: Record<string, string> = {}
    for (const [key, value] of Object.entries(parsed)) {
      entries[validateKey(key)] = validateValue(value as string)
    }
    this.entries = entries
  }

  private async persistUnlocked(entries: Record<string, string>): Promise<void> {
    const plainText = JSON.stringify(entries)
    if (Buffer.byteLength(plainText, 'utf8') > MAX_STORAGE_BYTES) {
      throw new Error('Secure session storage has reached its safe size limit.')
    }
    const ciphertext = this.safeStorage.encryptString(plainText).toString('base64')
    const contents = `${JSON.stringify({ version: STORAGE_VERSION, ciphertext })}\n`
    const temporary = `${this.filePath}.${process.pid}-${Date.now()}.tmp`
    try {
      await fs.writeFile(temporary, contents, { encoding: 'utf8', mode: 0o600, flag: 'wx' })
      const handle = await fs.open(temporary, 'r')
      try {
        await handle.sync()
      } finally {
        await handle.close()
      }
      await fs.rename(temporary, this.filePath)
      await fs.chmod(this.filePath, 0o600)
      await syncDirectory(path.dirname(this.filePath))
    } finally {
      await fs.rm(temporary, { force: true })
    }
  }
}
