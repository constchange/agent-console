import { readFile, readdir } from 'node:fs/promises'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { DeleteConfirmation } from '../src/components/Editors'
import { I18nProvider } from '../src/lib/i18n'

describe('in-application delete confirmation', () => {
  it('renders an explicit safe choice without opening a browser dialog', () => {
    const markup = renderToStaticMarkup(
      <DeleteConfirmation
        subject="Delete Sales Assistant?"
        detail="The running process will not be stopped."
        confirmLabel="Delete Agent"
        onCancel={vi.fn()}
        onConfirm={vi.fn()}
      />,
    )

    expect(markup).toContain('role="alert"')
    expect(markup).toContain('Keep it')
    expect(markup).toContain('Delete Agent')
    expect(markup).toContain('autofocus=""')
  })

  it('keeps native JavaScript confirmation dialogs out of every renderer source file', async () => {
    const root = new URL('../src/', import.meta.url)
    const entries = await readdir(root, { recursive: true })
    const source = (await Promise.all(
      entries
        .filter((entry) => /\.[cm]?[jt]sx?$/.test(entry))
        .map((entry) => readFile(new URL(entry, root), 'utf8')),
    )).join('\n')
    expect(source).not.toContain('window.confirm')
    expect(source).not.toMatch(/\bconfirm\s*\(/)
  })

  it('renders the safe delete choice in Chinese without changing the supplied subject', () => {
    const markup = renderToStaticMarkup(
      <I18nProvider language="zh-CN">
        <DeleteConfirmation
          subject="删除 Sales Assistant？"
          detail="正在运行的进程不会停止。"
          confirmLabel="删除 Agent"
          busy
          onCancel={vi.fn()}
          onConfirm={vi.fn()}
        />
      </I18nProvider>,
    )

    expect(markup).toContain('删除 Sales Assistant？')
    expect(markup).toContain('保留')
    expect(markup).toContain('正在删除…')
    expect(markup).toContain('role="alert"')
  })
})
