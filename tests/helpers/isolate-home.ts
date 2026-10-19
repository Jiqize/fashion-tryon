import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

// setupFiles 每个测试文件跑一次：配置目录指到新的临时目录，绝不碰真实的 ~/.config/fashion-tryon
process.env.FASHION_TRYON_HOME = mkdtempSync(path.join(tmpdir(), 'fashion-tryon-home-'))
