import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
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
let corePid = null

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds))

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
      XDG_CACHE_HOME: path.join(userDataPath, 'xdg-cache'),
      XDG_CONFIG_HOME: path.join(userDataPath, 'xdg-config'),
      XDG_RUNTIME_DIR: runtimePath,
    },
    timeout: 30_000,
  })
}

async function main() {
  application = await launchApplication()

  const page = await application.firstWindow()
  await page.setViewportSize({ width: 3_840, height: 2_160 })
  await page.waitForSelector('.tree-project__main')
  corePid = await page.evaluate(() => window.agentConsole.getCoreHealth().then((health) => health.pid))

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

  await page.evaluate(async () => {
    const bootstrap = await window.agentConsole.getBootstrap()
    for (let index = 0; index < 20; index += 1) {
      void window.agentConsole.saveState({
        ...bootstrap.state,
        projects: bootstrap.state.projects.map((project, projectIndex) => (
          projectIndex === 0 ? { ...project, name: `Shutdown Flush ${index}` } : project
        )),
      })
    }
  })
  await application.close()
  application = await launchApplication()
  const reopenedPage = await application.firstWindow()
  await reopenedPage.waitForSelector('.tree-project__main')
  corePid = await reopenedPage.evaluate(() => window.agentConsole.getCoreHealth().then((health) => health.pid))
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
  await application?.close().catch(() => undefined)
  if (!corePid) {
    const lock = await readFile(path.join(userDataPath, 'console-core.lock'), 'utf8').catch(() => '')
    try { corePid = Number(JSON.parse(lock).pid) || null } catch { /* incomplete lock */ }
  }
  if (corePid) {
    try { process.kill(corePid, 'SIGTERM') } catch { /* already stopped */ }
    const deadline = Date.now() + 10_000
    let alive = true
    while (Date.now() < deadline) {
      try {
        process.kill(corePid, 0)
        await delay(100)
      } catch {
        alive = false
        break
      }
    }
    if (alive) {
      try { process.kill(corePid, 'SIGKILL') } catch { /* already stopped */ }
    }
  }
  await rm(userDataPath, { recursive: true, force: true })
}
