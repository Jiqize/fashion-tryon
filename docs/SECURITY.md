# Security and Local Secrets

## 本机秘密

本机配置保存在 Git 忽略的 `local-secrets/` 与 `.env.local`。credential 只由 production adapters 从环境读取，不存在 CLI 参数，不进入 `studio.json`、看板页面、SSE 事件、日志、`成图/`、`总览.html`、`mapping.csv`、测试快照或对话。

加载顺序固定为：shell 环境变量 → 当前工作目录 `.env.local`、`.env` → CLI 安装包根目录 `.env.local`、`.env`；先出现的值优先，后加载的文件永不覆盖。因此第三方目录里的 `.env` 无法覆盖 shell 或包根已设置的 key。

provider 端点必须是 `https:`（回环地址允许 `http:` 供测试使用）。`APIMART_BASE_URL` / `DASHSCOPE_BASE_URL` 指向 `api.apimart.ai`、`dashscope.aliyuncs.com` 之外的主机时，必须显式设置 `FASHION_TRYON_ALLOW_CUSTOM_PROVIDER_HOST=1`，否则报 `CONFIG_ERROR` 并只列变量名。这防止被劫持的工作目录把真实 key 与用户图片发往陌生地址。

每次 provider 请求都有单独超时（JSON 调用 60 s，上传/下载 180 s）；轮询按墙钟 deadline 计时。provider 返回的结果 URL 必须是 https 且不得指向回环或私有网段，下载不跟随重定向，响应体有大小上限并做图像解码校验。

不要读取后打印秘密，不要使用会把值展开到命令行或终端输出的调试方式。发现秘密进入 Git index 时立即停止提交并报告暴露面；不要擅自轮换、删除或上传。

## 付费边界

用户在看板上确认开始一次即授权整批首轮生成；之后在页面上点重出即授权该次重出。不做逐步授权、dry-run 或预算闸门，Agent 不代替用户开始、判断或重出。

同一任务的一次生成只提交一次：

- 服务商受理后立即把 task ID（`providerRequestId`）与提交时间写入 `studio.json`；崩溃或重启后只续取该 task 的结果，不重新提交。
- 生成提交阶段 HTTP 429 表示服务商未受理，引擎降速并退避后重新提交，不计调用。
- 其他提交阶段失败（无响应、5xx、已记录提交时间但没有 task ID）结果不确定，记为失败且不自动重提；由用户在页面上决定是否重试。

## 本地看板服务

- 只监听 `127.0.0.1`；URL 带高熵随机 token，端口与 token 写入批次目录私有文件（mode 0600），同一批次重启沿用同一 URL。
- 所有请求校验 token；写操作只接受同源 `application/json`，正文上限 1 MiB。
- 响应带 `no-store` 与 `nosniff`；图片只从批次目录与素材根目录内的相对路径读取，不允许越界。
- 页面视图不含 prompt 全文与素材根目录路径；错误文案与通知去掉绝对路径后再下发。

## 数据与文件

- 素材根目录只读；唯一允许写入的业务输出是 `<素材根目录>/成图/<款号>/`，扫描器忽略该树，发布不覆盖已有文件（同名加后缀，同内容不重复写）。
- 其余运行数据只写批次目录 `<素材根目录的父目录>/<素材根目录名>-tryon-studio/`：`studio.json` 每次整体写临时文件后 `rename` 替换（mode 0600），版本图片同样原子写入且永不覆盖。
- 批次目录含用户素材、生成图片、prompt 与人工判断，默认私有，只留在本机。
- `总览.html` 与 `mapping.csv` 只写相对文件名与款号，不写绝对路径、prompt 或远程响应；HTML 转义所有显示文本。
- 人工填写的重出说明去掉换行与【】后截断，作为【补充说明】拼在 prompt 末尾。

## 强制规则

- 不在错误、日志、页面、`studio.json` 或交付物中回显 credential、request headers 或完整远程响应。
- adapter 缺配置只报告变量名，不报告值。
- 不做 AI 自动质检、打分或排序；采用哪个版本只能由人的判断改变。
- fake tests 禁止网络；secret scanner 覆盖 tracked files；可用 `--private-path` 检查导出物是否泄漏私人绝对路径，失败输出只列文件和变量类别。
- `git status --ignored` 可验证私有文件被忽略，但不要打印其内容。

## 测试边界

常规门禁只使用 fake adapters 和本地合成图。paid e2e（`tests/paid-e2e.test.ts`，2 套 × 3 张）默认跳过；只有用户明确要求、设置 `FASHION_TRYON_PAID_E2E=1` 与 `PAID_E2E_SOURCE_ROOT` 后才会真实调用。
