const { mkdir, writeFile } = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const { app, BrowserWindow } = require('electron')

app.commandLine.appendSwitch('disable-gpu')
app.commandLine.appendSwitch('force-device-scale-factor', '1')

const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds))

async function run() {
  await app.whenReady()
  const window = new BrowserWindow({
    width: 3840,
    height: 2160,
    show: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })
  await window.loadFile(path.resolve(__dirname, '../dist/renderer/index.html'))
  await wait(500)
  await window.webContents.executeJavaScript(`(() => {
    const project = document.querySelector('.tree-project__main')
    if (!project) throw new Error('Preview project was not rendered')
    project.click()
  })()`)
  await wait(350)

  const metrics = await window.webContents.executeJavaScript(`(() => {
    const grid = document.querySelector('.agent-grid')
    const cards = [...document.querySelectorAll('.agent-card--codex')]
    if (!grid || cards.length !== 4) throw new Error('Expected four Codex preview cards')
    const columns = getComputedStyle(grid).gridTemplateColumns.split(' ').filter(Boolean).length
    const dimensions = cards.map((card) => {
      const bounds = card.getBoundingClientRect()
      return { width: Math.round(bounds.width), height: Math.round(bounds.height) }
    })
    const projectRow = document.querySelector('.tree-project__row')
    const agentRow = document.querySelector('.tree-agent')
    const projectLabel = document.querySelector('.tree-project__main span:last-child')
    const agentLabel = document.querySelector('.tree-agent > button:not(.tree-action)')
    const notePlacementValid = cards.every((card) => {
      const summaries = card.querySelector('.codex-card__summaries')?.getBoundingClientRect()
      const note = card.querySelector('.codex-card__note')?.getBoundingClientRect()
      const status = card.querySelector('.codex-card__status')?.getBoundingClientRect()
      return summaries && note && status && summaries.bottom <= note.top + 1 && note.bottom <= status.top + 1
    })
    const goalColorsValid = cards.every((card) => {
      const goal = card.querySelector('.agent-title-goal')
      if (!goal) return true
      const projectName = card.querySelector('.agent-project-name')
      return projectName && getComputedStyle(goal).color === getComputedStyle(projectName).color
    })
    return {
      columns,
      cards: cards.length,
      dimensions,
      summaries: cards.map((card) => card.querySelectorAll('.codex-card__summary').length),
      noteSections: cards.map((card) => card.querySelectorAll('.codex-card__note').length),
      goalLabels: cards.filter((card) => card.querySelector('.agent-title-goal')).length,
      notePlacementValid,
      goalColorsValid,
      sidebar: {
        projectHeight: Math.round(Number.parseFloat(projectRow ? getComputedStyle(projectRow).height : '0')),
        agentHeight: Math.round(Number.parseFloat(agentRow ? getComputedStyle(agentRow).height : '0')),
        projectLineHeight: Number.parseFloat(projectLabel ? getComputedStyle(projectLabel).lineHeight : '0'),
        projectFontSize: Number.parseFloat(projectLabel ? getComputedStyle(projectLabel).fontSize : '0'),
        agentLineHeight: Number.parseFloat(agentLabel ? getComputedStyle(agentLabel).lineHeight : '0'),
        agentFontSize: Number.parseFloat(agentLabel ? getComputedStyle(agentLabel).fontSize : '0'),
      },
      visibleFocusButtons: cards.filter((card) => {
        const button = card.querySelector('.codex-card__actions .action-button--primary')
        if (!button) return false
        const style = getComputedStyle(button)
        const bounds = button.getBoundingClientRect()
        return bounds.width > 0 && bounds.height > 0 && style.visibility !== 'hidden' && style.color !== style.backgroundColor
      }).length,
      overflowingCards: cards.filter((card) => card.scrollHeight > card.clientHeight + 1).length,
    }
  })()`)
  const sidebarLineHeightValid = Math.abs(metrics.sidebar.projectLineHeight / metrics.sidebar.projectFontSize - 1.5) < 0.01
    && Math.abs(metrics.sidebar.agentLineHeight / metrics.sidebar.agentFontSize - 1.5) < 0.01
  if (
    metrics.columns !== 4
    || metrics.visibleFocusButtons !== 4
    || metrics.summaries.some((count) => count !== 3)
    || metrics.noteSections.some((count) => count !== 1)
    || metrics.goalLabels !== 2
    || !metrics.notePlacementValid
    || !metrics.goalColorsValid
    || metrics.sidebar.projectHeight !== 28
    || metrics.sidebar.agentHeight !== 24
    || !sidebarLineHeightValid
    || metrics.overflowingCards
  ) {
    throw new Error(`Agent card layout regression: ${JSON.stringify(metrics)}`)
  }

  await window.webContents.executeJavaScript(`document.querySelector('.discover-button').click()`)
  await wait(180)
  const discoveryMetrics = await window.webContents.executeJavaScript(`(() => {
    const drawer = document.querySelector('.discovery-drawer.is-open')
    const focusButtons = [...document.querySelectorAll('.discovery-item > footer .text-button')]
    return {
      open: Boolean(drawer),
      items: document.querySelectorAll('.discovery-item').length,
      focusButtons: focusButtons.filter((button) => button.textContent.trim() === 'Focus').length,
      previewPanels: document.querySelectorAll('.process-preview').length,
      previewImages: document.querySelectorAll('.discovery-drawer img').length,
    }
  })()`)
  if (!discoveryMetrics.open || discoveryMetrics.items !== 1 || discoveryMetrics.focusButtons !== 1 || discoveryMetrics.previewPanels || discoveryMetrics.previewImages) {
    throw new Error(`Discovery focus layout regression: ${JSON.stringify(discoveryMetrics)}`)
  }
  await window.webContents.executeJavaScript(`document.querySelector('.discovery-item > footer .text-button').click()`)
  await wait(100)
  const discoveryFocusToast = await window.webContents.executeJavaScript(`document.querySelector('.toast')?.textContent.trim() ?? ''`)
  if (!discoveryFocusToast.includes('Terminal focused')) throw new Error(`Discovery Focus was not wired: ${discoveryFocusToast}`)
  await window.webContents.executeJavaScript(`document.querySelector('.drawer-header .icon-button:last-child').click()`)
  await wait(100)

  window.setSize(2400, 1600)
  await wait(180)
  const narrowColumns = await window.webContents.executeJavaScript(`getComputedStyle(document.querySelector('.agent-grid')).gridTemplateColumns.split(' ').filter(Boolean).length`)
  if (narrowColumns < 1 || narrowColumns >= metrics.columns) {
    throw new Error(`Agent card grid did not reflow at a narrower width: ${narrowColumns}`)
  }
  window.setSize(3840, 2160)
  await wait(180)
  const restoredColumns = await window.webContents.executeJavaScript(`getComputedStyle(document.querySelector('.agent-grid')).gridTemplateColumns.split(' ').filter(Boolean).length`)
  if (restoredColumns !== 4) throw new Error(`Agent card grid did not return to four columns: ${restoredColumns}`)

  await window.webContents.executeJavaScript(`document.querySelector('.codex-card__delete').click()`)
  await wait(100)
  const deleteConfirmation = await window.webContents.executeJavaScript(`Boolean(document.querySelector('.agent-delete-dialog .delete-confirmation'))`)
  if (!deleteConfirmation) throw new Error('The Codex card delete control did not open its confirmation dialog')
  await window.webContents.executeJavaScript(`(() => {
    const keep = [...document.querySelectorAll('button')].find((item) => item.textContent.trim() === 'Keep it')
    if (!keep) throw new Error('Delete confirmation cancel control was not rendered')
    keep.click()
  })()`)
  await wait(100)

  const outputDirectory = path.join(os.tmpdir(), 'agent-console-visual-check')
  await mkdir(outputDirectory, { recursive: true })
  const screenshots = []
  const themeMetrics = []
  await wait(2_800)
  for (const [theme, label] of [['vscode-dark', 'VS Code Dark'], ['vscode-light', 'VS Code Light'], ['monochrome', 'Pure Monochrome']]) {
    await window.webContents.executeJavaScript(`document.querySelector('.sidebar__footer .icon-button').click()`)
    await wait(120)
    await window.webContents.executeJavaScript(`(() => {
      const card = [...document.querySelectorAll('.theme-card')].find((item) => item.textContent.includes(${JSON.stringify(label)}))
      if (!card) throw new Error('Theme card was not rendered')
      card.click()
    })()`)
    await wait(120)
    await window.webContents.executeJavaScript(`(() => {
      const save = [...document.querySelectorAll('button')].find((item) => item.textContent.trim() === 'Save Settings')
      if (!save) throw new Error('Save Settings was not rendered')
      save.click()
    })()`)
    await wait(250)
    themeMetrics.push(await window.webContents.executeJavaScript(`(() => {
      const shell = document.querySelector('.app-shell')
      const style = getComputedStyle(shell)
      const sidebar = document.querySelector('.sidebar')
      const card = document.querySelector('.agent-card')
      return {
        theme: shell.dataset.theme,
        background: style.getPropertyValue('--theme-bg').trim(),
        shellBackground: style.background,
        sidebar: getComputedStyle(sidebar).background,
        card: getComputedStyle(card).background,
      }
    })()`))
    const target = path.join(outputDirectory, `${theme}.png`)
    await writeFile(target, (await window.capturePage()).toPNG())
    screenshots.push(target)
  }
  process.stdout.write(`${JSON.stringify({ ok: true, metrics: { ...metrics, narrowColumns, restoredColumns, discoveryMetrics }, themeMetrics, screenshots }, null, 2)}\n`)
  window.destroy()
  app.quit()
}

run().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`)
  app.exit(1)
})
