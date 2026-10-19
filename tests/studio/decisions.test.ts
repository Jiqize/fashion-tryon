import { randomUUID } from 'node:crypto'
import { readdir } from 'node:fs/promises'
import path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { RunnerError } from '../../src/errors.js'
import { createDecisions } from '../../src/studio/decisions.js'
import type { Engine } from '../../src/studio/engine.js'
import { batchCounts, groupStatus, type Version } from '../../src/studio/model.js'
import { buildRegenPrompt, REGEN_TAG_LABELS } from '../../src/studio/regen-prompt.js'
import type { BatchStore } from '../../src/studio/store.js'
import { cleanupSourceTrees, makeReviewBatch } from './helpers.js'

const stores: BatchStore[] = []

afterEach(async () => {
  await Promise.all(stores.splice(0).map((store) => store.close()))
  await cleanupSourceTrees()
})

/** 只实现 enqueueRegen 的引擎替身：记录收到的重出请求，并像真引擎一样把作业挂到任务上。 */
function stubEngine(store: BatchStore): Engine & { regens: Array<{ taskId: string; prompt: string; regen: Version['regen'] }> } {
  const regens: Array<{ taskId: string; prompt: string; regen: Version['regen'] }> = []
  const unused = async (): Promise<never> => {
    throw new Error('not used')
  }
  return {
    regens,
    prepareAll: unused,
    start: unused,
    pause: unused,
    resume: () => undefined,
    setConcurrency: () => undefined,
    async enqueueRegen(taskId, job) {
      regens.push({ taskId, ...job })
      await store.update((draft) => {
        const task = draft.tasks.find((candidate) => candidate.id === taskId)!
        task.pending.push({
          jobId: randomUUID(),
          kind: 'regen',
          prompt: job.prompt,
          ...(job.regen === undefined ? {} : { regen: job.regen }),
        })
        task.status = 'queued'
      })
    },
    retryFailed: unused,
    idle: async () => undefined,
    on: () => () => undefined,
    stop: async () => undefined,
  }
}

async function setup(spec: Record<string, { garments: number; models: number }>) {
  const batch = await makeReviewBatch(spec)
  stores.push(batch.store)
  const engine = stubEngine(batch.store)
  const decisions = createDecisions(batch.store, engine)
  return { ...batch, engine, decisions }
}

describe('buildRegenPrompt', () => {
  it('appends fixed sentences in tag order and a sanitized note', () => {
    const prompt = buildRegenPrompt('BASE PROMPT', ['color', 'role_swap'], '领子\n要【立】起来')
    expect(prompt.startsWith('BASE PROMPT\n【重出修正】')).toBe(true)
    const color = '上一版服装颜色与图1不一致。颜色、明度与饱和度必须严格以图1为准，不受图2光线与环境色影响。'
    const roleSwap = '上一版把图1当成了人物底图。图2才是人物、姿势与场景的唯一来源；图1只提供服装。'
    expect(prompt.indexOf(color)).toBeGreaterThan(0)
    expect(prompt.indexOf(roleSwap)).toBeGreaterThan(prompt.indexOf(color))
    const note = prompt.slice(prompt.indexOf('【补充说明】') + '【补充说明】'.length)
    expect(note).toBe('领子要立起来')
  })

  it('truncates the note to 200 characters and has no sentence for other', () => {
    const prompt = buildRegenPrompt('B', ['other'], '长'.repeat(300))
    expect(prompt).toBe(`B\n【重出修正】\n【补充说明】${'长'.repeat(200)}`)
  })

  it('exposes fixed labels', () => {
    expect(REGEN_TAG_LABELS).toEqual({
      color: '颜色偏',
      extra_item: '多了配饰',
      missing_item: '少了单品',
      outside_changed: '下装被换',
      pose_changed: '姿势变了',
      person_changed: '人物变了',
      role_swap: '角色互换',
      other: '其他',
    })
  })
})

