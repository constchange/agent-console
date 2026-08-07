import { execFile } from 'node:child_process'
import { constants } from 'node:fs'
import { copyFile, lstat, open, readFile, rename, rm } from 'node:fs/promises'
import { createHash, randomUUID } from 'node:crypto'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const HASH_CHUNK_BYTES = 1024 * 1024
const SAFE_VERSION = /^[0-9A-Za-z][0-9A-Za-z.+-]*$/u

function invariant(condition, message) {
  if (!condition) throw new Error(message)
}

function assertVersion(version) {
  invariant(typeof version === 'string' && SAFE_VERSION.test(version), `Unsafe package version: ${String(version)}`)
}

async function requireRegularFile(filePath, label) {
  let stat
  try {
    stat = await lstat(filePath)
  } catch (error) {
    if (error && typeof error === 'object' && error.code === 'ENOENT') {
      throw new Error(`${label} is missing: ${filePath}`, { cause: error })
    }
    throw error
  }
  invariant(stat.isFile() && !stat.isSymbolicLink(), `${label} must be one regular, non-linked file: ${filePath}`)
  invariant(stat.size > 0, `${label} is empty: ${filePath}`)
  return stat
}

function sameFileSnapshot(first, second) {
  return first.dev === second.dev
    && first.ino === second.ino
    && first.size === second.size
    && first.mtimeMs === second.mtimeMs
    && first.ctimeMs === second.ctimeMs
}

export async function sha256File(filePath) {
  const handle = await open(filePath, 'r')
  const hash = createHash('sha256')
  const buffer = Buffer.allocUnsafe(HASH_CHUNK_BYTES)
  let position = 0
  try {
    while (true) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, position)
      if (bytesRead === 0) break
      hash.update(buffer.subarray(0, bytesRead))
      position += bytesRead
    }
  } finally {
    await handle.close()
  }
  return hash.digest('hex')
}

export async function filesAreByteIdentical(firstPath, secondPath) {
  const [firstStat, secondStat] = await Promise.all([lstat(firstPath), lstat(secondPath)])
  if (!firstStat.isFile() || firstStat.isSymbolicLink() || !secondStat.isFile() || secondStat.isSymbolicLink()) return false
  if (firstStat.size !== secondStat.size) return false

  const [firstHandle, secondHandle] = await Promise.all([open(firstPath, 'r'), open(secondPath, 'r')])
  const firstBuffer = Buffer.allocUnsafe(HASH_CHUNK_BYTES)
  const secondBuffer = Buffer.allocUnsafe(HASH_CHUNK_BYTES)
  let position = 0
  try {
    while (position < firstStat.size) {
      const length = Math.min(HASH_CHUNK_BYTES, firstStat.size - position)
      const [firstRead, secondRead] = await Promise.all([
        firstHandle.read(firstBuffer, 0, length, position),
        secondHandle.read(secondBuffer, 0, length, position),
      ])
      if (firstRead.bytesRead !== length || secondRead.bytesRead !== length) return false
      if (!firstBuffer.subarray(0, length).equals(secondBuffer.subarray(0, length))) return false
      position += length
    }
    return true
  } finally {
    await Promise.all([firstHandle.close(), secondHandle.close()])
  }
}

export async function inspectDebArchitecture(debPath) {
  const { stdout } = await execFileAsync('dpkg-deb', ['--field', debPath, 'Architecture'], {
    encoding: 'utf8',
    timeout: 30_000,
    maxBuffer: 1024 * 1024,
  })
  return stdout.trim()
}

export async function createDebX8664Alias({
  releaseDirectory,
  version,
  architectureInspector = inspectDebArchitecture,
}) {
  assertVersion(version)
  const outputDirectory = path.resolve(releaseDirectory)
  const canonicalPath = path.join(outputDirectory, `Agent-Console-${version}-amd64.deb`)
  const aliasPath = path.join(outputDirectory, `Agent-Console-${version}-x86_64.deb`)
  const temporaryPath = path.join(outputDirectory, `.${path.basename(aliasPath)}.${process.pid}.${randomUUID()}.tmp`)

  const initialCanonicalStat = await requireRegularFile(canonicalPath, 'Canonical amd64 deb')
  const architecture = String(await architectureInspector(canonicalPath)).trim()
  invariant(architecture === 'amd64', `Canonical deb Architecture must be amd64, but was ${architecture || '(empty)'}`)
  const canonicalHashBefore = await sha256File(canonicalPath)

  try {
    await copyFile(canonicalPath, temporaryPath, constants.COPYFILE_EXCL)
    const temporaryStat = await requireRegularFile(temporaryPath, 'Temporary x86_64 deb alias')
    invariant(temporaryStat.size === initialCanonicalStat.size, 'Temporary x86_64 deb alias has an unexpected size')

    const [temporaryHash, temporaryMatches] = await Promise.all([
      sha256File(temporaryPath),
      filesAreByteIdentical(canonicalPath, temporaryPath),
    ])
    invariant(temporaryHash === canonicalHashBefore && temporaryMatches, 'Temporary x86_64 deb alias differs from the canonical amd64 deb')

    const finalCanonicalStat = await requireRegularFile(canonicalPath, 'Canonical amd64 deb')
    invariant(sameFileSnapshot(initialCanonicalStat, finalCanonicalStat), 'Canonical amd64 deb changed while its alias was being created')

    // Both paths are in the same directory, so rename replaces an old alias atomically on Linux.
    await rename(temporaryPath, aliasPath)
    const aliasStat = await requireRegularFile(aliasPath, 'x86_64 deb alias')
    invariant(aliasStat.size === finalCanonicalStat.size, 'x86_64 deb alias has an unexpected size after replacement')

    const [canonicalHashAfter, aliasHash, aliasMatches] = await Promise.all([
      sha256File(canonicalPath),
      sha256File(aliasPath),
      filesAreByteIdentical(canonicalPath, aliasPath),
    ])
    invariant(canonicalHashAfter === canonicalHashBefore, 'Canonical amd64 deb changed after its alias was created')
    invariant(aliasHash === canonicalHashAfter && aliasMatches, 'x86_64 deb alias is not byte-identical to the canonical amd64 deb')

    return { canonicalPath, aliasPath, architecture, sha256: canonicalHashAfter }
  } finally {
    await rm(temporaryPath, { force: true }).catch(() => undefined)
  }
}

async function runCli() {
  invariant(process.argv.length <= 3, 'Usage: node scripts/create-deb-x86_64-alias.mjs [release-directory]')
  const packageJson = JSON.parse(await readFile(path.join(projectRoot, 'package.json'), 'utf8'))
  const releaseDirectory = process.argv[2] ? path.resolve(process.argv[2]) : path.join(projectRoot, 'release')
  const result = await createDebX8664Alias({ releaseDirectory, version: packageJson.version })
  process.stdout.write(`Created ${path.basename(result.aliasPath)} from the canonical amd64 deb (SHA-256 ${result.sha256}).\n`)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runCli().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  })
}
