# CHANGES

逐条列出对原始 qqbridge 代码的改动及原因。业务逻辑（人格 prompt、记忆结构、消息处理、
TTS/绘图降级链）保持原样，只做配置化、安全加固与容器化。

## 一、代码改造

### 1. 新增 `config.mjs`
- 集中定义路径常量：`DATA_DIR=/data`、`STICKER_DIR=/data/stickers`、
  `MEMORY_FILE=/data/shared-memory.md`、`PERSONA_FILE=/data/role-card.md`、
  `HISTORY_FILE=/data/history.json`、`IMAGES_DIR=/data/images`、`TMP=/tmp/qqbridge`，
  另加 `LOG_DIR`、`STATE_DIR`、`BACKUP_DIR`、`DRAWN_DIR`、`STICKER_MINE_DIR`。
  本地联调可用 `QQBRIDGE_DATA_DIR` / `QQBRIDGE_TMP` 覆盖，容器内默认固定 `/data`。
- 提供 `getConfig` / `saveConfig` / `reloadConfig` / `ensureConfigFile`，带 mtime 缓存。
- 所有默认值集中在 `defaultConfig()`，配置文件缺失时自动生成，并生成内部
  `/reload` 令牌 `server.internalToken`。
- 提供 `apiKey()`，统一读取 `config.ai.apiKey`，并支持 `DEEPSEEK_API_KEY` 环境变量兜底。
- 提供 `apiUrl()`，兼容 `https://api.deepseek.com`、`.../v1` 等 Base URL。
- 提供 scrypt 密码哈希、随机密码、随机会话令牌、掩码/反掩码、原子写、日志等工具。

### 2. 硬编码路径全部替换
- `D:/qqbridge`、`E:/deep表情包`、`C:/Users/31732/...` 全部删除。
- 表情目录合并为 `/data/stickers`（主目录）与 `/data/stickers/mine`（聊天收藏）。
- 人格文件 `/data/role-card.md`；共同记忆 `/data/shared-memory.md`。
- 历史 `/data/history.json`、`/data/web-history.json`。
- 临时文件统一 `/tmp/qqbridge`；日志 `/data/logs`；状态 `/data/state`；备份 `/data/backup`。
- 所有脚本不再出现 Windows 盘符或用户目录。

### 3. `file:///C:/...node_modules/...` 改为裸导入
- 所有模块改为 `import WebSocket from 'ws'`、动态 `import('playwright-core')`。
- `package.json` 声明依赖：`ws`、`playwright-core`。
- 抖音相关模块只在开关打开后才动态导入 `playwright-core`，默认禁用时不加载浏览器库。

### 4. `apiKey()` 的 8+ 处重复实现合并
- bridge / server / balance / diary / dynamic / learn / proactive-slot / reply-comments /
  research2 / share / signature 中原有的 `.credentials.yaml` 正则抓取全部删除。
- 统一使用 `config.mjs` 的 `apiKey()`，读取 `config.ai.apiKey`。
- 不再读取 `.credentials.yaml`。

### 5. 删除 `watchdog.ps1`
- 进程守护交给 docker compose 的 `restart: unless-stopped`。
- 面板「一键重启」通过 `/data/state/restart-{service}.flag` + 进程退出 + compose 拉起实现。

### 6. 去掉 UTF-8 BOM
- 所有 `.mjs`、`.html`、`.md`、`.json`、`.yml` 等文本文件统一无 BOM（bridge.mjs、
  server.mjs、volc-tts.mjs、web/index.html 原来带 BOM）。

### 7. ffmpeg / python 调用改为命令名
- 原 `C:/Users/.../ffmpeg...exe` → `ffmpeg`。
- 原 `C:/Users/.../python.exe` → `python3`；edge-tts 通过 `python3 -m edge_tts` 调用。
- Dockerfile 安装 `ffmpeg`、`python3`、`python3-pip`，pip 用清华镜像安装 `edge-tts`。

### 8. 安全缺陷修复
- `server.mjs` 的 `/sticker/`：用 `path.resolve` 拼接后校验必须位于 `STICKER_DIR` /
  `STICKER_MINE_DIR` 内，否则 404。`/audio/` 同样校验。
- `server.mjs` 监听 `0.0.0.0`，但 compose 只映射到 `127.0.0.1:3002`（或不暴露）。
- `/history` 增加 HttpOnly 会话令牌校验；`/ws` 升级也校验同一 Cookie，未登录返回 401。
- admin 面板所有 `/api/*` 需要登录 Cookie；密码 scrypt；登录失败限流。
- 面板与 API 不回显明文密钥，只返回 `sk-****后四位`；保存时识别掩码并保留原值。
- 配置导出默认打码，完整导出需要二次确认；导入不允许覆盖管理员密码与内部令牌。
- 表情上传校验 2MB 上限、名称过滤路径分隔符；删除时再次做 `path.resolve` 前缀校验。
- 自建容器（bridge/webchat/admin）非 root（uid=1000）、只读根文件系统、`cap_drop ALL`、
  `no-new-privileges`。NapCat 官方镜像 entrypoint 依赖 root 做 usermod/chown/gosu，
  该入口最终会把 QQ 业务进程降权到 napcat(1000)，只有初始化入口是 root；因此只有这个
  第三方容器保留可写根文件系统（其余加固项仍保留），详见 README。

