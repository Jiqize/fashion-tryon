// 验收测试用子进程：以假服务商运行 `fashion-tryon studio`，每次提交与续取都追加到日志文件。
// 用法：node --import tsx studio-child.ts <素材根目录> <日志文件> <前 N 次提交正常返回，之后的提交挂起；-1 表示不挂起>
import { appendFileSync } from 'node:fs'

import sharp from 'sharp'

import { runCli } from '../../src/cli.js'
import type { GeneratedImage, ImageGenerationPort, VisionPort } from '../../src/ports.js'

const [sourceRoot, logPath, hangAfterArgument] = process.argv.slice(2) as [string, string, string]
const hangAfter = Number(hangAfterArgument)

function log(entry: Record<string, unknown>): void {
  appendFileSync(logPath, `${JSON.stringify(entry)}\n`)
}

const vision: VisionPort = {
  async locateGarment() {
    return { bbox: [100, 100, 900, 900] }
  },
  async brief() {
    return {
      imageType: 'flat_lay',
      garments: [{ part: '上装', item: '测试上衣' }],
      suggestedPrompt: '',
      uncertainty: [],
    }
  },
}

let submissions = 0
const images: ImageGenerationPort = {
  async generate(_request, _signal, checkpoint): Promise<GeneratedImage> {
    let providerRequestId = checkpoint?.providerRequestId
    if (providerRequestId === undefined) {
      submissions += 1
      providerRequestId = `pid${String(process.pid)}-${String(submissions)}`
      // 服务商受理后先回调 task ID（落盘），之后才是轮询等待
      await checkpoint?.onProviderRequestId?.(providerRequestId)
      log({ type: 'submit', id: providerRequestId })
      if (hangAfter >= 0 && submissions > hangAfter) await new Promise(() => undefined)
    } else {
      log({ type: 'resume', id: providerRequestId })
    }
    const bytes = await sharp({
      create: { width: 16, height: 16, channels: 3, background: { r: submissions * 40 % 256, g: 90, b: 140 } },
    }).jpeg().toBuffer()
    return { bytes, mediaType: 'image/jpeg', providerRequestId }
  },
}

void runCli(['studio', sourceRoot, '--no-open', '--json'], {
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
}, { env: { IMAGE_MODEL: 'fake-image-model' }, vision, imageGeneration: images })
