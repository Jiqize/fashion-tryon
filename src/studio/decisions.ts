import { RunnerError } from '../errors.js'
import type { Engine } from './engine.js'
import { groupStatus, type BatchState, type Group, type RegenTag, type Task } from './model.js'
import { publishGroup, writeOverview, type PublishResult } from './publish.js'
import { buildRegenPrompt, sanitizeRegenNote } from './regen-prompt.js'
import type { BatchStore } from './store.js'

export type DecisionOp =
  | { op: 'pass'; groupId: string }
  | { op: 'exclude'; taskId: string; excluded: boolean }
  | { op: 'choose'; taskId: string; versionId: string }
  | { op: 'regenerate'; taskId: string; tags: RegenTag[]; note?: string }
  | { op: 'withdraw'; groupId: string }

export type DecisionResult =
  | { ok: true; message: string; published?: PublishResult }
  | { ok: false; code: string; message: string }

export interface Decisions {
  apply(op: DecisionOp): Promise<DecisionResult>
  undo(): Promise<DecisionResult>
}

// 撤销栈条目：记下恢复所需的旧值
type UndoEntry =
  | { op: 'pass'; groupId: string }
  | { op: 'withdraw'; groupId: string }
  | { op: 'exclude'; taskId: string; previous: boolean }
  | { op: 'choose'; taskId: string; previous: string | undefined }
  | { op: 'regenerate' }

const UNDO_LIMIT = 50

class DecisionError extends Error {
  constructor(readonly code: string, message: string) {
    super(message)
  }
}

function invalid(message: string): DecisionError {
  return new DecisionError('VALIDATION_ERROR', message)
}

function findTask(state: BatchState, taskId: string): Task {
  const task = state.tasks.find((candidate) => candidate.id === taskId)
  if (task === undefined) throw new DecisionError('NOT_FOUND', `找不到这张图：${taskId}`)
  return task
}

function findGroup(state: BatchState, groupId: string): Group {
  const group = state.groups.find((candidate) => candidate.id === groupId)
  if (group === undefined) throw new DecisionError('NOT_FOUND', `找不到这套：${groupId}`)
  return group
}

/** 组内序号（从 1 开始），用于提示文案。 */
function positionOf(state: BatchState, task: Task): number {
  return state.tasks.filter((candidate) => candidate.groupId === task.groupId).indexOf(task) + 1
}

function labelOf(state: BatchState, task: Task): string {
  return `${findGroup(state, task.groupId).sku} · ${String(positionOf(state, task))}`
}

/** 已交付的套不能直接改判断，先撤回。 */
function assertNotDelivered(state: BatchState, task: Task): void {
  if (findGroup(state, task.groupId).delivered !== undefined) {
    throw invalid('这套已交付，先撤回再修改')
  }
}

/**
 * 重出用的基础 prompt：组的 basePrompt；fixedModel 模式用任务自己的首轮 prompt。
 * 取不到时退回该任务首轮版本记录的 prompt。
 */
function basePromptFor(state: BatchState, task: Task): string | undefined {
  const group = findGroup(state, task.groupId)
  const mode = group.mode ?? state.settings.mode
  const ownFirst = task.pending.find((job) => job.kind === 'first' && job.prompt !== undefined)?.prompt
    ?? task.versions.find((version) => version.regen === undefined)?.prompt
  if (mode === 'fixedModel') return ownFirst ?? group.basePrompt
  return group.basePrompt ?? ownFirst
}

function toResult(error: unknown): DecisionResult {
  if (error instanceof DecisionError) return { ok: false, code: error.code, message: error.message }
  if (error instanceof RunnerError) return { ok: false, code: error.code, message: error.message }
  return { ok: false, code: 'IO_ERROR', message: error instanceof Error ? error.message : String(error) }
}

