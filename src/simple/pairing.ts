import path from 'node:path'

import { RunnerError } from '../errors.js'
import { KEEP_FRAME_SENTENCE, type PairingRule } from './collection.js'
import { buildSimplePrompt, referenceRole, type SwapMode } from './prompt.js'

// 搭配展开：按每款的搭配规则，把选中的衣服图和模特图展开成若干出图组合（lane）

export interface PairingInput {
  sku: string
  pairing: PairingRule
  /** 选中的衣服图，按页面顺序 */
  garments: string[]
  /** 选中的模特图，按页面顺序 */
  models: string[]
  /** 固定服装的参考图 */
  references: { file: string; role?: string }[]
  /** 固定模特 / 一对一下每件衣服实际用的参考图，缺省用衣服原图 */
  itemRefs: Record<string, string>
  swap: SwapMode
  keepFrame: boolean
  halfModels: string[]
  /** 人工改过的提示词 */
  prompt?: string
}

export interface PairingLane {
  item?: string
  references: { file: string; role?: string }[]
  models: string[]
  prompt: string
  promptEdited: boolean
  keepFrame: boolean
  extraPrompts: Record<string, string>
}

export interface PairingResult {
  lanes: PairingLane[]
  unpaired: string[]
}

/** 默认提示词；保持画幅时末尾另起一行加固定句子。 */
export function promptFor(references: { file: string }[], swap: SwapMode, keepFrame: boolean): string {
  const base = buildSimplePrompt(references.map((ref) => ref.file), swap)
  return keepFrame ? `${base}\n${KEEP_FRAME_SENTENCE}` : base
}

/** 每件衣服默认用的参考图：按文件名排序第一张由它裁出的裁图，没有则用原图。 */
export function defaultItemRef(garment: string, crops: string[], cropFrom: Record<string, string>): string {
  // crops 已按裁图顺序（拖过的按拖的顺序，否则按文件名）
  return crops.find((crop) => cropFrom[crop] === garment) ?? garment
}

function itemReference(file: string): { file: string; role?: string } {
  const role = referenceRole(path.basename(file))
  return role === undefined ? { file } : { file, role }
}

export function expandPairing(input: PairingInput): PairingResult {
  const { sku, pairing, garments, models } = input
  // 固定服装只看参考图（可以只有裁图）；另外两种按每件衣服展开，需要服装原图
  if (pairing !== 'fixedGarment' && garments.length === 0) throw new RunnerError('VALIDATION_ERROR', `${sku} 缺少服装图，不能出图`)
  if (pairing === 'fixedModel' && models.length !== 1) {
    throw new RunnerError('VALIDATION_ERROR', `${sku}：固定模特只能选 1 个模特`)
  }
  if (models.length === 0) throw new RunnerError('VALIDATION_ERROR', '没有勾选要出图的图')

  const pairs: { item?: string; references: { file: string; role?: string }[]; models: string[] }[] = []
  const unpaired: string[] = []
  if (pairing === 'fixedGarment') {
    if (input.references.length === 0) throw new RunnerError('VALIDATION_ERROR', `${sku} 缺少服装图，不能出图`)
    pairs.push({ references: input.references, models })
  } else if (pairing === 'fixedModel') {
    for (const item of garments) {
      pairs.push({ item, references: [itemReference(input.itemRefs[item] ?? item)], models: [models[0]!] })
    }
  } else {
    const count = Math.min(garments.length, models.length)
    for (let index = 0; index < count; index += 1) {
      const item = garments[index]!
      pairs.push({ item, references: [itemReference(input.itemRefs[item] ?? item)], models: [models[index]!] })
    }
    unpaired.push(...garments.slice(count), ...models.slice(count))
  }

  const lanes = pairs.map((pair): PairingLane => {
    const edited = input.prompt !== undefined
    let prompt = edited ? input.prompt! : promptFor(pair.references, input.swap, input.keepFrame)
    if (edited && input.keepFrame && !prompt.includes(KEEP_FRAME_SENTENCE)) prompt = `${prompt}\n${KEEP_FRAME_SENTENCE}`
    const extraPrompts: Record<string, string> = {}
    // 提示词里已有那句（开了保持画幅或人工写进去）就不再追加
    if (!prompt.includes(KEEP_FRAME_SENTENCE)) {
      for (const model of pair.models) {
        if (input.halfModels.includes(model)) extraPrompts[model] = KEEP_FRAME_SENTENCE
      }
    }
    return {
      ...(pair.item === undefined ? {} : { item: pair.item }),
      references: pair.references,
      models: pair.models,
      prompt,
      promptEdited: edited,
      keepFrame: input.keepFrame,
      extraPrompts,
    }
  })
  return { lanes, unpaired }
}
