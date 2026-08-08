import { appendFile, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { CodexSessionInspector } from '../core/services/codex-session-inspector'

const temporaryDirectories: string[] = []

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agent-console-codex-session-'))
  temporaryDirectories.push(root)
  const procRoot = path.join(root, 'proc')
  const sessionRoot = path.join(root, 'sessions')
  const goalDatabasePath = path.join(root, 'goals_1.sqlite')
  const descriptors = path.join(procRoot, '812', 'fd')
  await mkdir(descriptors, { recursive: true })
  await mkdir(sessionRoot, { recursive: true })
  return { procRoot, sessionRoot, descriptors, goalDatabasePath }
}

function line(type: string, payload: Record<string, unknown>, timestamp = '2026-08-08T10:00:00.000Z') {
  return JSON.stringify({ timestamp, type, payload })
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

describe('Codex session inspection', () => {
  it('reads the exact session held by a Codex process and exposes only the requested 50-character summaries', async () => {
    const { procRoot, sessionRoot, descriptors, goalDatabasePath } = await fixture()
    const sessionPath = path.join(sessionRoot, 'rollout-session.jsonl')
    const threadId = '019fe14c-e23f-7000-8000-000000000001'
    const firstPrompt = '第一条命令用于检查整个项目结构以及所有关键模块之间的关系并列出需要优先处理的问题和验证步骤'
    const latestPrompt = '最近一条命令要求完成桌面界面的修改构建安装包并确保每一个自动化测试都能够稳定通过'
    const completed = '任务已经完成，所有界面修改、进程扫描限制、窗口定位与安装包构建验证均已顺利通过，可以安装使用。'
    await writeFile(sessionPath, [
      line('session_meta', { id: threadId, timestamp: '2026-08-08T09:15:00.000Z', cwd: '/workspace/project' }),
      line('event_msg', { type: 'task_started' }),
      line('response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', input_text: firstPrompt }] }),
      line('response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', input_text: '<environment_context><cwd>/tmp</cwd></environment_context>' }] }),
      line('response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', input_text: latestPrompt }] }),
      line('event_msg', { type: 'task_complete', last_agent_message: completed }),
    ].join('\n'))
    await symlink(sessionPath, path.join(descriptors, '17'))
    const goals = new DatabaseSync(goalDatabasePath)
    goals.exec('CREATE TABLE thread_goals (thread_id TEXT PRIMARY KEY, objective TEXT NOT NULL)')
    goals.prepare('INSERT INTO thread_goals (thread_id, objective) VALUES (?, ?)')
      .run(threadId, '完成真实 /goal 目标并通过全部验证')
    goals.close()

    const inspector = new CodexSessionInspector({ procRoot, sessionRoots: [sessionRoot], goalDatabasePath })
    await expect(inspector.inspect(812)).resolves.toEqual({
      createdAt: '2026-08-08T09:15:00.000Z',
      firstPrompt: Array.from(firstPrompt).slice(0, 50).join(''),
      latestPrompt: Array.from(latestPrompt).slice(0, 50).join(''),
      lastCompletedResponse: Array.from(completed).slice(-50).join(''),
      goal: '完成真实 /goal 目标并通过全部验证',
    })
    await expect(inspector.inspectRuntime(812)).resolves.toMatchObject({ taskActive: false })

    const appendedPrompt = '追加后的最新命令需要立即反映在下一次实时扫描中'
    await appendFile(sessionPath, `\n${line('event_msg', { type: 'task_started' })}\n${line('response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', input_text: appendedPrompt }] })}`)
    await expect(inspector.inspect(812)).resolves.toMatchObject({
      firstPrompt: Array.from(firstPrompt).slice(0, 50).join(''),
      latestPrompt: appendedPrompt,
      lastCompletedResponse: Array.from(completed).slice(-50).join(''),
    })
    await expect(inspector.inspectRuntime(812)).resolves.toMatchObject({ taskActive: true })

    const appendedResponse = '追加任务已经完成并通过验证'
    await appendFile(sessionPath, `\n${line('event_msg', { type: 'task_complete', last_agent_message: appendedResponse })}`)
    await expect(inspector.inspectRuntime(812)).resolves.toEqual({
      summary: {
        createdAt: '2026-08-08T09:15:00.000Z',
        firstPrompt: Array.from(firstPrompt).slice(0, 50).join(''),
        latestPrompt: appendedPrompt,
        lastCompletedResponse: appendedResponse,
        goal: '完成真实 /goal 目标并通过全部验证',
      },
      threadId,
      taskActive: false,
    })

    const changedGoals = new DatabaseSync(goalDatabasePath)
    changedGoals.prepare('UPDATE thread_goals SET objective = ? WHERE thread_id = ?')
      .run('无需修改 session 文件也能刷新目标', threadId)
    changedGoals.close()
    await expect(inspector.inspect(812)).resolves.toMatchObject({ goal: '无需修改 session 文件也能刷新目标' })
  })

  it('treats an aborted Codex turn as inactive', async () => {
    const { procRoot, sessionRoot, descriptors } = await fixture()
    const sessionPath = path.join(sessionRoot, 'rollout-aborted.jsonl')
    await writeFile(sessionPath, [
      line('event_msg', { type: 'task_started' }),
      line('event_msg', { type: 'turn_aborted' }),
    ].join('\n'))
    await symlink(sessionPath, path.join(descriptors, '19'))

    const inspector = new CodexSessionInspector({ procRoot, sessionRoots: [sessionRoot] })
    await expect(inspector.inspectRuntime(812)).resolves.toMatchObject({ taskActive: false })
  })

  it('does not inspect an arbitrary JSONL file outside approved Codex session roots', async () => {
    const { procRoot, sessionRoot, descriptors } = await fixture()
    const outside = path.join(path.dirname(sessionRoot), 'unrelated.jsonl')
    await writeFile(outside, line('response_item', {
      type: 'message', role: 'user', content: [{ type: 'input_text', input_text: 'secret' }],
    }))
    await symlink(outside, path.join(descriptors, '18'))

    const inspector = new CodexSessionInspector({ procRoot, sessionRoots: [sessionRoot] })
    await expect(inspector.inspect(812)).resolves.toBeNull()
  })
})
