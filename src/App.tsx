import {
  Bell,
  CheckCircle2,
  ChevronRight,
  Command,
  Cpu,
  Download,
  Radar,
  RefreshCw,
  Server,
  TriangleAlert,
  Type,
  X,
} from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import type {
  AgentConfig,
  ConsoleSettings,
  ConsoleState,
  CoreConnectionPhase,
  CoreConnectionState,
  CoreHealth,
  DiscoveredItem,
  Project,
  RuntimeAgent,
  RuntimeSnapshot,
  UpdateState,
} from '../shared/types'
import { Dashboard } from './components/Dashboard'
import { DiscoveryDrawer } from './components/DiscoveryDrawer'
import { AgentEditor, ProjectEditor, SettingsEditor } from './components/Editors'
import { Sidebar } from './components/Sidebar'
import { getApi } from './lib/api'
import { STATUS_META, uniqueId } from './lib/format'

type EditorState =
  | { type: 'agent'; initial: Partial<AgentConfig>; existing: boolean }
  | { type: 'project'; initial?: Project }
  | { type: 'settings' }
  | null

interface ToastState {
  tone: 'success' | 'error' | 'info'
  message: string
}

const CORE_CONNECTION_LABELS: Record<CoreConnectionPhase, string> = {
  starting: 'STARTING',
  connected: 'CONNECTED',
  reconnecting: 'RECONNECTING',
  offline: 'OFFLINE',
  incompatible: 'VERSION MISMATCH',
}

function hydrateSnapshot(state: ConsoleState, snapshot: RuntimeSnapshot): RuntimeSnapshot {
  const runtimeById = new Map(snapshot.agents.map((agent) => [agent.id, agent]))
  const now = new Date().toISOString()
  const agents: RuntimeAgent[] = state.agents.map((config) => {
    const runtime = runtimeById.get(config.id)
    if (runtime) return { ...runtime, ...config }
    return {
      ...config,
      pid: config.pid ?? null,
      cpu: 0,
      memory: 0,
      runtimeSeconds: 0,
      status: config.statusOverride ?? 'offline',
      lastUpdated: now,
      lastOutput: 'No live process matched',
      processName: '',
      processState: '',
      terminalOpen: false,
    }
  })
  return { ...snapshot, agents }
}

function importDraft(item: DiscoveredItem, projectId: string, order: number): AgentConfig {
  return {
    id: uniqueId('agent'),
    projectId,
    name: item.suggestedName,
    emoji: item.emoji,
    color: item.color,
    kind: item.kind,
    terminalTitle: item.terminalTitle,
    terminalApp: 'auto',
    tmuxSession: item.tmuxSession,
    command: '',
    cwd: item.cwd,
    matchPattern: '',
    logPath: '',
    autoStart: Boolean(item.tmuxSession),
    order,
    pid: item.pid,
    statusOverride: null,
  }
}