### 9. 日志
- 新增 `createLogger(name)`：写入 `/data/logs/{name}.log`。
- 跨天自动改名为 `{name}-YYYY-MM-DD.log`；单文件达到 5MB 立即切分；保留 7 天。
- bridge、webchat、admin 以及所有辅助脚本均改为该日志器，不再散落 `appendFileSync`。
- 面板「日志」页读取最近 N 行，支持关键词过滤。

### 10. 原子写
- `atomicWriteFileSync`：写临时文件 + fsync + rename。
- 历史、配置、状态、主动消息状态、记忆、日记、学习笔记等所有 JSON/Markdown 写操作改为原子写。
- 避免 bridge / webchat / admin 并发写同一文件时互相覆盖。

## 二、配置面板（新增）

- 新增独立进程 `admin.mjs`（端口 8080），不与 `server.mjs` 混合。
- 新增 `web/admin/index.html` 单页：左侧导航 + 右侧表单，原生 HTML + fetch，无前端框架。
- 首次启动无密码时生成 16 位随机密码，打印到 `admin.log` 与容器 stdout，并标记
  `mustChange: true`。
- 登录成功写 HttpOnly Cookie（SameSite=Strict，24h），所有 `/api/*` 校验。
- 九个板块：总览、AI、QQ、TTS、人格与记忆、表情库、抖音自动化、日志、运维。
- 接口按需求实现：
  - `GET /api/status`、`POST /api/login`、`POST /api/logout`
  - `GET/PUT /api/config`、`POST /api/test/ai`、`POST /api/test/tts`、`POST /api/test/qq`
  - `GET /api/logs`
  - `GET/PUT /api/memory/role`、`GET/PUT /api/memory/shared`
  - `GET/POST /api/stickers`、`GET/DELETE /api/stickers/:name`
  - `POST /api/restart`
  - `GET /api/export`、`POST /api/import`
  - 额外：`POST /api/password`（修改密码）、`POST /api/history/clear`（清空历史）
- 表情上传使用原生 multipart 解析，ffmpeg 自动压到 512×512。
- 配置保存后调用 bridge `/reload`、webchat `/reload`；同时两个进程有 mtime 监听兜底。
- 服务状态：admin 通过 HTTP `/healthz` 检查 bridge/webchat，通过 TCP 检查 NapCat，
  读取 bridge 写出的 `/data/state/bridge-status.json` 显示 QQ 登录状态。
- DeepSeek 调用次数与最近错误：bridge/webchat/admin 各自写
  `/data/state/*-stats.json`，面板聚合。

## 三、配置热加载
- bridge 与 webchat 每 2 秒检查 `config.json` mtime，变化后 `config reloaded (file change)`。
- 同时支持 `SIGHUP` 与内部 `POST /reload`（`x-internal-token` 校验）。
- bridge 检测到 QQ WS 地址/token 变化时自动重连。

## 四、容器编排（新增）

- `Dockerfile`：多阶段构建；builder `npm ci --omit=dev` + 逐文件 `node --check`；
  runtime `node:22-slim`；apt 安装 ffmpeg/python3；pip 安装 edge-tts；uid=1000 `app` 用户；
  `HEALTHCHECK`。
- `docker-compose.yml`：napcat / bridge / webchat / admin 四服务；共享镜像；
  `depends_on` 健康检查；bridge/webchat/admin 三个自建服务启用
  `user 1000:1000`、`read_only`、`tmpfs /tmp`、`cap_drop ALL`、
  `no-new-privileges`、`mem_limit 768m`、`cpus 2`、`restart unless-stopped`。
  NapCat 因官方 entrypoint 必须 root，单独放开 `user`/`read_only`/`cap_drop`，
  其余限制保留（见 README 安全说明）。
- 仅 admin 的 8080 对外开放；webchat 只绑 127.0.0.1；NapCat WebUI 6099 只绑 127.0.0.1；
  NapCat WS 3001 仅容器网络。
- `.env.example`、`scripts/init-data.sh`、`.dockerignore`、`seed/` 初始化文件。
- `reset-password.mjs` 用于忘记密码时重置。

## 五、抖音自动化默认关闭

- `automation.enabled` 与 `watch` / `replyComments` / `dynamic` / `mention` 默认全部 `false`。
- 四个脚本启动先检查 `automationEnabled(module)`，不满足直接输出
  `douyin automation disabled by design` 并退出 0。
- bridge 内部抓评论区同样受 `automation.enabled && replyComments` 控制。
- notify 的抖音兜底也受总开关控制，默认只尝试 QQ。
- 面板每个开关下有红字「自动化操作可能导致账号封禁，风险自负」。

## 六、其他

- 原 README 保留为 `README.original.md`；新增部署 README、CHANGES、ACCEPTANCE。
- 历史中硬编码的 QQ 号、access token、`REDACTED_QQ_TOKEN` 占位符全部删除，
  改为配置项 / 白名单。
- 群聊：新增 `qq.allowGroup` 与 `qq.allowGroups`（默认关闭、群号留空=不限），
  开启后按私聊同样的白名单与业务逻辑回复，发送用 `send_group_msg`。
- 所有辅助脚本（diary、learn、research2、share、signature、balance、proactive-slot）
  同步改为 `/data` 路径、配置读取、原子写与统一日志。
- 不引入数据库；配置与状态继续使用 JSON 文件。
- 不修改原有人格 prompt 内容（`bridge.mjs` 与 `server.mjs` 中的人设/system prompt 原样保留，
  仅把图片路径 `D:/qqbridge/images` 替换为 `/data/images`）。
