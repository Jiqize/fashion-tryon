import { regenTags, type RegenTag } from './model.js'

/** 问题标签的界面文案（固定）。 */
export const REGEN_TAG_LABELS: Record<RegenTag, string> = {
  color: '颜色偏',
  extra_item: '多了配饰',
  missing_item: '少了单品',
  outside_changed: '下装被换',
  pose_changed: '姿势变了',
  person_changed: '人物变了',
  role_swap: '角色互换',
  other: '其他',
}

// 每个标签对应的固定修正句；other 没有固定句，只靠补充说明
const REGEN_TAG_SENTENCES: Record<RegenTag, string> = {
  color: '上一版服装颜色与图1不一致。颜色、明度与饱和度必须严格以图1为准，不受图2光线与环境色影响。',
  extra_item: '上一版出现了图1没有的配饰或单品。不得新增任何图1未列出的物品。',
  missing_item: '上一版漏掉了图1中的部分单品。图1列出的每一件目标服装都必须完整呈现，包括层次与长度。',
  outside_changed: '上一版改动了换装范围以外的衣物。范围以外的下装、鞋履与配饰必须与图2完全一致。',
  pose_changed: '姿势、手部动作、身体朝向与取景必须与图2完全一致。',
  person_changed: '人物的脸、发型、肤色与身材必须与图2完全一致。',
  role_swap: '上一版把图1当成了人物底图。图2才是人物、姿势与场景的唯一来源；图1只提供服装。',
  other: '',
}

const NOTE_MAX_CHARS = 200

/** 清理补充说明：去掉【】与换行，截断到 200 字；清理后为空返回 undefined。 */
export function sanitizeRegenNote(note: string | undefined): string | undefined {
  if (note === undefined) return undefined
  const cleaned = note.replace(/[【】\r\n]/g, '').trim()
  if (cleaned === '') return undefined
  return Array.from(cleaned).slice(0, NOTE_MAX_CHARS).join('')
}

/** 基础 prompt + 【重出修正】固定句（按标签顺序）+ 可选【补充说明】。 */
export function buildRegenPrompt(basePrompt: string, tags: RegenTag[], note?: string): string {
  const selected = new Set(tags)
  const sentences = regenTags
    .filter((tag) => selected.has(tag))
    .map((tag) => REGEN_TAG_SENTENCES[tag])
    .join('')
  const cleaned = sanitizeRegenNote(note)
  const supplement = cleaned === undefined ? '' : `\n【补充说明】${cleaned}`
  return `${basePrompt}\n【重出修正】${sentences}${supplement}`
}
