import type { Scope } from '../contracts.js'
import type { GarmentBrief, GarmentPiece } from '../ports.js'

export interface PromptResult {
  prompt: string
  uncertainty: string[]
  reviewExpectation: string
  selectedGarments: GarmentPiece[]
}

// 模型自产文本可能带【】或换行，直接插值会伪造出新的分节标题
function sanitizeModelText(value: string): string {
  return value.replace(/[【】]/g, '').replace(/[\r\n]+/g, ' ').trim()
}

function itemText(piece: GarmentPiece): string {
  return sanitizeModelText(piece.item)
}

function normalizedPart(piece: GarmentPiece): string {
  return piece.part.trim().toLocaleLowerCase('en-US')
}

function isAccessory(piece: GarmentPiece): boolean {
  const part = normalizedPart(piece)
  return /配饰|饰品|包|围巾|丝巾|帽|首饰|耳饰|项链|accessor|bag|scarf|hat|jewel/.test(part)
}

function isTop(piece: GarmentPiece): boolean {
  const part = normalizedPart(piece)
  return /上装|上衣|外套|衬衫|夹克|大衣|top|shirt|blouse|jacket|coat/.test(part)
}

function isBottom(piece: GarmentPiece): boolean {
  const part = normalizedPart(piece)
  return /下装|裤|半身裙|bottom|pants|trouser|skirt/.test(part)
}

function selectedForScope(brief: GarmentBrief, scope: Scope): GarmentPiece[] {
  if (scope === 'top') return brief.garments.filter(isTop)
  if (scope === 'bottom') return brief.garments.filter(isBottom)
  if (scope === 'full') return brief.garments.filter((piece) => !isAccessory(piece))
  return [...brief.garments]
}

function takeText(selected: GarmentPiece[], scope: Scope): string {
  const label = scope === 'top' ? '上装' : scope === 'bottom' ? '下装' : '可见服装'
  if (selected.length === 0) return `图1中没有可靠辨认出的${label}；不得猜测补写。`
  return `只采用图1实际列出的${label}：${selected.map(itemText).join('；')}。颜色、纹理、材质、版型和长度落点均以图1为准，不得加长或缩短。`
}

function keepText(scope: Scope): string {
  if (scope === 'top') {
    return '替换图2模特原有的全部上装层（包括外搭、内搭、领口与外露下摆）；图1若包含多层目标上装，必须按图1的层次共同呈现。保留图2模特原有的下装、配饰及其他 scope 外部位，并保留人物身份特征。'
  }
  if (scope === 'bottom') {
    return '替换图2模特原有的全部下装层；图1若包含多层目标下装，必须按图1的层次共同呈现。保留图2模特原有的上装、配饰及其他 scope 外部位，并保留人物身份特征。'
  }
  return '保留图2人物的脸、发型、体型和肤感；图1未列出的可见服装部位保持图2原样。'
}

function expectation(scope: Scope, selected: GarmentPiece[], uncertainty: string[]): string {
  const items = selected.map(itemText).join('；')
  let requirement: string
  if (scope === 'top') requirement = `核对原模特的全部上装层已替换为：${items}；图1中的多层目标上装应共同呈现；保留下装、配饰及 scope 外部位。`
  else if (scope === 'bottom') requirement = `核对原模特的全部下装层已替换为：${items}；图1中的多层目标下装应共同呈现；保留上装、配饰及 scope 外部位。`
  else if (scope === 'full') requirement = `核对图1实际列出的全部可见服装：${items}；不核对未列出的品类。`
  else requirement = `核对图1实际列出的全部可见服装与配饰：${items}；不核对未列出的品类。`
  if (uncertainty.length === 0) return requirement
  return `${requirement}以下不确定项不作为审核要求，也不得作为 retry 理由：${uncertainty.join('；')}。`
}

export function buildTryonPrompt(brief: GarmentBrief, scope: Scope): PromptResult {
  const selected = selectedForScope(brief, scope)
  const uncertainty = [...brief.uncertainty]
  const safeUncertainty = uncertainty.map(sanitizeModelText).filter((entry) => entry.length > 0)
  const uncertaintyText =
    safeUncertainty.length === 0
      ? '没有额外不确定项；仍不得添加图1未列出的品类。'
      : `不确定项：${safeUncertainty.join('；')}。这些内容不得猜测或补全。`
  const lines = [
    `【取什么】${takeText(selected, scope)}`,
    `【留什么】${keepText(scope)}`,
    `【禁什么】图1未列出的品类不得凭空添加；展示款人物的非服装特征不得照搬。${uncertaintyText}`,
    '【姿势与场景】除目标服装外一切以图2为准：姿势、手部动作、身体朝向、视线、背景与场景全部保持图2原样；图1人物的动作不得照搬。',
    '【构图】严格保持图2的取景范围、裁切边界、人物大小与位置；图2没有拍到的身体部位不得补全，不得拉远或缩小人物。',
    '【光线】完全继承图2的光线角度、强度与色温，使替换服装自然融合。',
  ]
  return {
    prompt: lines.join('\n'),
    uncertainty,
    reviewExpectation: expectation(scope, selected, safeUncertainty),
    selectedGarments: selected,
  }
}
