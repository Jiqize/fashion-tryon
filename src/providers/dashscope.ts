import { readFile } from 'node:fs/promises'
import path from 'node:path'

import type { DashscopeConfig } from '../config.js'
import type { Bbox, Scope } from '../contracts.js'
import { RunnerError } from '../errors.js'
import type {
  BriefRequest,
  GarmentFrame,
  GarmentBrief,
  LocateGarmentRequest,
  VisionPort,
} from '../ports.js'
import { normalizeProviderError } from './http-errors.js'

function endpoint(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/chat/completions`
}

function fileMediaType(filePath: string): string {
  const extension = path.extname(filePath).toLocaleLowerCase('en-US')
  if (extension === '.png') return 'image/png'
  if (extension === '.webp') return 'image/webp'
  return 'image/jpeg'
}

async function toDataUrl(filePath: string): Promise<string> {
  return `data:${fileMediaType(filePath)};base64,${(await readFile(filePath)).toString('base64')}`
}

function stripFence(text: string): string {
  const match = /^```[A-Za-z]*\s*\n([\s\S]*?)\n?```\s*$/.exec(text.trim())
  return match?.[1]?.trim() ?? text.trim()
}

function objectFrom(text: string, context: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(stripFence(text))
    if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('not object')
    return value as Record<string, unknown>
  } catch {
    throw new RunnerError('PROVIDER_RESPONSE', `DashScope returned malformed ${context}`)
  }
}

function bboxFrom(value: unknown): Bbox | undefined {
  if (!Array.isArray(value) || value.length !== 4) return undefined
  if (!value.every((item) => typeof item === 'number' && Number.isFinite(item) && item >= 0 && item <= 1000)) {
    return undefined
  }
  const bbox = value as Bbox
  return bbox[2] > bbox[0] && bbox[3] > bbox[1] ? bbox : undefined
}

function parseGarmentFrame(value: Record<string, unknown>): GarmentFrame {
  const bbox = bboxFrom(value.bbox)
  if (bbox === undefined) {
    throw new RunnerError('PROVIDER_RESPONSE', 'DashScope garment framing response has invalid bbox')
  }
  return { bbox }
}

type AttributeKind = 'color' | 'detail' | 'fit' | 'length' | 'material' | 'pattern'
type PieceKind = 'accessory' | 'bottom' | 'one_piece' | 'top'

const inferenceMarker = /推断|猜测|可能|也许|大概|预计|疑似|似乎|或为|无法确认|不能确认|不可辨|不确定|未知|未显示|未展示|看不到|不可见|仅可见|部分可见|likely|possibly|probably|inferred|estimated|uncertain|unknown|not visible|not shown|cannot determine|may be|appears to/i

function attributeKinds(text: string): Set<AttributeKind> {
  const kinds = new Set<AttributeKind>()
  if (/颜色|色调|米白|象牙白|白色|黑色|灰色|红色|蓝色|绿色|黄色|紫色|粉色|橙色|棕色|褐色|color|colour|ivory|white|black|grey|gray|red|blue|green|yellow|purple|pink|orange|brown/i.test(text)) kinds.add('color')
  if (/logo|标识|徽标|品牌|刺绣|纽扣|拉链|领口|圆领|方领|高领|v领|袖口|口袋|褶裥|褶皱|领型|button|zipper|neckline|collar|pocket/i.test(text)) kinds.add('detail')
  if (/版型|宽松|修身|紧身|廓形|阔腿|直筒|锥形|高腰|低腰|收腰|oversized|loose|relaxed|slim|fitted|wide[- ]?leg|straight[- ]?leg|high[- ]?waist|low[- ]?waist|silhouette|fit/i.test(text)) kinds.add('fit')
  if (/长度|衣长|裤长|裙长|袖长|落点|及腰|及臀|臀部|及膝|过膝|膝上|膝下|及踝|脚踝|拖地|九分|七分|五分|短款|长款|中长|cropped|ankle|knee|hemline|length/i.test(text)) kinds.add('length')
  if (/材质|面料|成分|纤维|混纺|羊绒|马海毛|羊毛|棉质|纯棉|真丝|亚麻|皮革|皮质|涤纶|聚酯|尼龙|灯芯绒|牛仔布|cashmere|mohair|wool|cotton|silk|linen|leather|polyester|nylon|corduroy|denim|fabric|material|fiber|fibre|blend/i.test(text)) kinds.add('material')
  if (/纹理|图案|印花|条纹|格纹|绞花|提花|波点|pattern|print|stripe|plaid|check|cable[- ]?knit|jacquard|polka/i.test(text)) kinds.add('pattern')
  return kinds
}

function pieceKinds(text: string): Set<PieceKind> {
  const kinds = new Set<PieceKind>()
  const onePiece = /连衣裙|连体裤|连体衣|jumpsuit|romper|one[- ]?piece|dress/i.test(text)
  if (onePiece) kinds.add('one_piece')
  if (!onePiece && /上装|上衣|毛衣|针织衫|衬衫|t恤|卫衣|夹克|外套|大衣|背心|吊带|top|shirt|blouse|sweater|knitwear|hoodie|jacket|coat|vest|camisole/i.test(text)) kinds.add('top')
  if (!onePiece && /下装|裤|半身裙|短裙|长裙|bottom|pants|trouser|skirt|shorts/i.test(text)) kinds.add('bottom')
  if (/配饰|饰品|包|围巾|丝巾|帽|首饰|耳饰|项链|腰带|鞋|accessor|bag|scarf|hat|jewel|belt|shoe/i.test(text)) kinds.add('accessory')
  return kinds
}

function intersects<T>(left: Set<T>, right: Set<T>): boolean {
  return [...left].some((item) => right.has(item))
}

function splitClauses(text: string): string[] {
  const clauses: string[] = []
  let depth = 0
  let current = ''
  for (const character of text.trim()) {
    if ('（([【'.includes(character)) depth += 1
    if ('）)]】'.includes(character)) depth = Math.max(0, depth - 1)
    if (depth === 0 && '，,；;。'.includes(character)) {
      if (current.trim() !== '') clauses.push(current.trim())
      current = ''
    } else {
      current += character
    }
  }
  if (current.trim() !== '') clauses.push(current.trim())
  return clauses
}

function splitAttributeSegments(clause: string): string[] {
  return clause
    .split(/\s+(?:with|featuring)\s+|(?:带有|配有|采用)/i)
    .map((segment) => segment.trim())
    .filter((segment) => segment !== '')
}

function sanitizeGarmentItem(part: string, item: string, uncertainty: string[]): string {
  const targetKinds = pieceKinds(`${part} ${item}`)
  const uncertainAttributes = uncertainty
    .filter((entry) => {
      const uncertaintyTargets = pieceKinds(entry)
      return uncertaintyTargets.size === 0 || intersects(targetKinds, uncertaintyTargets)
    })
    .map(attributeKinds)
    .filter((kinds) => kinds.size > 0)
  const uncertainKinds = new Set<AttributeKind>(uncertainAttributes.flatMap((kinds) => [...kinds]))

  const clauses = splitClauses(item).flatMap(splitAttributeSegments).filter((clause) => {
    if (inferenceMarker.test(clause)) return false
    const clauseAttributes = attributeKinds(clause)
    if (!intersects(clauseAttributes, uncertainKinds)) return true
    return [...clauseAttributes].some((kind) => !uncertainKinds.has(kind))
  })
  return clauses.join('，') || part.trim()
}

function parseBrief(value: Record<string, unknown>): GarmentBrief {
  if (!['flat_lay', 'on_model', 'other'].includes(String(value.imageType))) {
    throw new RunnerError('PROVIDER_RESPONSE', 'DashScope brief response has invalid imageType')
  }
  if (!Array.isArray(value.garments) || value.garments.length === 0) {
    throw new RunnerError('PROVIDER_RESPONSE', 'DashScope brief response has no garments')
  }
  if (!Array.isArray(value.uncertainty) || !value.uncertainty.every((item) => typeof item === 'string')) {
    throw new RunnerError('PROVIDER_RESPONSE', 'DashScope brief response has invalid uncertainty')
  }
  const uncertainty = value.uncertainty as string[]
  const garments = value.garments.map((item) => {
    if (typeof item !== 'object' || item === null) {
      throw new RunnerError('PROVIDER_RESPONSE', 'DashScope brief garment is invalid')
    }
    const piece = item as Record<string, unknown>
    if (typeof piece.part !== 'string' || piece.part.trim() === '' || typeof piece.item !== 'string' || piece.item.trim() === '') {
      throw new RunnerError('PROVIDER_RESPONSE', 'DashScope brief garment is invalid')
    }
    const part = piece.part.trim()
    return { part, item: sanitizeGarmentItem(part, piece.item.trim(), uncertainty) }
  })
  // suggestedPrompt 不参与 prompt 构建，缺失或非字符串时按空串处理。
  const suggestedPrompt = typeof value.suggestedPrompt === 'string' ? value.suggestedPrompt : ''
  const bbox = bboxFrom(value.bbox)
  return {
    imageType: value.imageType as GarmentBrief['imageType'],
    garments,
    suggestedPrompt,
    uncertainty,
    ...(bbox === undefined ? {} : { bbox }),
  }
}

function locateGarmentInstruction(): string {
  return [
    '定位图片中需要用于换装的目标服装整体边界。',
    '若目标是成套或多层服装，bbox 必须覆盖全部目标层；排除无关背景，并且不要把展示人物本身当作目标服装。',
    '只输出 JSON：{"bbox":[x1,y1,x2,y2]}。坐标单位固定为 0-1000 千分比，边界必须为有效正面积。',
  ].join('')
}

function briefInstruction(scope: Scope): string {
  return `分析服装参考图并只输出 JSON：{"imageType":"flat_lay"|"on_model"|"other","garments":[{"part":string,"item":string}],"suggestedPrompt":string,"uncertainty":string[],"bbox":[x1,y1,x2,y2]}。本次 scope=${scope}。item 只写图片中可直接观察到的属性，品类、颜色、纹理、版型、材质和长度落点不要求每项齐全。不可辨认的属性必须从 item 省略，只能写入 uncertainty；不得把同一属性同时写入 item 与 uncertainty。不得推断纤维成分，不得推断画外或被遮挡部位的长度落点。`
}

/** 单请求超时触发的中止；与 run signal 的用户中止必须区分开。 */
function isTimeoutAbort(error: unknown): boolean {
  return error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')
}

/** 可重试错误的抖动退避：2s 基数，指数增长，抖动系数 0.5-1.5。 */
function backoffMs(attempt: number): number {
  return Math.round(RETRY_BASE_MS * 2 ** attempt * (0.5 + Math.random()))
}

function defaultSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const onAbort = (): void => {
      clearTimeout(timer)
      reject(new RunnerError('ABORTED', 'DashScope request was aborted'))
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

const RETRY_BASE_MS = 2_000
/** 首次调用之外最多再重试 2 次。 */
const MAX_RETRIES = 2

export function createDashscopeAdapter(
  config: DashscopeConfig,
  fetchImpl: typeof fetch = fetch,
  sleepImpl: (ms: number, signal: AbortSignal) => Promise<void> = defaultSleep,
): VisionPort {
  const callOnce = async (
    instruction: string,
    imagePaths: string[],
    model: string | undefined,
    signal: AbortSignal,
  ): Promise<Record<string, unknown>> => {
    if (signal.aborted) throw new RunnerError('ABORTED', 'DashScope request was aborted')
    const images = await Promise.all(imagePaths.map(toDataUrl))
    let response: Response
    try {
      response = await fetchImpl(endpoint(config.baseUrl), {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${config.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: model ?? config.model,
          stream: false,
          max_tokens: config.maxTokens,
          messages: [{
            role: 'user',
            content: [
              { type: 'text', text: instruction },
              ...images.map((imageUrl) => ({ type: 'image_url', image_url: { url: imageUrl } })),
            ],
          }],
        }),
        signal: AbortSignal.any([signal, AbortSignal.timeout(config.requestTimeoutMs)]),
      })
    } catch (error) {
      // 只有 run signal 自身被取消才算用户中止；单请求超时属于 provider 超时。
      if (signal.aborted) throw new RunnerError('ABORTED', 'DashScope request was aborted')
      if (isTimeoutAbort(error)) {
        throw new RunnerError(
          'PROVIDER_TIMEOUT',
          `DashScope request exceeded the ${String(config.requestTimeoutMs)} ms per-request timeout`,
          { retryable: true },
        )
      }
      throw await normalizeProviderError('dashscope', error, [config.apiKey])
    }
    if (!response.ok) throw await normalizeProviderError('dashscope', response, [config.apiKey])

    let envelope: Record<string, unknown>
    try {
      const parsed: unknown = JSON.parse(await response.text())
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('bad')
      envelope = parsed as Record<string, unknown>
    } catch {
      throw new RunnerError('PROVIDER_RESPONSE', 'DashScope returned malformed completion JSON')
    }
    const choices = envelope.choices
    const choice = Array.isArray(choices) && typeof choices[0] === 'object' && choices[0] !== null
      ? choices[0] as Record<string, unknown>
      : undefined
    if (choice?.finish_reason === 'length') {
      throw new RunnerError('VISION_TRUNCATED', `DashScope output exceeded max_tokens=${String(config.maxTokens)}`)
    }
    const message = typeof choice?.message === 'object' && choice.message !== null
      ? choice.message as Record<string, unknown>
      : undefined
    if (typeof message?.content !== 'string' || message.content.trim() === '') {
      throw new RunnerError('PROVIDER_RESPONSE', 'DashScope completion is missing content')
    }
    return objectFrom(message.content, 'structured output')
  }

  /** 可重试错误（429/408/5xx/网络）退避重试，避免一次瞬时故障作废整批已付费定位。 */
  const call = async (
    instruction: string,
    imagePaths: string[],
    model: string | undefined,
    signal: AbortSignal,
  ): Promise<Record<string, unknown>> => {
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await callOnce(instruction, imagePaths, model, signal)
      } catch (error) {
        const retryable = error instanceof RunnerError && error.retryable
        if (!retryable || attempt >= MAX_RETRIES) throw error
        if (signal.aborted) throw new RunnerError('ABORTED', 'DashScope request was aborted')
        await sleepImpl(backoffMs(attempt), signal)
      }
    }
  }

  return {
    async locateGarment(request: LocateGarmentRequest, signal: AbortSignal) {
      return parseGarmentFrame(await call(
        locateGarmentInstruction(),
        [request.imagePath],
        request.model,
        signal,
      ))
    },
    async brief(request: BriefRequest, signal: AbortSignal) {
      return parseBrief(await call(briefInstruction(request.scope), [request.imagePath], request.model, signal))
    },
  }
}
