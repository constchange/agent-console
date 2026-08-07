import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { SecureSessionStorage, type SafeStorageLike } from '../core/auth/secure-session-storage'

const directories: string[] = []

function fakeSafeStorage(backend = 'gnome_libsecret'): SafeStorageLike {
  return {
    isEncryptionAvailable: () => true,
    getSelectedStorageBackend: () => backend,
    encryptString: (text) => Buffer.from([...Buffer.from(text, 'utf8')].map((byte) => byte ^ 0xa5)),
    decryptString: (data) => Buffer.from([...data].map((byte) => byte ^ 0xa5)).toString('utf8'),
  }
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

describe('SecureSessionStorage', () => {
  it('persists encrypted values with private permissions and survives restart', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'agent-console-secure-storage-'))
    directories.push(directory)
    const file = path.join(directory, 'auth', 'session.enc.json')
    const first = new SecureSessionStorage(file, fakeSafeStorage())
    await first.initialize()
    await first.setItem('supabase.session', 'refresh-token-do-not-leak')
    await first.close()

    expect((await stat(path.dirname(file))).mode & 0o777).toBe(0o700)
    expect((await stat(file)).mode & 0o777).toBe(0o600)
    expect(await readFile(file, 'utf8')).not.toContain('refresh-token-do-not-leak')

    const second = new SecureSessionStorage(file, fakeSafeStorage())
    expect(await second.getItem('supabase.session')).toBe('refresh-token-do-not-leak')
    await second.removeItem('supabase.session')
    expect(await second.getItem('supabase.session')).toBeNull()
    await second.close()
  })

  it('rejects Linux basic_text without creating a token file', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'agent-console-basic-text-'))
    directories.push(directory)
    const file = path.join(directory, 'auth.enc.json')
    const storage = new SecureSessionStorage(file, fakeSafeStorage('basic_text'))
    await expect(storage.setItem('supabase.session', 'secret')).rejects.toThrow('remains locked')
    await expect(stat(file)).rejects.toMatchObject({ code: 'ENOENT' })
  })
})
