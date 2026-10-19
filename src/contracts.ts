import { z } from 'zod'

// 跨模块共用的基础取值：换装范围、出图比例、服装定位框、裁切框
export const scopes = ['top', 'bottom', 'full', 'full_acc'] as const
export const imageSizes = ['1:1', '3:4', '2:3', '4:3', '3:2', '9:16', '16:9'] as const

export type Scope = (typeof scopes)[number]
export type ImageSize = (typeof imageSizes)[number]

/** 服装定位框：0–1000 归一化坐标 [x1, y1, x2, y2]。 */
export const bboxSchema = z
  .tuple([
    z.number().min(0).max(1000),
    z.number().min(0).max(1000),
    z.number().min(0).max(1000),
    z.number().min(0).max(1000),
  ])
  .refine(([x1, y1, x2, y2]) => x2 > x1 && y2 > y1, 'bbox must have positive area')

export type Bbox = z.infer<typeof bboxSchema>

/** 裁切框：原图像素（已按 EXIF 方向校正）。 */
export const plannedCropBoxSchema = z.object({
  left: z.number().int().nonnegative(),
  top: z.number().int().nonnegative(),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
}).strict()
