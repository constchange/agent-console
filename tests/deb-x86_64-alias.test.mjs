import { execFile } from 'node:child_process'
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'
import {
  createDebX8664Alias,
  filesAreByteIdentical,
  sha256File,
} from '../scripts/create-deb-x86_64-alias.mjs'

const execFileAsync = promisify(execFile)
const root = path.resolve(import.meta.dirname, '..')
const script = path.join(root, 'scripts', 'create-deb-x86_64-alias.mjs')
const packageJson = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'))
const fixtures = []

async function fixture() {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'agent-console-deb-alias-'))
  fixtures.push(directory)
  return directory
}

async function buildMinimalDeb(releaseDirectory, architecture) {
  const packageRoot = path.join(releaseDirectory, `package-${architecture}`)
  const controlDirectory = path.join(packageRoot, 'DEBIAN')
  await mkdir(controlDirectory, { recursive: true })
  await writeFile(path.join(controlDirectory, 'control'), [
    'Package: agent-console-alias-fixture',
    'Version: 1.0.0',
    `Architecture: ${architecture}`,
    'Maintainer: Agent Console tests <tests@example.invalid>',
    'Description: Minimal package for deb alias verification',
    '',
  ].join('\n'))
  const canonicalPath = path.join(releaseDirectory, `Agent-Console-${packageJson.version}-amd64.deb`)
  await execFileAsync('dpkg-deb', ['--build', packageRoot, canonicalPath], { timeout: 30_000, maxBuffer: 1024 * 1024 })
  return canonicalPath
}

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

describe('x86_64 deb release alias', () => {
  it('atomically replaces an old alias with a byte- and hash-identical copy', async () => {
    const releaseDirectory = await fixture()
    const version = '9.8.7-test.1'
    const canonicalPath = path.join(releaseDirectory, `Agent-Console-${version}-amd64.deb`)
    const aliasPath = path.join(releaseDirectory, `Agent-Console-${version}-x86_64.deb`)
    await writeFile(canonicalPath, Buffer.from('canonical-amd64-deb-fixture'))
    await writeFile(aliasPath, Buffer.from('stale-alias'))

    const result = await createDebX8664Alias({
      releaseDirectory,
      version,
      architectureInspector: async () => 'amd64',
    })

    expect(result).toMatchObject({ canonicalPath, aliasPath, architecture: 'amd64' })
    expect(await filesAreByteIdentical(canonicalPath, aliasPath)).toBe(true)
    expect(await sha256File(aliasPath)).toBe(await sha256File(canonicalPath))
    expect((await readdir(releaseDirectory)).some((name) => name.endsWith('.tmp'))).toBe(false)
  })

  it('preserves an existing alias when the canonical package is missing or has the wrong architecture', async () => {
    const releaseDirectory = await fixture()
    const version = '9.8.7-test.2'
    const aliasPath = path.join(releaseDirectory, `Agent-Console-${version}-x86_64.deb`)
    await writeFile(aliasPath, 'previous-valid-alias')

    await expect(createDebX8664Alias({
      releaseDirectory,
      version,
      architectureInspector: async () => 'amd64',
    })).rejects.toThrow('Canonical amd64 deb is missing')
    expect(await readFile(aliasPath, 'utf8')).toBe('previous-valid-alias')

    await writeFile(path.join(releaseDirectory, `Agent-Console-${version}-amd64.deb`), 'not-amd64')
    await expect(createDebX8664Alias({
      releaseDirectory,
      version,
      architectureInspector: async () => 'arm64',
    })).rejects.toThrow('Architecture must be amd64')
    expect(await readFile(aliasPath, 'utf8')).toBe('previous-valid-alias')
  })

  it('uses dpkg metadata in the CLI and rejects a falsely named non-amd64 package', async () => {
    const amd64Directory = await fixture()
    const canonicalPath = await buildMinimalDeb(amd64Directory, 'amd64')
    await execFileAsync(process.execPath, [script, amd64Directory], { timeout: 30_000, maxBuffer: 1024 * 1024 })
    const aliasPath = path.join(amd64Directory, `Agent-Console-${packageJson.version}-x86_64.deb`)
    expect(await filesAreByteIdentical(canonicalPath, aliasPath)).toBe(true)
    const { stdout } = await execFileAsync('dpkg-deb', ['--field', aliasPath, 'Architecture'], { encoding: 'utf8' })
    expect(stdout.trim()).toBe('amd64')

    const arm64Directory = await fixture()
    await buildMinimalDeb(arm64Directory, 'arm64')
    await expect(execFileAsync(process.execPath, [script, arm64Directory], {
      timeout: 30_000,
      maxBuffer: 1024 * 1024,
    })).rejects.toMatchObject({ stderr: expect.stringContaining('Architecture must be amd64') })
    await expect(readFile(path.join(arm64Directory, `Agent-Console-${packageJson.version}-x86_64.deb`))).rejects.toThrow()
  })
})
