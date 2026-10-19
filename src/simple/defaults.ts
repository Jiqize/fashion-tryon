import path from 'node:path'

import { listCrops } from './crop.js'
import type { SimpleGroup } from './layout.js'
import { buildSimplePrompt, referenceRole, type SwapMode } from './prompt.js'

// 一款的默认出图设置：start_run（runSimple 扫描分支）与页面新建出图共用，保证两边计划一致

export interface GroupDefaults {
  referenceSource: 'crops' | 'originals'
  /** 路径相对素材根目录，`/` 分隔；缺服装图或模特图时为空 */
  references: { file: string; role?: string }[]
  prompt: string
  note?: string
}

export async function defaultGroupSettings(
  root: string,
  group: SimpleGroup,
  maxReferences: number,
  swap: SwapMode,
): Promise<GroupDefaults> {
  // 裁图/<款号>/ 里有图就用裁图，否则用 服装/ 原图
  const crops = await listCrops(root, group.sku)
  const available = crops.length > 0
    ? crops.map((cropPath) => path.relative(root, cropPath).split(path.sep).join('/'))
    : group.garments.map((file) => file.relativePath)
  const files = available.slice(0, maxReferences)
  const result: GroupDefaults = {
    referenceSource: crops.length > 0 ? 'crops' : 'originals',
    references: [],
    prompt: buildSimplePrompt(files.map((file) => path.basename(file)), swap),
  }
  if (available.length === 0 || group.models.length === 0) {
    result.note = available.length === 0 ? '缺少服装图，跳过' : '缺少模特图，跳过'
    return result
  }
  if (available.length > maxReferences) {
    result.note = `${crops.length > 0 ? '裁图' : '服装图'} ${String(available.length)} 张，只用了前 ${String(maxReferences)} 张`
  }
  result.references = files.map((file) => {
    const role = referenceRole(path.basename(file))
    return { file, ...(role === undefined ? {} : { role }) }
  })
  return result
}
