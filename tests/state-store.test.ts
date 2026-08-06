import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import type { ConsoleState } from '../shared/types'
import { createDefaultState, sanitizeState, StateStore } from '../core/services/state-store'

async function temporaryDirectory(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'agent-console-state-test-'))
}

function namedState(name: string): ConsoleState {
  const state = createDefaultState()
  state.projects[0] = { ...state.projects[0], name }
  return state
}

describe('state sanitization', () => {
  it('creates neutral Product, Sales, and Management examples', () => {
    const state = createDefaultState()
    expect(state.projects.map((project) => project.name)).toEqual(['Product', 'Sales', 'Management'])
    expect(state.agents).toHaveLength(6)
    expect(state.settings.fontSizePx).toBe(25)
    expect(state.settings.theme).toBe('navy-gold')
  })

  it('repairs invalid fields without losing valid records', () => {
    const state = sanitizeState({
      projects: [{ id: 'my project', name: 'My Project', color: 'invalid' }],
      agents: [{ id: 'agent one', name: 'Agent One', projectId: 'my-project', kind: 'codex', terminalApp: 'unknown' }],
      settings: { scanIntervalMs: 50, defaultTerminal: 'unknown', fontSizePx: 99, theme: 'unknown' },
    })
    expect(state.projects[0].id).toBe('my-project')
    expect(state.agents[0].projectId).toBe('my-project')
    expect(state.agents[0].terminalApp).toBe('auto')
    expect(state.settings.scanIntervalMs).toBe(1000)
    expect(state.settings.fontSizePx).toBe(50)
    expect(state.settings.theme).toBe('navy-gold')
  })

  it('preserves a valid appearance preference', () => {
    const state = sanitizeState({
      projects: [{ id: 'project', name: 'Project' }],
      agents: [],
      settings: {
        defaultTerminal: 'auto',
        scanIntervalMs: 2500,
        compactMode: false,
        fontSizePx: 5,
        theme: 'persian-night',
      },
    })
    expect(state.settings.fontSizePx).toBe(5)
    expect(state.settings.theme).toBe('persian-night')
  })
})

