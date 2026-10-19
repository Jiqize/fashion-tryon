# Core implementation

Tryon Studio（`docs/specs/2026-09-25-tryon-studio.md`）的实现。核心保持 Agent-first：Skill 调 CLI（`studio`、`status`），CLI 启动本地看板服务，服务编排纯 Node 深模块与 production/fake provider ports。

职责分布：`studio/`（扫描、准备、引擎、判断、交付、服务）、`prepare/`（裁切压缩、服装描述、prompt）、`providers/`（APIMART、DashScope）、`config`、`errors`、`contracts`、`ports` 与 CLI 入口。不得把 DSH 或 MCP SDK 引入核心。
