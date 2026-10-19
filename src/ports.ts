import type { Bbox, ImageSize, Scope } from './contracts.js'

export interface GarmentPiece {
  part: string
  item: string
}

export interface GarmentBrief {
  imageType: 'flat_lay' | 'on_model' | 'other'
  garments: GarmentPiece[]
  suggestedPrompt: string
  uncertainty: string[]
  bbox?: Bbox
}

export interface LocateGarmentRequest {
  imagePath: string
  contentHash: string
  model?: string
}

export interface GarmentFrame {
  bbox: Bbox
}

export interface BriefRequest {
  imagePath: string
  contentHash: string
  scope: Scope
  model?: string
}

export interface VisionPort {
  locateGarment(
    request: LocateGarmentRequest,
    signal: AbortSignal,
  ): Promise<GarmentFrame>
  brief(request: BriefRequest, signal: AbortSignal): Promise<GarmentBrief>
}

export interface GenerateRequest {
  garmentPath: string
  modelPath: string
  /** 精简流程：给出时按「模特照 + 这些参考图」的顺序提交，忽略 garmentPath */
  referencePaths?: string[]
  prompt: string
  model: string
  size: ImageSize
}

export interface GeneratedImage {
  bytes: Uint8Array
  mediaType: 'image/jpeg' | 'image/png' | 'image/webp'
  providerRequestId?: string
}

export interface GenerationCheckpoint {
  providerRequestId?: string
  onProviderRequestId?: (providerRequestId: string) => Promise<void>
}

export interface ImageGenerationPort {
  generate(
    request: GenerateRequest,
    signal: AbortSignal,
    checkpoint?: GenerationCheckpoint,
  ): Promise<GeneratedImage>
}