describe('StateStore persistence', () => {
  it('serializes 100 concurrent saves and leaves the final two complete revisions on disk', async () => {
    const directory = await temporaryDirectory()
    try {
      const store = new StateStore(directory)
      await store.load()
      const results = await Promise.all(
        Array.from({ length: 100 }, (_, index) => store.save(namedState(`Product ${index}`))),
      )

      expect(results.map((state) => state.projects[0].name)).toEqual(
        Array.from({ length: 100 }, (_, index) => `Product ${index}`),
      )
      expect(store.current.projects[0].name).toBe('Product 99')

      const primary = JSON.parse(await fs.readFile(path.join(directory, 'mission-control-state.json'), 'utf8')) as ConsoleState
      const backup = JSON.parse(await fs.readFile(path.join(directory, 'mission-control-state.json.bak'), 'utf8')) as ConsoleState
      expect(primary.projects[0].name).toBe('Product 99')
      expect(backup.projects[0].name).toBe('Product 98')
      expect((await fs.readdir(directory)).some((name) => name.endsWith('.tmp'))).toBe(false)
    } finally {
      await fs.rm(directory, { recursive: true, force: true })
    }
  })

  it('recovers a malformed primary file from the last valid backup and preserves the damaged bytes', async () => {
    const directory = await temporaryDirectory()
    try {
      const primaryPath = path.join(directory, 'mission-control-state.json')
      const first = new StateStore(directory)
      await first.load()
      await first.save(namedState('Durable A'))
      await first.save(namedState('Durable B'))
      await fs.writeFile(primaryPath, '{"projects": [', 'utf8')

      const recovered = new StateStore(directory)
      const state = await recovered.load()
      expect(state.projects[0].name).toBe('Durable A')
      expect(recovered.loadNotice).toContain('restored the last valid backup')
      expect(JSON.parse(await fs.readFile(primaryPath, 'utf8')).projects[0].name).toBe('Durable A')
      expect((await fs.readdir(directory)).some((name) => name.startsWith('mission-control-state.json.corrupt-'))).toBe(true)
    } finally {
      await fs.rm(directory, { recursive: true, force: true })
    }
  })

  it('preserves structurally invalid files instead of silently overwriting the only copy', async () => {
    const directory = await temporaryDirectory()
    try {
      const primaryPath = path.join(directory, 'mission-control-state.json')
      const backupPath = `${primaryPath}.bak`
      await fs.writeFile(primaryPath, '{}\n', 'utf8')
      await fs.writeFile(backupPath, '{"version":1,"projects":[null],"agents":[],"settings":{}}\n', 'utf8')

      const store = new StateStore(directory)
      const state = await store.load()
      expect(state.projects.map((project) => project.name)).toEqual(['Product', 'Sales', 'Management'])
      expect(store.loadNotice).toContain('preserved as')
      const files = await fs.readdir(directory)
      expect(files.some((name) => name.startsWith('mission-control-state.json.corrupt-'))).toBe(true)
      expect(files.some((name) => name.startsWith('mission-control-state.json.bak.corrupt-'))).toBe(true)
    } finally {
      await fs.rm(directory, { recursive: true, force: true })
    }
  })

  it('continues the FIFO queue after one write failure', async () => {
    const directory = await temporaryDirectory()
    const blockedPath = path.join(directory, 'blocked')
    try {
      await fs.writeFile(blockedPath, 'not a directory', 'utf8')
      const store = new StateStore(blockedPath)
      await expect(store.save(namedState('Will fail'))).rejects.toBeTruthy()

      await fs.rm(blockedPath)
      await fs.mkdir(blockedPath)
      const saved = await store.save(namedState('Will succeed'))
      expect(saved.projects[0].name).toBe('Will succeed')
      expect(store.current.projects[0].name).toBe('Will succeed')
    } finally {
      await fs.rm(directory, { recursive: true, force: true })
    }
  })

  it('flushes every queued save before shutdown continues', async () => {
    const directory = await temporaryDirectory()
    try {
      const store = new StateStore(directory)
      await store.load()
      const saves = Array.from({ length: 20 }, (_, index) => store.save(namedState(`Queued ${index}`)))
      await store.flush()

      const primary = JSON.parse(await fs.readFile(path.join(directory, 'mission-control-state.json'), 'utf8')) as ConsoleState
      expect(primary.projects[0].name).toBe('Queued 19')
      await expect(Promise.all(saves)).resolves.toHaveLength(20)
    } finally {
      await fs.rm(directory, { recursive: true, force: true })
    }
  })

  it('rejects a state that the next launch would reject', async () => {
    const directory = await temporaryDirectory()
    try {
      const store = new StateStore(directory)
      const original = await store.load()
      const duplicate = structuredClone(original)
      duplicate.projects[1].id = duplicate.projects[0].id

      await expect(store.save(duplicate)).rejects.toThrow('duplicate identifiers')
      expect(store.current).toEqual(original)
      const primary = JSON.parse(await fs.readFile(path.join(directory, 'mission-control-state.json'), 'utf8')) as ConsoleState
      expect(primary).toEqual(original)
    } finally {
      await fs.rm(directory, { recursive: true, force: true })
    }
  })

  it('orders validation failures behind earlier durable saves', async () => {
    const directory = await temporaryDirectory()
    try {
      const store = new StateStore(directory)
      const original = await store.load()
      let firstSettled = false
      const first = store.save(namedState('Durable before rejection')).finally(() => {
        firstSettled = true
      })
      const duplicate = structuredClone(original)
      duplicate.projects[1].id = duplicate.projects[0].id

      await expect(store.save(duplicate)).rejects.toThrow('duplicate identifiers')
      expect(firstSettled).toBe(true)
      expect((await first).projects[0].name).toBe('Durable before rejection')
      expect(store.current.projects[0].name).toBe('Durable before rejection')
      const primary = JSON.parse(await fs.readFile(path.join(directory, 'mission-control-state.json'), 'utf8')) as ConsoleState
      expect(primary.projects[0].name).toBe('Durable before rejection')
    } finally {
      await fs.rm(directory, { recursive: true, force: true })
    }
  })

  it('does not replace an unreadable primary path with defaults', async () => {
    const directory = await temporaryDirectory()
    const primaryPath = path.join(directory, 'mission-control-state.json')
    try {
      await fs.mkdir(primaryPath)
      const store = new StateStore(directory)
      await expect(store.load()).rejects.toBeTruthy()
      expect((await fs.stat(primaryPath)).isDirectory()).toBe(true)
    } finally {
      await fs.rm(directory, { recursive: true, force: true })
    }
  })
})
