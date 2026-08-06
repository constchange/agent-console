import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { _electron as electronLauncher } from 'playwright-core'

const projectRoot = path.resolve(import.meta.dirname, '..')
const userDataPath = await mkdtemp(path.join(os.tmpdir(), 'agent-console-project-edit-'))
const runtimePath = path.join(userDataPath, 'xdg-runtime')
const screenshotPath = path.join(projectRoot, 'artifacts', 'project-edit-v031.png')
const resultPath = path.join(projectRoot, 'artifacts', 'project-edit-v031-results.json')
const packagedExecutable = process.env.AGENT_CONSOLE_EXECUTABLE

let application
let coreIdentity = null

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds))

function checkpoint(message) {
  process.stdout.write(`[project-edit] ${new Date().toISOString()} ${message}\n`)
}

async function withTimeout(label, promise, timeoutMs) {
  let timer
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} exceeded ${timeoutMs} ms`)), timeoutMs)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

function processStartTime(rawStat) {
  const commandEnd = rawStat.lastIndexOf(')')
  if (commandEnd < 0) return null
  return rawStat.slice(commandEnd + 2).trim().split(/\s+/)[19] ?? null
}

async function processSnapshot(pid) {
  if (!Number.isInteger(pid) || pid <= 1) return null
  try {
    const [initialDirectory, initialRawStat] = await Promise.all([
      stat(`/proc/${pid}`),
      readFile(`/proc/${pid}/stat`, 'utf8'),
    ])
    const initialStartTime = processStartTime(initialRawStat)
    if (!initialStartTime) return null
    const [rawCommandLine, rawEnvironment, finalDirectory, finalRawStat] = await Promise.all([
      readFile(`/proc/${pid}/cmdline`, 'utf8'),
      readFile(`/proc/${pid}/environ`, 'utf8'),
      stat(`/proc/${pid}`),
      readFile(`/proc/${pid}/stat`, 'utf8'),
    ])
    const finalStartTime = processStartTime(finalRawStat)
    if (!finalStartTime || finalStartTime !== initialStartTime || finalDirectory.uid !== initialDirectory.uid) return null
    return {
      pid,
      uid: finalDirectory.uid,
      startTime: finalStartTime,
      commandLine: rawCommandLine.split('\u0000').filter(Boolean),
      environment: rawEnvironment.split('\u0000').filter(Boolean),
    }
  } catch {
    return null
  }
}

async function captureProcessIdentity(pid, requirements = {}) {
  const snapshot = await processSnapshot(pid)
  if (!snapshot) return null
  if (typeof process.getuid === 'function' && snapshot.uid !== process.getuid()) return null
  const requiredArguments = requirements.arguments ?? []
  const requiredEnvironment = requirements.environment ?? []
  if (!requiredArguments.every((argument) => snapshot.commandLine.includes(argument))) return null
  if (!requiredEnvironment.every((entry) => snapshot.environment.includes(entry))) return null
  return {
    pid: snapshot.pid,
    uid: snapshot.uid,
    startTime: snapshot.startTime,
    requiredArguments: [...requiredArguments],
    requiredEnvironment: [...requiredEnvironment],
  }
}

async function matchesProcessIdentity(identity) {
  if (!identity) return false
  const snapshot = await processSnapshot(identity.pid)
  return Boolean(snapshot)
    && snapshot.uid === identity.uid
    && snapshot.startTime === identity.startTime
    && identity.requiredArguments.every((argument) => snapshot.commandLine.includes(argument))
    && identity.requiredEnvironment.every((entry) => snapshot.environment.includes(entry))
}

async function signalProcess(identity, signal) {
  if (!await matchesProcessIdentity(identity)) return false
  try {
    process.kill(identity.pid, signal)
    return true
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ESRCH') return false
    throw error
  }
}

async function waitForProcessExit(identity, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (!await matchesProcessIdentity(identity)) return true
    await delay(100)
  }
  return !await matchesProcessIdentity(identity)
}

async function terminateProcess(identity, label, gracefulTimeoutMs, killTimeoutMs) {
  if (!identity || !await matchesProcessIdentity(identity)) return

  checkpoint(`terminating ${label} process ${identity.pid}`)
  if (!await signalProcess(identity, 'SIGTERM')) return
  if (await waitForProcessExit(identity, gracefulTimeoutMs)) return

  checkpoint(`force-killing ${label} process ${identity.pid}`)
  if (!await signalProcess(identity, 'SIGKILL')) return
  if (!await waitForProcessExit(identity, killTimeoutMs)) {
    throw new Error(`${label} process ${identity.pid} retained the same verified identity after SIGKILL`)
  }
}

async function closeApplication(target, label, timeoutMs, requireCleanClose = true) {
  if (!target) return
  let child
  try {
    child = target.process()
  } catch {
    return
  }
  const identity = await captureProcessIdentity(child?.pid, {
    arguments: [`--user-data-dir=${userDataPath}`],
  })
  try {
    await withTimeout(`closing ${label}`, target.close(), timeoutMs)
  } catch (error) {
    checkpoint(`${label} did not close cleanly: ${error instanceof Error ? error.message : String(error)}`)
    if (!identity) throw new Error(`${label} process identity could not be verified; refusing to signal it`, { cause: error })
    await terminateProcess(identity, label, 3_000, 2_000)
    if (requireCleanClose) throw error
  }
}

const coreArguments = ['--console-core', `--console-core-user-data=${userDataPath}`]
const coreRequirements = {
  arguments: coreArguments,
  environment: ['AGENT_CONSOLE_CORE_FALLBACK=1'],
}

async function captureCoreIdentity(pid) {
  return captureProcessIdentity(pid, coreRequirements)
}

async function coreIdentityFromLock() {
  const raw = await readFile(path.join(userDataPath, 'console-core.lock'), 'utf8').catch(() => '')
  if (!raw) return null
  try {
    const record = JSON.parse(raw)
    const identity = await captureCoreIdentity(Number(record.pid))
    if (!identity) return null
    if (typeof record.processStartTime === 'string' && record.processStartTime !== identity.startTime) return null
    return identity
  } catch {
    return null
  }
}

async function findProcessIdentities(requirements) {
  const entries = await readdir('/proc').catch(() => [])
  const identities = []
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue
    const identity = await captureProcessIdentity(Number(entry), requirements)
    if (identity) identities.push(identity)
  }
  return identities
}

async function launchApplication() {
  await mkdir(runtimePath, { recursive: true, mode: 0o700 })
  return electronLauncher.launch({
    executablePath: packagedExecutable ?? path.join(projectRoot, 'node_modules', '.bin', 'electron'),
    args: [
      ...(packagedExecutable ? [] : ['.']),
      '--no-sandbox',
      '--disable-gpu',
      `--user-data-dir=${userDataPath}`,
      ...(process.env.DISPLAY ? [] : ['--ozone-platform=headless']),
    ],
    cwd: projectRoot,
    env: {
      ...process.env,
      ...(packagedExecutable ? { APPIMAGE_EXTRACT_AND_RUN: '1' } : {}),
      AGENT_CONSOLE_FORCE_DETACHED_CORE: '1',
      XDG_CACHE_HOME: path.join(userDataPath, 'xdg-cache'),
      XDG_CONFIG_HOME: path.join(userDataPath, 'xdg-config'),
      XDG_DATA_HOME: path.join(userDataPath, 'xdg-data'),
      XDG_RUNTIME_DIR: runtimePath,
    },
    timeout: 30_000,
  })
}

function forwardApplicationOutput(target, label) {
  const child = target.process()
  child?.stdout?.on('data', (chunk) => process.stdout.write(`[${label}:stdout] ${String(chunk)}`))
  child?.stderr?.on('data', (chunk) => process.stderr.write(`[${label}:stderr] ${String(chunk)}`))
}

async function main() {
  checkpoint('launching first desktop')
  application = await launchApplication()
  forwardApplicationOutput(application, 'first-desktop')
  application.on('console', (message) => {
    process.stdout.write(`[electron:${message.type()}] ${message.text()}\n`)
  })

  const page = await withTimeout('waiting for the first desktop window', application.firstWindow(), 45_000)
  await page.setViewportSize({ width: 3_840, height: 2_160 })
  await page.waitForSelector('.tree-project__main')
  const firstCorePid = await page.evaluate(() => window.agentConsole.getCoreHealth().then((health) => health.pid))
  coreIdentity = await captureCoreIdentity(firstCorePid)
  if (!coreIdentity) throw new Error(`Core process ${firstCorePid} is not the isolated Core for this visual test`)

  let javascriptDialogCount = 0
  page.on('dialog', async (dialog) => {
    javascriptDialogCount += 1
    await dialog.dismiss()
  })

  const projectButton = (name) => page.locator('.tree-project__main').filter({ hasText: name }).first()

  const clickProject = async (name) => {
    const button = projectButton(name)
    if (await button.count() === 0) throw new Error(`Project button not found: ${name}`)
    await button.click()
    await delay(80)
  }

  const openProjectEditor = async () => {
    const button = page.locator('.dashboard-heading__actions button').filter({ hasText: 'Edit Project' }).first()
    if (await button.count() === 0) throw new Error('Dashboard Edit Project button not found')
    await button.click()
    await page.waitForSelector('.project-editor')
  }

  const closeEditor = async () => {
    await page.locator('.editor-actions button').filter({ hasText: /^Cancel$/ }).click()
    await page.locator('.modal').waitFor({ state: 'detached' })
  }

  const deleteFirstAgent = async (projectName, verifyCancel = false) => {
    await clickProject(projectName)
    const project = page.locator('.tree-project').filter({ has: projectButton(projectName) }).first()
    const editButton = project.locator('.tree-agent .tree-action').first()
    if (await editButton.count() === 0) throw new Error(`${projectName} Agent edit button was not found`)
    await editButton.click()
    await page.waitForSelector('.editor-form')

    const input = page.locator('.editor-form input[required]').first()
    const nameBeforeDelete = await input.inputValue()
    if (!nameBeforeDelete) throw new Error(`Agent editor did not open for ${projectName}`)

    if (verifyCancel) {
      await input.click()
      await page.keyboard.type(' Draft')
    }

    await page.getByRole('button', { name: 'Delete Agent', exact: true }).click()
    const confirmation = page.locator('.delete-confirmation')
    await confirmation.waitFor({ state: 'visible' })
    if (javascriptDialogCount !== 0) throw new Error('A native JavaScript confirmation dialog opened during Agent deletion')
    if (await confirmation.getByRole('button', { name: 'Keep it', exact: true }).count() !== 1) {
      throw new Error('The in-application delete confirmation is incomplete')
    }

    if (verifyCancel) {
      const draftName = `${nameBeforeDelete} Draft`
      const assertSingleModal = async () => {
        const counts = await page.evaluate(() => ({
          modals: document.querySelectorAll('.modal').length,
          backdrops: document.querySelectorAll('.modal-backdrop').length,
        }))
        if (counts.modals !== 1 || counts.backdrops !== 1) {
          throw new Error(`Delete confirmation created a nested modal: ${JSON.stringify(counts)}`)
        }
      }
      const assertCancelledCleanly = async (method) => {
        await confirmation.waitFor({ state: 'detached' })
        await page.waitForFunction(() => (
          document.activeElement instanceof HTMLButtonElement
          && document.activeElement.textContent?.includes('Delete Agent')
        ))
        if (await input.inputValue() !== draftName) throw new Error(`${method} cancellation lost the Agent draft`)
        await assertSingleModal()
        await page.getByRole('button', { name: 'Delete Agent', exact: true }).click()
        await confirmation.waitFor({ state: 'visible' })
        await assertSingleModal()
      }

      await assertSingleModal()
      await input.focus()
      await page.keyboard.press('Enter')
      await delay(60)
      if (!await confirmation.isVisible()) throw new Error('Enter submitted the form while deletion confirmation was open')

      await confirmation.getByRole('button', { name: 'Keep it', exact: true }).click()
      await assertCancelledCleanly('Keep')

      await page.keyboard.press('Escape')
      await assertCancelledCleanly('Escape')

      await page.mouse.click(4, 4)
      await assertCancelledCleanly('Backdrop')

      await page.getByRole('button', { name: 'Close dialog', exact: true }).click()
      await assertCancelledCleanly('Close button')
    }

    await confirmation.getByRole('button', { name: 'Delete Agent', exact: true }).click()
    await page.locator('.modal').waitFor({ state: 'detached' })
    await delay(120)
    if (await page.locator('.tree-agent').filter({ hasText: nameBeforeDelete }).count() !== 0) {
      throw new Error(`Agent ${nameBeforeDelete} was not removed cleanly`)
    }
  }

  await deleteFirstAgent('Product', true)
  await deleteFirstAgent('Sales')
  await deleteFirstAgent('Management')
  if (javascriptDialogCount !== 0) throw new Error(`Observed ${javascriptDialogCount} native JavaScript dialog(s)`)

  await page.locator('.tree-label button[title="New project"]').click()
  await page.waitForSelector('.project-editor')
  await page.locator('.project-editor input[required]').fill('Temporary Project')
  await page.getByRole('button', { name: 'Save Project', exact: true }).click()
  await page.locator('.modal').waitFor({ state: 'detached' })
  await openProjectEditor()
  await page.getByRole('button', { name: 'Delete Project', exact: true }).click()
  const projectConfirmation = page.locator('.delete-confirmation')
  await projectConfirmation.waitFor({ state: 'visible' })
  if (javascriptDialogCount !== 0) throw new Error('A native JavaScript dialog opened during Project deletion')
  if (await page.locator('.modal').count() !== 1 || await page.locator('.modal-backdrop').count() !== 1) {
    throw new Error('Project deletion created a nested modal')
  }
  await projectConfirmation.getByRole('button', { name: 'Keep it', exact: true }).click()
  await projectConfirmation.waitFor({ state: 'detached' })
  await page.waitForFunction(() => (
    document.activeElement instanceof HTMLButtonElement
    && document.activeElement.textContent?.includes('Delete Project')
  ))
  await page.getByRole('button', { name: 'Delete Project', exact: true }).click()
  await projectConfirmation.waitFor({ state: 'visible' })
  await projectConfirmation.getByRole('button', { name: 'Delete Project', exact: true }).click()
  await page.locator('.modal').waitFor({ state: 'detached' })
  if (await projectButton('Temporary Project').count() !== 0) throw new Error('Temporary Project was not deleted')

  for (const name of ['Product', 'Sales', 'Management', 'Product']) {
    await clickProject(name)
    await openProjectEditor()
    const input = page.locator('.project-editor input[required]')
    if (!await input.isEditable()) throw new Error(`Project editor is not editable for ${name}`)
    const original = await input.inputValue()
    await input.click()
    await page.keyboard.type(' QA')
    if (await input.inputValue() === original) throw new Error(`Project editor did not accept input for ${name}`)
    await closeEditor()
  }

  await page.evaluate(async () => {
    const bootstrap = await window.agentConsole.getBootstrap()
    await window.agentConsole.saveState({
      ...bootstrap.state,
      settings: { ...bootstrap.state.settings, scanIntervalMs: 1_000 },
    })
    window.__projectEditSnapshotCount = 0
    window.__stopProjectEditSnapshotCounter = window.agentConsole.onSnapshot(() => {
      window.__projectEditSnapshotCount += 1
    })
  })

  await clickProject('Product')
  await page.locator('.tree-project__row.is-selected .tree-action--project').click()
  await page.waitForSelector('.project-editor')

  const projectInput = page.locator('.project-editor input[required]')
  const initialInputLength = (await projectInput.inputValue()).length
  for (let attempt = 0; attempt < 12; attempt += 1) {
    await projectInput.click()
    await page.keyboard.type('x')
    await delay(850)
    const interaction = await projectInput.evaluate((input) => {
      const rect = input.getBoundingClientRect()
      const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2)
      return {
        length: input.value.length,
        active: document.activeElement === input,
        disabled: input.disabled,
        readOnly: input.readOnly,
        hitTag: hit?.tagName,
      }
    })
    if (
      interaction.length !== initialInputLength + attempt + 1
      || !interaction.active
      || interaction.disabled
      || interaction.readOnly
      || interaction.hitTag !== 'INPUT'
    ) {
      throw new Error(`Native Project editing failed on interaction ${attempt + 1}: ${JSON.stringify(interaction)}`)
    }
  }

  const snapshotCountDuringEditing = await page.evaluate(() => window.__projectEditSnapshotCount)
  if (snapshotCountDuringEditing < 5) {
    throw new Error(`Expected live scans during editing, received ${snapshotCountDuringEditing}`)
  }

  let expectedLengthAfterZoom = initialInputLength + 12
  for (const fontSize of [50, 5, 25]) {
    await page.evaluate((size) => window.agentConsole.setZoomFactor(size / 13), fontSize)
    await delay(180)
    await projectInput.click()
    await page.keyboard.type('z')
    expectedLengthAfterZoom += 1
    const zoomInteraction = await projectInput.evaluate((input) => ({
      length: input.value.length,
      active: document.activeElement === input,
    }))
    if (zoomInteraction.length !== expectedLengthAfterZoom || !zoomInteraction.active) {
      throw new Error(`Project editing failed after changing native zoom to ${fontSize}px: ${JSON.stringify(zoomInteraction)}`)
    }
  }
  await closeEditor()

  await clickProject('Product')
  const selectedEditControl = await page.locator('.tree-project__row.is-selected .tree-action--project').evaluate((button) => {
    const rect = button.getBoundingClientRect()
    return {
      opacity: getComputedStyle(button).opacity,
      visible: rect.width > 0 && rect.height > 0 && rect.right <= innerWidth && rect.bottom <= innerHeight,
      heading: document.querySelector('.dashboard-heading h1')?.textContent,
    }
  })
  if (selectedEditControl.opacity === '0' || !selectedEditControl.visible) {
    throw new Error(`Selected Project edit control is not visible: ${JSON.stringify(selectedEditControl)}`)
  }

  await openProjectEditor()
  await mkdir(path.dirname(screenshotPath), { recursive: true })
  await page.screenshot({ path: screenshotPath })
  const modalTitle = await page.locator('.modal__header h2').textContent()

  await projectInput.fill('Product QA')
  await page.getByRole('button', { name: 'Save Project', exact: true }).click()
  await page.locator('.modal').waitFor({ state: 'detached' })
  const savedHeading = await page.locator('.dashboard-heading h1').textContent()
  if (!savedHeading?.includes('Product QA')) throw new Error(`Saved Project name did not appear: ${savedHeading}`)

  await openProjectEditor()
  const persistedName = await projectInput.inputValue()
  if (persistedName !== 'Product QA') throw new Error(`Saved Project name was not persisted: ${persistedName}`)
  await projectInput.fill('Product')
  await page.getByRole('button', { name: 'Save Project', exact: true }).click()
  await page.locator('.modal').waitFor({ state: 'detached' })

  const queuedSaveBarrier = await page.evaluate(async () => {
    const bootstrap = await window.agentConsole.getBootstrap()
    const before = await window.agentConsole.stateBarrier()
    for (let index = 0; index < 20; index += 1) {
      void window.agentConsole.saveState({
        ...bootstrap.state,
        projects: bootstrap.state.projects.map((project, projectIndex) => (
          projectIndex === 0 ? { ...project, name: `Shutdown Flush ${index}` } : project
        )),
      }).catch(() => undefined)
    }
    const after = await window.agentConsole.stateBarrier()
    return { before, after }
  })
  if (queuedSaveBarrier.after - queuedSaveBarrier.before !== 20) {
    throw new Error(`State-save IPC barrier observed an unexpected sequence: ${JSON.stringify(queuedSaveBarrier)}`)
  }
  checkpoint(`state-save barrier accepted ${queuedSaveBarrier.after - queuedSaveBarrier.before} queued saves`)
  checkpoint('closing first desktop after 20 queued saves')
  const firstApplication = application
  try {
    await closeApplication(firstApplication, 'the first desktop', 40_000)
  } finally {
    if (application === firstApplication) application = undefined
  }
  checkpoint('first desktop closed; launching replacement desktop')
  application = await launchApplication()
  forwardApplicationOutput(application, 'replacement-desktop')
  application.on('console', (message) => {
    process.stdout.write(`[electron:${message.type()}] ${message.text()}\n`)
  })
  const reopenedPage = await withTimeout('waiting for the replacement desktop window', application.firstWindow(), 45_000)
  await reopenedPage.waitForSelector('.tree-project__main')
  const reopenedCorePid = await reopenedPage.evaluate(() => window.agentConsole.getCoreHealth().then((health) => health.pid))
  coreIdentity = await captureCoreIdentity(reopenedCorePid)
  if (!coreIdentity) throw new Error(`Core process ${reopenedCorePid} is not the isolated Core for this visual test`)
  const flushedOnQuit = await reopenedPage.locator('.tree-project__main').filter({ hasText: 'Shutdown Flush 19' }).count() === 1
  if (!flushedOnQuit) throw new Error('Queued state changes were lost during application shutdown')
  await reopenedPage.evaluate(async () => {
    const bootstrap = await window.agentConsole.getBootstrap()
    await window.agentConsole.saveState({
      ...bootstrap.state,
      projects: bootstrap.state.projects.map((project, projectIndex) => (
        projectIndex === 0 ? { ...project, name: 'Product' } : project
      )),
    })
  })

  const result = {
    ok: true,
    viewport: '3840x2160',
    fontSize: await reopenedPage.locator('.app-statusbar span').nth(3).textContent(),
    repeatedEdits: 4,
    agentsDeletedBeforeEditing: 3,
    emptyProjectsDeletedBeforeEditing: 1,
    customDeleteConfirmation: true,
    deleteConfirmationDismissals: ['Keep', 'Escape', 'Backdrop', 'Close button'],
    focusRestoredAfterDeleteCancellation: true,
    nativeJavascriptDialogs: javascriptDialogCount,
    nativeInteractionsAcrossLiveScans: 12,
    snapshotsDuringEditing: snapshotCountDuringEditing,
    nativeZoomTransitions: ['50px', '5px', '25px'],
    saveAndReopen: persistedName === 'Product QA',
    queuedSavesFlushedOnQuit: flushedOnQuit,
    selectedEditControl,
    modalTitle,
    screenshot: screenshotPath,
  }
  await writeFile(resultPath, `${JSON.stringify(result, null, 2)}\n`)
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
}

try {
  await main()
} finally {
  checkpoint('cleaning up visual regression processes')
  const finalApplication = application
  application = undefined
  await closeApplication(finalApplication, 'the final desktop', 40_000, false)
  const lockedCoreIdentity = await coreIdentityFromLock()
  const matchingCoreProcesses = await findProcessIdentities({ arguments: coreArguments })
  const isolatedCoreProcesses = []
  for (const identity of matchingCoreProcesses) {
    const isolated = await captureCoreIdentity(identity.pid)
    if (!isolated || isolated.startTime !== identity.startTime || isolated.uid !== identity.uid) {
      throw new Error(
        `Core process ${identity.pid} uses this test's private user-data path but is not the forced detached test service; refusing to signal it`,
      )
    }
    isolatedCoreProcesses.push(isolated)
  }
  for (const identity of [lockedCoreIdentity, coreIdentity, ...isolatedCoreProcesses]) {
    if (!identity) continue
    await terminateProcess(identity, 'the isolated Core', 10_000, 2_000)
  }
  const remainingCoreProcesses = await findProcessIdentities({ arguments: coreArguments })
  if (remainingCoreProcesses.length > 0) {
    throw new Error(`Verified test Core processes are still present: ${remainingCoreProcesses.map(({ pid }) => pid).join(', ')}`)
  }
  await rm(userDataPath, { recursive: true, force: true })
}
