import type {
  BriefRequest,
  GarmentFrame,
  GarmentBrief,
  LocateGarmentRequest,
  VisionPort,
} from '../../src/ports.js'

export type LocateGarmentHandler = (
  request: LocateGarmentRequest,
  callIndex: number,
) => Promise<GarmentFrame> | GarmentFrame

export class FakeVision implements VisionPort {
  readonly locateGarmentCalls: LocateGarmentRequest[] = []
  readonly briefCalls: BriefRequest[] = []

  constructor(
    private readonly locateGarmentHandler: LocateGarmentHandler = () => ({
      bbox: [100, 100, 900, 900],
    }),
  ) {}

  async locateGarment(request: LocateGarmentRequest): Promise<GarmentFrame> {
    const callIndex = this.locateGarmentCalls.length
    this.locateGarmentCalls.push(request)
    return this.locateGarmentHandler(request, callIndex)
  }

  async brief(request: BriefRequest): Promise<GarmentBrief> {
    this.briefCalls.push(request)
    return {
      imageType: 'flat_lay',
      garments: [{ part: '主体', item: '测试服装' }],
      suggestedPrompt: '测试提示词',
      uncertainty: [],
    }
  }
}