export function createDecisions(store: BatchStore, engine: Engine): Decisions {
  const stack: UndoEntry[] = []
  // 判断操作串行执行：校验与写入之间不被另一个判断插入
  let tail: Promise<unknown> = Promise.resolve()

  function serial(operation: () => Promise<DecisionResult>): Promise<DecisionResult> {
    const result = tail.then(operation, operation).catch(toResult)
    tail = result
    return result
  }

  function remember(entry: UndoEntry): void {
    stack.push(entry)
    if (stack.length > UNDO_LIMIT) stack.shift()
  }

  /** 交付后重写总览；总览失败不影响已完成的交付。 */
  async function refreshOverview(): Promise<string> {
    try {
      await writeOverview(store)
      return ''
    } catch (error) {
      return `（总览未更新：${error instanceof Error ? error.message : String(error)}）`
    }
  }

  async function pass(groupId: string): Promise<DecisionResult> {
    const state = store.state()
    const group = findGroup(state, groupId)
    if (group.delivered !== undefined) throw invalid(`${group.sku} 已交付`)
    const tasks = state.tasks.filter((task) => task.groupId === groupId)
    const generating = '这套还在生成，完成后再判断'
    // 首轮还没出图的任务
    if (tasks.some((task) => task.versions.length === 0 && task.status !== 'failed')) throw invalid(generating)
    // 已有版本的任务仍挂着重出作业
    if (tasks.some((task) => task.versions.length > 0 && (task.pending.length > 0 || task.status === 'running'))) {
      throw invalid('还有重出中的图，完成后再交付')
    }
    if (tasks.some((task) => task.status === 'failed' && !task.excluded) || group.error !== undefined) {
      throw invalid('有生成失败的图，请重试或标记不交付')
    }
    if (groupStatus(state, groupId) !== 'review') throw invalid(generating)

    const published = await publishGroup(store, groupId)
    await store.update((draft) => {
      findGroup(draft, groupId).delivered = { at: new Date().toISOString(), files: published.outputs }
    })
    const note = await refreshOverview()
    return { ok: true, message: `${group.sku} 已交付 ${String(published.outputs.length)} 张${note}`, published }
  }

  async function withdraw(groupId: string): Promise<DecisionResult> {
    const group = findGroup(store.state(), groupId)
    if (group.delivered === undefined) throw invalid(`${group.sku} 还没有交付`)
    // 只改本批记录，不删除成图/ 中已写出的文件
    await store.update((draft) => {
      delete findGroup(draft, groupId).delivered
    })
    const note = await refreshOverview()
    return { ok: true, message: `${group.sku} 已撤回，成图/${group.sku}/ 中已写出的文件保留${note}` }
  }

  async function setExcluded(taskId: string, excluded: boolean): Promise<string> {
    const state = await store.update((draft) => {
      findTask(draft, taskId).excluded = excluded
    })
    const label = labelOf(state, findTask(state, taskId))
    return excluded ? `${label} 已标记不交付` : `${label} 已恢复交付`
  }

  async function setChosen(taskId: string, versionId: string | undefined): Promise<void> {
    await store.update((draft) => {
      const task = findTask(draft, taskId)
      if (versionId === undefined) delete task.chosenVersionId
      else task.chosenVersionId = versionId
    })
  }

  async function apply(op: DecisionOp): Promise<DecisionResult> {
    switch (op.op) {
      case 'pass': {
        const result = await pass(op.groupId)
        remember({ op: 'pass', groupId: op.groupId })
        return result
      }
      case 'withdraw': {
        const result = await withdraw(op.groupId)
        remember({ op: 'withdraw', groupId: op.groupId })
        return result
      }
      case 'exclude': {
        const task = findTask(store.state(), op.taskId)
        assertNotDelivered(store.state(), task)
        // 生成失败的图也可以标记不交付，这套其余的图照常通过
        if (task.status !== 'done' && task.status !== 'failed') throw invalid('只有已出图或生成失败的图可以标记不交付')
        const previous = task.excluded
        const message = await setExcluded(op.taskId, op.excluded)
        remember({ op: 'exclude', taskId: op.taskId, previous })
        return { ok: true, message }
      }
      case 'choose': {
        const state = store.state()
        const task = findTask(state, op.taskId)
        assertNotDelivered(state, task)
        if (!task.versions.some((version) => version.id === op.versionId)) {
          throw invalid('这个版本不属于这张图')
        }
        const previous = task.chosenVersionId
        await setChosen(op.taskId, op.versionId)
        remember({ op: 'choose', taskId: op.taskId, previous })
        return { ok: true, message: `${labelOf(state, task)} 已选择版本` }
      }
      case 'regenerate': {
        const note = sanitizeRegenNote(op.note)
        if (op.tags.length === 0 && note === undefined) throw invalid('选一个问题标签，或写一句原因')
        const state = store.state()
        const task = findTask(state, op.taskId)
        assertNotDelivered(state, task)
        if (task.chosenVersionId === undefined) throw invalid('这张还没有生成结果，无法重出')
        const base = basePromptFor(state, task)
        if (base === undefined) throw invalid('这套还没有提示词，稍后再试')
        await engine.enqueueRegen(op.taskId, {
          prompt: buildRegenPrompt(base, op.tags, note),
          regen: {
            tags: [...op.tags],
            ...(note === undefined ? {} : { note }),
            fromVersionId: task.chosenVersionId,
          },
        })
        // 重出表示这张仍要交付；引擎接受重出后才恢复交付，被拒时保持原判断
        if (task.excluded) {
          await store.update((draft) => {
            findTask(draft, op.taskId).excluded = false
          })
        }
        remember({ op: 'regenerate' })
        return { ok: true, message: `${labelOf(state, task)} 已加入重出` }
      }
    }
  }

  async function undo(): Promise<DecisionResult> {
    // 重出已提交生成（会计费），不可撤销：跳过它撤销前一个
    while (stack.at(-1)?.op === 'regenerate') stack.pop()
    const entry = stack.pop()
    if (entry === undefined) throw invalid('没有可撤销的操作')
    try {
      return await revert(entry)
    } catch (error) {
      // 撤销失败时把操作放回栈顶，下次撤销仍针对它，而不是悄悄跳到更早的操作
      stack.push(entry)
      throw error
    }
  }

  async function revert(entry: UndoEntry): Promise<DecisionResult> {
    switch (entry.op) {
      case 'pass':
        return withdraw(entry.groupId)
      case 'withdraw':
        return pass(entry.groupId)
      case 'exclude': {
        const task = findTask(store.state(), entry.taskId)
        assertNotDelivered(store.state(), task)
        const message = await setExcluded(entry.taskId, entry.previous)
        return { ok: true, message: `已撤销：${message}` }
      }
      case 'choose': {
        const state = store.state()
        const task = findTask(state, entry.taskId)
        assertNotDelivered(state, task)
        await setChosen(entry.taskId, entry.previous)
        return { ok: true, message: `已撤销：${labelOf(state, task)} 恢复之前的版本` }
      }
      case 'regenerate':
        throw invalid('没有可撤销的操作')
    }
  }

  return {
    apply: (op) => serial(() => apply(op)),
    undo: () => serial(undo),
  }
}
