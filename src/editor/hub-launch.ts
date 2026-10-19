import path from 'node:path'

import type { LaunchConfig } from '../mcp/launch.js'
import { pingHub, readHubSession } from './hub-server.js'
import { configDir } from './last-root.js'
import { ensureService } from './launch.js'

// 确保项目服务在运行：会话文件指向的服务还活着就复用，否则在后台拉起 `fashion-tryon hub`；不自动退出

export function ensureHub(config: LaunchConfig): Promise<{ origin: string; token: string }> {
  const env = config.env ?? process.env
  return ensureService({
    live: async () => {
      const session = await readHubSession(env)
      if (session === undefined || !(await pingHub(session))) return undefined
      return { origin: `http://127.0.0.1:${String(session.port)}`, token: session.token }
    },
    args: ['hub', '--no-open', '--json'],
    logPath: path.join(configDir(env), 'hub.log'),
    label: '项目服务',
  }, config)
}