export default function App() {
  const api = useMemo(() => getApi(), [])
  const [state, setState] = useState<ConsoleState | null>(null)
  const [snapshot, setSnapshot] = useState<RuntimeSnapshot | null>(null)
  const [appVersion, setAppVersion] = useState('')
  const [updateState, setUpdateState] = useState<UpdateState | null>(null)
  const [coreHealth, setCoreHealth] = useState<CoreHealth | null>(null)
  const [coreConnection, setCoreConnection] = useState<CoreConnectionState>({
    phase: 'starting',
    message: 'Starting local Console Core…',
    coreVersion: null,
    protocolVersion: null,
  })
  const [selectedProjectId, setSelectedProjectId] = useState('all')
  const [search, setSearch] = useState('')
  const [editor, setEditor] = useState<EditorState>(null)
  const [discoveryOpen, setDiscoveryOpen] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const [toast, setToast] = useState<ToastState | null>(null)
  const [appearancePreview, setAppearancePreview] = useState<ConsoleSettings | null>(null)
  const toastTimer = useRef<number | null>(null)
  const editorOpenRef = useRef(false)
  const queuedSnapshotRef = useRef<RuntimeSnapshot | null>(null)
  const previousUpdatePhaseRef = useRef<UpdateState['phase'] | null>(null)
  const stateRef = useRef<ConsoleState | null>(null)
  const durableStateRef = useRef<ConsoleState | null>(null)
  const latestSaveRef = useRef(0)
  const latestDurableSaveRef = useRef(0)
  const nativeZoomAvailable = Boolean(window.agentConsole)
  const effectiveFontSize = appearancePreview?.fontSizePx ?? state?.settings.fontSizePx ?? 13
  const uiScale = effectiveFontSize / 13

  const notify = useCallback((message: string, tone: ToastState['tone'] = 'info') => {
    setToast({ message, tone })
    if (toastTimer.current) window.clearTimeout(toastTimer.current)
    toastTimer.current = window.setTimeout(() => setToast(null), 3_800)
  }, [])

  useEffect(() => {
    let active = true
    let bootstrapSequence = 0
    const applyBootstrap = (bootstrap: Awaited<ReturnType<typeof api.getBootstrap>>, showNotice: boolean) => {
      latestSaveRef.current += 1
      latestDurableSaveRef.current = latestSaveRef.current
      stateRef.current = bootstrap.state
      durableStateRef.current = bootstrap.state
      setState(bootstrap.state)
      if (editorOpenRef.current) queuedSnapshotRef.current = bootstrap.snapshot
      else setSnapshot(bootstrap.snapshot)
      setAppVersion(bootstrap.appVersion)
      setUpdateState(bootstrap.updateState)
      setCoreHealth(bootstrap.core)
      if (showNotice && bootstrap.stateNotice) notify(bootstrap.stateNotice, 'info')
    }
    const synchronizeBootstrap = async (sequence: number, showNotice: boolean) => {
      let lastError: unknown = null
      for (let attempt = 0; attempt < 5 && active && sequence === bootstrapSequence; attempt += 1) {
        try {
          const bootstrap = await api.getBootstrap()
          if (!active || sequence !== bootstrapSequence) return
          applyBootstrap(bootstrap, showNotice && attempt === 0)
          await api.acknowledgeCoreState(bootstrap.stateRevision)
          if (!active || sequence !== bootstrapSequence) return
          setCoreConnection({
            phase: 'connected',
            message: 'Console Core is connected over a local Unix socket.',
            coreVersion: bootstrap.core.appVersion,
            protocolVersion: bootstrap.core.protocolVersion,
          })
          return
        } catch (error) {
          lastError = error
        }
      }
      if (active && sequence === bootstrapSequence && lastError) {
        notify(lastError instanceof Error ? lastError.message : String(lastError), 'error')
      }
    }
    const initialSequence = ++bootstrapSequence
    void synchronizeBootstrap(initialSequence, true)
    const unsubscribe = api.onSnapshot((next) => {
      if (!active) return
      if (editorOpenRef.current) {
        queuedSnapshotRef.current = next
      } else {
        setSnapshot(next)
      }
    })
    const unsubscribeUpdates = api.onUpdateState((next) => {
      if (active) setUpdateState(next)
    })
    const unsubscribeCore = api.onCoreConnection((next) => {
      if (!active) return
      bootstrapSequence += 1
      const sequence = bootstrapSequence
      setCoreConnection(next)
      if (next.phase === 'connected') {
        void synchronizeBootstrap(sequence, false)
      }
    })
    return () => {
      active = false
      unsubscribe()
      unsubscribeUpdates()
      unsubscribeCore()
      if (toastTimer.current) window.clearTimeout(toastTimer.current)
    }
  }, [api, notify])

  useEffect(() => {
    if (!updateState) return
    const previous = previousUpdatePhaseRef.current
    previousUpdatePhaseRef.current = updateState.phase
    if (previous === updateState.phase) return
    if (updateState.phase === 'available') notify(`Agent Console v${updateState.availableVersion} is available`, 'info')
    if (updateState.phase === 'downloaded') notify('Update downloaded — restart when you are ready', 'success')
  }, [notify, updateState])

  useEffect(() => {
    editorOpenRef.current = Boolean(editor)
    if (editor) {
      setDiscoveryOpen(false)
      return
    }
    if (queuedSnapshotRef.current) {
      setSnapshot(queuedSnapshotRef.current)
      queuedSnapshotRef.current = null
    }
  }, [editor])

  useEffect(() => {
    if (!nativeZoomAvailable) return
    void api.setZoomFactor(uiScale).catch((error) => {
      notify(error instanceof Error ? error.message : String(error), 'error')
    })
  }, [api, nativeZoomAvailable, notify, uiScale])

  useEffect(() => {
    const listener = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault()
        const input = document.querySelector<HTMLInputElement>('.sidebar-search input')
        input?.focus()
      }
    }
    window.addEventListener('keydown', listener)
    return () => window.removeEventListener('keydown', listener)
  }, [])

  const persist = useCallback((update: ConsoleState | ((current: ConsoleState) => ConsoleState), successMessage?: string) => {
    const current = stateRef.current
    if (!current) return Promise.resolve()
    const next = typeof update === 'function' ? update(current) : update
    const saveId = latestSaveRef.current + 1
    latestSaveRef.current = saveId
    stateRef.current = next
    setState(next)
    const operation = (async () => {
      try {
        const saved = await api.saveState(next)
        if (saveId >= latestDurableSaveRef.current) {
          latestDurableSaveRef.current = saveId
          durableStateRef.current = saved
        }
        if (saveId === latestSaveRef.current) {
          stateRef.current = saved
          setState(saved)
          if (successMessage) notify(successMessage, 'success')
        }
      } catch (error) {
        if (saveId === latestSaveRef.current) {
          const durable = durableStateRef.current
          if (durable) {
            stateRef.current = durable
            setState(durable)
          }
          const message = error instanceof Error ? error.message : String(error)
          notify(`Changes were not saved. ${message}`, 'error')
        }
        throw error
      }
    })()
    return operation.catch(() => undefined)
  }, [api, notify])

  if (!state || !snapshot || !updateState || !coreHealth) {
    return (
      <div className="boot-screen">
        <div className="brand-mark brand-mark--large"><span /></div>
        <strong>AGENT CONSOLE</strong>
        <small>SCANNING LOCAL SYSTEM</small>
      </div>
    )
  }

  const hydrated = hydrateSnapshot(state, snapshot)
  const globalActive = hydrated.agents.filter((agent) => agent.status === 'running' || agent.status === 'thinking').length
  const globalWaiting = hydrated.agents.filter((agent) => agent.status === 'waiting').length
  const globalErrors = hydrated.agents.filter((agent) => agent.status === 'error').length
  const selectedProject = state.projects.find((project) => project.id === selectedProjectId)
  const updateAttention = ['available', 'downloading', 'downloaded'].includes(updateState.phase)

  const openSettings = () => {
    setAppearancePreview(null)
    setEditor({ type: 'settings' })
  }

  const toggleProject = (project: Project) => {
    void persist((current) => ({
      ...current,
      projects: current.projects.map((item) => item.id === project.id ? { ...item, collapsed: !item.collapsed } : item),
    }))
  }

  const openAgent = async (agentId: string) => {
    const result = await api.openAgent(agentId)
    notify(result.message, result.ok ? 'success' : 'error')
  }

  const closeAgentTerminal = async (agentId: string) => {
    const result = await api.closeAgentTerminal(agentId)
    notify(result.message, result.ok ? 'success' : 'error')
  }

  const restoreProject = async (projectId: string) => {
    const results = await api.restoreProject(projectId)
    const failures = results.filter((result) => !result.ok)
    notify(
      failures.length ? failures[0].message : `${results.length} Agent${results.length === 1 ? '' : 's'} restored`,
      failures.length ? 'error' : 'success',
    )
  }

  const refresh = async () => {
    setRefreshing(true)
    try {
      setSnapshot(await api.refresh())
      notify('Local process scan complete', 'success')
    } catch (error) {
      notify(error instanceof Error ? error.message : String(error), 'error')
    } finally {
      setRefreshing(false)
    }
  }

  const checkForUpdates = async () => {
    try {
      setUpdateState(await api.checkForUpdates())
    } catch (error) {
      notify(error instanceof Error ? error.message : String(error), 'error')
    }
  }

  const downloadUpdate = async () => {
    try {
      setUpdateState(await api.downloadUpdate())
    } catch (error) {
      notify(error instanceof Error ? error.message : String(error), 'error')
    }
  }

  const installUpdate = async () => {
    try {
      const result = await api.installUpdate()
      if (!result.ok) notify(result.message, 'error')
    } catch (error) {
      notify(error instanceof Error ? error.message : String(error), 'error')
    }
  }

  const saveAgent = (agent: AgentConfig, existing: boolean) => {
    setEditor(null)
    void persist((current) => {
      const agents = existing
        ? current.agents.map((item) => item.id === agent.id ? agent : item)
        : [...current.agents, {
            ...agent,
            order: current.agents.filter((item) => item.projectId === agent.projectId).length,
          }]
      return { ...current, agents }
    }, existing ? 'Agent updated' : 'Agent added to Mission Control')
  }

  const deleteAgent = (agentId: string) => {
    if (!stateRef.current?.agents.some((item) => item.id === agentId)) return
    setEditor(null)
    void persist((current) => ({
      ...current,
      agents: current.agents.filter((item) => item.id !== agentId),
    }), 'Agent removed')
  }

  const saveProject = (project: Project, existing: boolean) => {
    setEditor(null)
    setSelectedProjectId(project.id)
    void persist((current) => ({
      ...current,
      projects: existing
        ? current.projects.map((item) => item.id === project.id ? project : item)
        : [...current.projects, { ...project, order: current.projects.length }],
    }), existing ? 'Project updated' : 'Project created')
  }

  const deleteProject = (projectId: string) => {
    const current = stateRef.current
    if (!current || current.agents.some((agent) => agent.projectId === projectId)) return
    if (!current.projects.some((item) => item.id === projectId)) return
    setEditor(null)
    setSelectedProjectId('all')
    void persist((latest) => ({
      ...latest,
      projects: latest.projects.filter((item) => item.id !== projectId),
    }), 'Project deleted')
  }

  const reorderAgent = (sourceId: string, targetProjectId: string, targetAgentId?: string) => {
    void persist((current) => {
      const source = current.agents.find((agent) => agent.id === sourceId)
      if (!source) return current
      const otherAgents = current.agents.filter((agent) => agent.id !== sourceId)
      const targetAgents = otherAgents.filter((agent) => agent.projectId === targetProjectId).sort((a, b) => a.order - b.order)
      const insertionIndex = targetAgentId ? Math.max(0, targetAgents.findIndex((agent) => agent.id === targetAgentId)) : targetAgents.length
      targetAgents.splice(insertionIndex, 0, { ...source, projectId: targetProjectId })
      const orderById = new Map(targetAgents.map((agent, index) => [agent.id, index]))
      const moved = { ...source, projectId: targetProjectId, order: orderById.get(source.id) ?? 0 }
      const agents = otherAgents.map((agent) =>
        agent.projectId === targetProjectId ? { ...agent, order: orderById.get(agent.id) ?? agent.order } : agent,
      )
      agents.push(moved)
      return { ...current, agents }
    })
  }

  const handleImport = (item: DiscoveredItem) => {
    const projectId = selectedProjectId !== 'all' && state.projects.some((project) => project.id === selectedProjectId)
      ? selectedProjectId
      : state.projects[0].id
    const order = state.agents.filter((agent) => agent.projectId === projectId).length
    setDiscoveryOpen(false)
    setEditor({ type: 'agent', initial: importDraft(item, projectId, order), existing: false })
  }

  const editAgent = (agent: AgentConfig) => setEditor({ type: 'agent', initial: agent, existing: true })
  const breadcrumb = selectedProject ? selectedProject.name : 'All Projects'
  const displaySettings = appearancePreview ?? state.settings
  const appearanceStyle = {
    '--ui-scale': nativeZoomAvailable ? 1 : uiScale,
    '--ui-inverse-scale': nativeZoomAvailable ? 1 : 1 / uiScale,
  } as CSSProperties

  return (
    <div
      className={`app-shell ${state.settings.compactMode ? 'is-compact' : ''} ${nativeZoomAvailable ? 'uses-native-zoom' : 'uses-css-zoom'}`}
      data-theme={displaySettings.theme}
      style={appearanceStyle}
    >
      <Sidebar
        state={state}
        snapshot={hydrated}
        selectedProjectId={selectedProjectId}
        search={search}
        onSearch={setSearch}
        onSelectProject={setSelectedProjectId}
        onToggleProject={toggleProject}
        onAddProject={() => setEditor({ type: 'project' })}
        onEditProject={(project) => setEditor({ type: 'project', initial: project })}
        onAddAgent={(projectId) => setEditor({ type: 'agent', initial: { projectId }, existing: false })}
        onEditAgent={editAgent}
        onOpenAgent={(id) => void openAgent(id)}
        onReorderAgent={reorderAgent}
        onOpenSettings={openSettings}
      />

      <div className="main-column">
        <header className="topbar">
          <div className="breadcrumbs"><Command size={14} /><span>Mission Control</span><ChevronRight size={13} /><strong>{breadcrumb}</strong></div>
          <div className="topbar__status">
            <span className="top-stat"><i style={{ background: STATUS_META.running.color }} />{globalActive} active</span>
            <span className="top-stat"><i style={{ background: STATUS_META.waiting.color }} />{globalWaiting} waiting</span>
            {globalErrors > 0 && <span className="top-stat top-stat--error"><TriangleAlert size={13} />{globalErrors} error{globalErrors === 1 ? '' : 's'}</span>}
            <span className="top-separator" />
            <button className="topbar-button" onClick={() => void refresh()} title="Scan now"><RefreshCw size={15} className={refreshing ? 'is-spinning' : ''} /></button>
            <button className="discover-button" onClick={() => setDiscoveryOpen(true)}><Radar size={15} /><span>Discover</span><b>{hydrated.discovered.length}</b></button>
            <button
              className={`topbar-button update-status-button ${updateAttention ? 'has-update' : ''}`}
              title={updateAttention ? updateState.message : 'Application updates'}
              onClick={openSettings}
              aria-label="Open application updates"
            >
              {updateAttention ? <Download size={15} /> : <Bell size={15} />}
              {updateAttention && <i />}
            </button>
          </div>
        </header>

        <Dashboard
          state={state}
          snapshot={hydrated}
          selectedProjectId={selectedProjectId}
          search={search}
          onOpenAgent={(id) => void openAgent(id)}
          onCloseTerminal={(id) => void closeAgentTerminal(id)}
          onEditAgent={editAgent}
          onEditProject={(project) => setEditor({ type: 'project', initial: project })}
          onAddAgent={(projectId) => setEditor({ type: 'agent', initial: { projectId }, existing: false })}
          onRestoreProject={(projectId) => void restoreProject(projectId)}
        />

        <footer className="app-statusbar">
          <span
            className={`local-core-status local-core-status--${coreConnection.phase}`}
            title={coreConnection.message}
            role="status"
            aria-live="polite"
          >
            <i /> LOCAL CORE · {CORE_CONNECTION_LABELS[coreConnection.phase]}
          </span>
          <span><Server size={11} /> {hydrated.capabilities.platform.toUpperCase()}</span>
          <span><Cpu size={11} /> SCAN {state.settings.scanIntervalMs / 1000}s</span>
          <span><Type size={11} /> {displaySettings.fontSizePx}px</span>
          <button className={`app-version ${updateAttention ? 'has-update' : ''}`} onClick={openSettings}>v{appVersion}{updateAttention ? ' · UPDATE' : ''}</button>
        </footer>
      </div>

      <DiscoveryDrawer open={discoveryOpen} snapshot={hydrated} onClose={() => setDiscoveryOpen(false)} onRefresh={() => void refresh()} onImport={handleImport} />

      {editor?.type === 'agent' && (
        <AgentEditor
          key={`${editor.existing}-${editor.initial.id ?? 'new'}`}
          projects={[...state.projects].sort((a, b) => a.order - b.order)}
          initial={editor.initial}
          existing={editor.existing}
          onSave={(agent) => saveAgent(agent, editor.existing)}
          onDelete={editor.existing && editor.initial.id ? () => deleteAgent(editor.initial.id!) : undefined}
          onClose={() => setEditor(null)}
        />
      )}
      {editor?.type === 'project' && (
        <ProjectEditor
          key={editor.initial?.id ?? 'new-project'}
          initial={editor.initial}
          agentCount={editor.initial ? state.agents.filter((agent) => agent.projectId === editor.initial!.id).length : 0}
          onSave={(project) => saveProject(project, Boolean(editor.initial))}
          onDelete={editor.initial ? () => deleteProject(editor.initial!.id) : undefined}
          onClose={() => setEditor(null)}
        />
      )}
      {editor?.type === 'settings' && (
        <SettingsEditor
          settings={state.settings}
          availableTerminals={hydrated.capabilities.terminals}
          updateState={updateState}
          coreHealth={coreHealth}
          coreConnection={coreConnection}
          onPreview={setAppearancePreview}
          onSave={(settings: ConsoleSettings) => { setAppearancePreview(null); setEditor(null); void persist((current) => ({ ...current, settings }), 'Settings saved') }}
          onClose={() => { setAppearancePreview(null); setEditor(null) }}
          onCheckForUpdates={() => void checkForUpdates()}
          onDownloadUpdate={() => void downloadUpdate()}
          onInstallUpdate={() => void installUpdate()}
          onOpenReleasesPage={() => void api.openReleasesPage()}
        />
      )}

      {toast && (
        <div className={`toast toast--${toast.tone}`}>
          {toast.tone === 'success' ? <CheckCircle2 size={16} /> : toast.tone === 'error' ? <TriangleAlert size={16} /> : <Bell size={16} />}
          <span>{toast.message}</span>
          <button onClick={() => setToast(null)}><X size={14} /></button>
        </div>
      )}
    </div>
  )
}
