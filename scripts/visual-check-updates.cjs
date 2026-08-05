const { app, BrowserWindow } = require('electron')
const { mkdir, writeFile } = require('node:fs/promises')
const path = require('node:path')
const { pathToFileURL } = require('node:url')

const projectRoot = path.resolve(__dirname, '..')
const screenshotPath = path.join(projectRoot, 'artifacts', 'update-center-4k-25px.png')
const resultPath = path.join(projectRoot, 'artifacts', 'update-center-results.json')

async function waitFor(selector, window) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const found = await window.webContents.executeJavaScript(`Boolean(document.querySelector(${JSON.stringify(selector)}))`)
    if (found) return
    await new Promise((resolve) => setTimeout(resolve, 80))
  }
  throw new Error(`Timed out waiting for ${selector}`)
}

app.whenReady().then(async () => {
  const window = new BrowserWindow({
    width: 3_840,
    height: 2_160,
    show: false,
    backgroundColor: '#f7f4ec',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
  })

  const pageUrl = new URL(pathToFileURL(path.join(projectRoot, 'dist', 'renderer', 'index.html')).href)
  pageUrl.searchParams.set('updatePreview', 'available')
  await window.loadURL(pageUrl.href)
  await waitFor('.sidebar__footer .icon-button', window)
  await window.webContents.executeJavaScript(`document.querySelector('.sidebar__footer .icon-button').click()`)
  await waitFor('.settings-section--updates', window)

  const result = await window.webContents.executeJavaScript(`(() => {
    const panel = document.querySelector('.settings-section--updates')
    const modal = document.querySelector('.modal')
    const modalRect = modal.getBoundingClientRect()
    return {
      heading: panel.querySelector('.update-panel__summary strong')?.textContent,
      downloadButton: [...panel.querySelectorAll('button')].some((button) => button.textContent.includes('Download update')),
      releaseNotes: panel.querySelector('.update-release-notes pre')?.textContent,
      viewport: [innerWidth, innerHeight],
      modalVisible: modalRect.left >= 0 && modalRect.top >= 0 && modalRect.right <= innerWidth && modalRect.bottom <= innerHeight,
      bodyScrolls: document.querySelector('.modal__body').scrollHeight >= document.querySelector('.modal__body').clientHeight,
    }
  })()`)

  if (result.heading !== 'Version 0.3.2 is available' || !result.downloadButton || !result.releaseNotes || !result.modalVisible) {
    throw new Error(`Update Center visual check failed: ${JSON.stringify(result)}`)
  }

  await mkdir(path.dirname(screenshotPath), { recursive: true })
  const image = await window.webContents.capturePage()
  await writeFile(screenshotPath, image.toPNG())
  await writeFile(resultPath, `${JSON.stringify({ ok: true, ...result, screenshot: screenshotPath }, null, 2)}\n`)
  process.stdout.write(`${JSON.stringify({ ok: true, ...result, screenshot: screenshotPath }, null, 2)}\n`)
  window.destroy()
  app.quit()
}).catch((error) => {
  console.error(error)
  app.exit(1)
})
