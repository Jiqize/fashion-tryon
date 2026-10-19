import path from 'node:path'

// 精简流程的提示词：图1 是模特照（底图），图2… 是同一套服装的参考图
// 2026-10-14 实测（4 款 × 3 张模特照）：多张参考图 + 标明用途 + 去掉配饰，服装还原最稳

/** 文件名里能识别出的用途词；命中时把去掉序号的文件名当作这张图的用途。 */
const ROLE_WORDS = ['全身', '半身', '正面', '侧面', '背面', '细节', '特写', '领口', '袖口', '下摆', '印花', '面料']

/** 由文件名得出参考图用途，例如 `细节-领口.jpg` → `细节-领口`；认不出时返回 undefined。 */
export function referenceRole(fileName: string): string | undefined {
  const stem = path.parse(fileName).name.normalize('NFC').trim()
  if (!ROLE_WORDS.some((word) => stem.includes(word))) return undefined
  // 去掉开头的排序号，如 `01-全身` / `1_全身`
  return stem.replace(/^\d+[\s._-]*/, '') || stem
}

/** outfit：换参考图里的一整套和鞋；top：只换上衣，下装和鞋留图1原样 */
export type SwapMode = 'outfit' | 'top'

export function buildSimplePrompt(referenceFiles: string[], swap: SwapMode = 'outfit'): string {
  return buildPromptFromRoles(referenceFiles.map((file) => referenceRole(path.basename(file))), swap)
}

/** 按参考图用途列表（顺序即图2、图3…）生成提示词；用途 undefined 表示认不出。 */
export function buildPromptFromRoles(roles: (string | undefined)[], swap: SwapMode = 'outfit'): string {
  const last = roles.length + 1
  const subject = swap === 'top' ? '同一件上衣' : '同一套服装'
  const head = roles.length === 1
    ? swap === 'top' ? '图2是这件上衣的参考图。' : '图2是这套服装的参考图。'
    : roles.some((role) => role !== undefined)
      ? [
          `图2到图${String(last)}是${subject}的参考图，每张的用途如下：`,
          ...roles.map((role, index) => `图${String(index + 2)}：${role ?? '服装参考图'}`),
        ].join('\n')
      : `图2到图${String(last)}是${subject}的参考图，从不同角度拍摄，都是同一件（套）衣服。`

  return [
    '图1是底图：一位模特在场景里的照片。人物、姿势、背景、构图和光线都以图1为准。',
    head,
    '',
    ...(swap === 'top'
      ? [
          // 2026-10-15 单件上衣素材：按整套换会把参考图搭配的裤子和鞋一起换上，模特照只有半身时全身比例也会出错
          '【换什么】只换上衣：把图1模特上半身的衣服（外套和里面的打底）换成参考图里的这件上衣，领口、门襟露出的部分以平铺图为准。',
          '图1的下装、鞋、袜和腰带保持原样，参考图里搭配的裤子、裙子和鞋一律不要用。',
          '上衣下摆和图1下装的衔接（盖在外面还是塞进去）照参考图。',
        ]
      : [
          '【换什么】只换服装和鞋：把图1模特身上的服装和鞋，换成参考图里这一整套。',
          // 2026-10-15 003 红色 polo：白色打底有的图换上有的没换
          '参考图里领口、下摆露出的内搭（如白色打底）也属于这一套，每张图都要一并换上，露出的位置和多少照参考图。',
        ]),
    '每个部位以看得最清楚的那张参考图为准：全身图看整体比例和长度落点，半身图看版型，侧面和背面图看轮廓，细节图看领口、扣子、口袋、滚边、印花、袖口、下摆和面料纹理。',
    '颜色、版型、长度落点必须和参考图一致，不得加长或缩短。',
    '【去掉什么】去掉图1模特身上戴的项链、胸前挂饰，以及系在脖子上的围巾和丝巾。',
    '参考图里的项链、挂包这类配饰也不要加。',
    '【留什么】图1人物的脸、发型、耳环、体型、肤色、姿势和视线不变。',
    // 2026-10-14 EX66095 0 (2)：手插口袋被改成叉腰，跟了参考图人物的手势，所以把手部写细
    '双手的位置和动作与图1完全一致：手插在哪里、搭在哪里、露出多少袖口都照图1。',
    '图1模特手里拿着的包和围巾保持原样。',
    '图1的背景、取景范围、人物大小与位置、光线方向和色温不变。',
    '【不要什么】参考图里人物的脸、发型、姿势和手部动作一律不要参考，只看衣服。',
    '图1里被挡住或没拍到的身体部位不要补出来。',
    // 2026-10-15 Jacquemus 胸前贴标被「不要文字」一并抹掉
    '衣服自带的印花、贴标和字样照参考图原样还原；除此之外画面里不要出现任何文字。',
  ].join('\n')
}