describe('decisions', () => {
  it('rejects regenerate without tags or note', async () => {
    const { store, decisions, engine } = await setup({ EK52338: { garments: 1, models: 2 } })
    const task = store.state().tasks[0]!
    const result = await decisions.apply({ op: 'regenerate', taskId: task.id, tags: [], note: '  ' })
    expect(result).toEqual({ ok: false, code: 'VALIDATION_ERROR', message: '选一个问题标签，或写一句原因' })
    expect(engine.regens).toHaveLength(0)
  })

  it('regenerates with the group base prompt and the chosen version as source', async () => {
    const { store, decisions, engine } = await setup({ EK52338: { garments: 1, models: 2 } })
    const task = store.state().tasks[0]!
    expect((await decisions.apply({ op: 'exclude', taskId: task.id, excluded: true })).ok).toBe(true)

    const result = await decisions.apply({ op: 'regenerate', taskId: task.id, tags: ['color'], note: '偏黄' })

    expect(result.ok).toBe(true)
    expect(engine.regens).toHaveLength(1)
    expect(engine.regens[0]!.prompt).toBe(buildRegenPrompt('BASE-EK52338', ['color'], '偏黄'))
    expect(engine.regens[0]!.regen).toEqual({ tags: ['color'], note: '偏黄', fromVersionId: task.chosenVersionId })
    expect(store.state().tasks[0]!.excluded).toBe(false)
  })

  it('refuses to pass a group that is still generating and writes nothing', async () => {
    const { root, store, decisions } = await setup({ EK52338: { garments: 1, models: 3 } })
    const group = store.state().groups[0]!
    await store.update((draft) => {
      const task = draft.tasks[2]!
      task.status = 'queued'
      task.versions = []
      delete task.chosenVersionId
      task.pending = [{ jobId: 'job-1', kind: 'first' }]
    })

    const result = await decisions.apply({ op: 'pass', groupId: group.id })

    expect(result).toEqual({ ok: false, code: 'VALIDATION_ERROR', message: '这套还在生成，完成后再判断' })
    expect(await readdir(root)).not.toContain('成图')
  })

  it('refuses to pass while a regeneration is pending', async () => {
    const { store, decisions } = await setup({ EK52338: { garments: 1, models: 2 } })
    const group = store.state().groups[0]!
    await decisions.apply({ op: 'regenerate', taskId: store.state().tasks[0]!.id, tags: ['pose_changed'] })

    const result = await decisions.apply({ op: 'pass', groupId: group.id })

    expect(result).toEqual({ ok: false, code: 'VALIDATION_ERROR', message: '还有重出中的图，完成后再交付' })
  })

  it('refuses to pass a group with failed tasks', async () => {
    const { store, decisions } = await setup({ EK52338: { garments: 1, models: 2 } })
    const group = store.state().groups[0]!
    await store.update((draft) => {
      const task = draft.tasks[1]!
      task.status = 'failed'
      task.versions = []
      delete task.chosenVersionId
      task.error = { code: 'PROVIDER_ERROR', message: 'boom' }
    })

    const result = await decisions.apply({ op: 'pass', groupId: group.id })

    expect(result).toEqual({ ok: false, code: 'VALIDATION_ERROR', message: '有生成失败的图，请重试或标记不交付' })
  })

  it('excludes failed tasks so the rest of the group can pass, and undo restores the failure', async () => {
    const { root, store, decisions } = await setup({ EK52338: { garments: 1, models: 3 } })
    const group = store.state().groups[0]!
    await store.update((draft) => {
      for (const task of draft.tasks.slice(1)) {
        task.status = 'failed'
        task.versions = []
        delete task.chosenVersionId
        task.error = { code: 'PROVIDER_ERROR', message: 'boom' }
      }
    })
    const [, second, third] = store.state().tasks
    expect(groupStatus(store.state(), group.id)).toBe('failed')

    // 只排除一张失败图：仍有未处理的失败
    expect((await decisions.apply({ op: 'exclude', taskId: second!.id, excluded: true })).ok).toBe(true)
    expect(groupStatus(store.state(), group.id)).toBe('failed')
    expect(batchCounts(store.state()).failed).toBe(1)
    expect(await decisions.apply({ op: 'pass', groupId: group.id }))
      .toEqual({ ok: false, code: 'VALIDATION_ERROR', message: '有生成失败的图，请重试或标记不交付' })

    // 失败图全部标记不交付：整套可以通过，只交付已出图的那张
    expect((await decisions.apply({ op: 'exclude', taskId: third!.id, excluded: true })).ok).toBe(true)
    expect(groupStatus(store.state(), group.id)).toBe('review')
    expect(batchCounts(store.state()).failed).toBe(0)
    expect(await decisions.apply({ op: 'pass', groupId: group.id })).toMatchObject({ ok: true, message: 'EK52338 已交付 1 张' })
    expect(await readdir(path.join(root, '成图', 'EK52338'))).toHaveLength(1)

    // 撤销交付，再撤销不交付：恢复为有失败、不能通过
    expect((await decisions.undo()).ok).toBe(true)
    expect((await decisions.undo()).ok).toBe(true)
    expect(store.state().tasks[2]!.excluded).toBe(false)
    expect(groupStatus(store.state(), group.id)).toBe('failed')
    expect(await decisions.apply({ op: 'pass', groupId: group.id }))
      .toEqual({ ok: false, code: 'VALIDATION_ERROR', message: '有生成失败的图，请重试或标记不交付' })
  })

  it('passes a group and undo withdraws it while keeping delivered files', async () => {
    const { root, store, decisions } = await setup({ EK52338: { garments: 1, models: 3 } })
    const group = store.state().groups[0]!

    const passed = await decisions.apply({ op: 'pass', groupId: group.id })
    expect(passed).toMatchObject({ ok: true, message: 'EK52338 已交付 3 张' })
    expect(groupStatus(store.state(), group.id)).toBe('delivered')

    const undone = await decisions.undo()
    expect(undone.ok).toBe(true)
    expect(groupStatus(store.state(), group.id)).toBe('review')
    expect(await readdir(path.join(root, '成图', 'EK52338'))).toHaveLength(3)
  })

  it('withdraws a delivered group with a fixed message', async () => {
    const { store, decisions } = await setup({ EK52338: { garments: 1, models: 2 } })
    const group = store.state().groups[0]!
    await decisions.apply({ op: 'pass', groupId: group.id })

    const result = await decisions.apply({ op: 'withdraw', groupId: group.id })

    expect(result).toEqual({ ok: true, message: 'EK52338 已撤回，成图/EK52338/ 中已写出的文件保留' })
    expect(store.state().groups[0]!.delivered).toBeUndefined()
  })

  it('skips a regenerate on top of the stack and undoes the previous operation', async () => {
    const { store, decisions } = await setup({ EK52338: { garments: 1, models: 2 } })
    const [first, second] = store.state().tasks
    await decisions.apply({ op: 'exclude', taskId: first!.id, excluded: true })
    await decisions.apply({ op: 'regenerate', taskId: second!.id, tags: ['color'] })

    const undone = await decisions.undo()

    expect(undone.ok).toBe(true)
    expect(store.state().tasks[0]!.excluded).toBe(false)
    // 重出作业不被撤销
    expect(store.state().tasks[1]!.pending).toHaveLength(1)
    expect(await decisions.undo()).toEqual({ ok: false, code: 'VALIDATION_ERROR', message: '没有可撤销的操作' })
  })

  it('keeps a task excluded when the engine refuses the regeneration', async () => {
    const { store, decisions, engine } = await setup({ EK52338: { garments: 1, models: 2 } })
    const task = store.state().tasks[0]!
    await decisions.apply({ op: 'exclude', taskId: task.id, excluded: true })
    engine.enqueueRegen = async () => {
      throw new RunnerError('VALIDATION_ERROR', '素材已变化，此任务不能重出')
    }

    const result = await decisions.apply({ op: 'regenerate', taskId: task.id, tags: ['color'] })

    expect(result).toEqual({ ok: false, code: 'VALIDATION_ERROR', message: '素材已变化，此任务不能重出' })
    expect(store.state().tasks[0]!.excluded).toBe(true)
  })

  it('keeps an operation on the undo stack when undoing it fails', async () => {
    const { store, decisions } = await setup({ EK52338: { garments: 1, models: 2 } })
    const group = store.state().groups[0]!
    const [first, second] = store.state().tasks
    await decisions.apply({ op: 'exclude', taskId: first!.id, excluded: true })
    await decisions.apply({ op: 'pass', groupId: group.id })
    await decisions.apply({ op: 'withdraw', groupId: group.id })
    await decisions.apply({ op: 'regenerate', taskId: second!.id, tags: ['color'] })

    // 撤销 withdraw = 重新交付，但重出未完成，失败
    const refused = await decisions.undo()
    expect(refused).toEqual({ ok: false, code: 'VALIDATION_ERROR', message: '还有重出中的图，完成后再交付' })

    // 重出完成后再撤销，仍然撤销的是 withdraw，而不是更早的操作
    await store.update((draft) => {
      const task = draft.tasks[1]!
      task.pending = []
      task.status = 'done'
    })
    const undone = await decisions.undo()
    expect(undone).toMatchObject({ ok: true, message: 'EK52338 已交付 1 张' })
    expect(store.state().tasks[0]!.excluded).toBe(true)
  })

  it('validates exclude and choose targets and undoes a choice', async () => {
    const { store, decisions } = await setup({ EK52338: { garments: 1, models: 2 } })
    const [first, second] = store.state().tasks
    const original = first!.chosenVersionId
    await store.update((draft) => {
      draft.tasks[0]!.versions.push({ ...draft.tasks[0]!.versions[0]!, id: 'v-extra' })
      draft.tasks[1]!.status = 'failed'
    })

    // 还在排队的任务不能标记不交付（失败的可以，见下方用例）
    await store.update((draft) => {
      draft.tasks[1]!.status = 'queued'
    })
    expect((await decisions.apply({ op: 'exclude', taskId: second!.id, excluded: true })).ok).toBe(false)
    expect((await decisions.apply({ op: 'choose', taskId: first!.id, versionId: second!.chosenVersionId! })).ok).toBe(false)
    expect((await decisions.apply({ op: 'choose', taskId: first!.id, versionId: 'v-extra' })).ok).toBe(true)
    expect(store.state().tasks[0]!.chosenVersionId).toBe('v-extra')

    await decisions.undo()
    expect(store.state().tasks[0]!.chosenVersionId).toBe(original)
  })
})
