import { compareCodePoints, roleOfSegment, scanInput, type ScannedFile } from '../studio/fs-scan.js'

// 精简流程的素材扫描：每款一组，组内是服装图和模特图
// 支持两种目录结构：
//   <根>/<款号>/服装/*、<根>/<款号>/模特/*     （按款分目录）
//   <根>/服装/<款号>/*、<根>/模特/<款号>/*     （按角色分目录）
// 两层都只认角色目录名（服装/衣服/单品… 与 模特/人物…），成图/ 由 scanInput 跳过

export interface SimpleGroup {
  sku: string
  garments: ScannedFile[]
  models: ScannedFile[]
}

/** 款号取目录名第一个 `_` 或空格之前的部分。 */
function skuOf(dirName: string): string {
  const trimmed = dirName.trim()
  const match = /[_ ]/.exec(trimmed)
  return match === null ? trimmed : trimmed.slice(0, match.index).trim()
}

export async function scanSimple(sourceRoot: string): Promise<SimpleGroup[]> {
  // 精简流程不用内容哈希，只读文件头
  const { files } = await scanInput(sourceRoot, { hashContent: false })
  const groups = new Map<string, SimpleGroup>()
  const groupFor = (dir: string): SimpleGroup => {
    let group = groups.get(dir)
    if (group === undefined) {
      group = { sku: skuOf(dir), garments: [], models: [] }
      groups.set(dir, group)
    }
    return group
  }

  for (const file of files) {
    const segments = file.relativePath.split('/')
    if (segments.length < 3) continue
    const [first, second] = [segments[0]!, segments[1]!]
    const roleFirst = roleOfSegment(first)
    const roleSecond = roleOfSegment(second)
    if (roleSecond !== null) {
      const group = groupFor(first)
      ;(roleSecond === 'garment' ? group.garments : group.models).push(file)
    } else if (roleFirst !== null) {
      const group = groupFor(second)
      ;(roleFirst === 'garment' ? group.garments : group.models).push(file)
    }
  }

  // 组内按文件名自然排序：0 (2) 排在 0 (10) 之前
  const natural = (left: ScannedFile, right: ScannedFile): number =>
    left.relativePath.localeCompare(right.relativePath, 'zh', { numeric: true }) ||
    compareCodePoints(left.relativePath, right.relativePath)
  return [...groups.entries()]
    .sort(([left], [right]) => compareCodePoints(left, right))
    .map(([, group]) => ({ ...group, garments: group.garments.sort(natural), models: group.models.sort(natural) }))
}
