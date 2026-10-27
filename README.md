# 大肥鱼 · QQ / 网页聊天桥（Docker 可配置版）

把原来的 Windows 本地脚本改成一台 Linux 服务器上 `docker compose up -d` 即可运行的部署形态。
所有配置通过浏览器 `http://<服务器IP>:8080` 完成，不需要改代码、不需要进容器。

- QQ：NapCat（OneBot v11 WebSocket）
- 模型：DeepSeek / 任意 OpenAI 兼容 `/chat/completions`
- 语音：豆包语音 → edge-tts 降级链
- 绘图：本地 SD → pollinations 降级链
- 网页聊天：原生 HTML + WebSocket
- 抖音自动化：代码保留，**默认全部关闭**，由面板总开关 + 子开关控制

---

## 1. 架构

```
浏览器 ──8080──> admin（配置面板 + 全部 REST API）
                    │  写 /data/config.json、发 /reload
                    ▼
手机 QQ ──> NapCat ──ws://napcat:3001──> bridge ──> DeepSeek API
                                        │
                                        ├─> 豆包 TTS / edge-tts
                                        └─> 绘图 pollinations
浏览器 ──127.0.0.1:3002（SSH 隧道）──> webchat ──> DeepSeek API
```

四个容器：

| 服务 | 镜像 | 作用 | 对外端口 |
|---|---|---|---|
| napcat | `mlikiowa/napcat-docker` | QQ 协议端 | 3001 仅容器网络；6099 仅本机 |
| bridge | 本项目镜像 | QQ 聊天桥 | 3010 仅容器网络 |
| webchat | 本项目镜像 | 网页聊天 | 127.0.0.1:3002 |
| admin | 本项目镜像 | 配置面板 | 0.0.0.0:8080 |

---

## 2. 服务器要求

- Linux x86_64 / arm64，Docker 24+、Docker Compose v2
- 建议 2 核 2GB 内存、10GB 可用磁盘（四个容器都限制 768MB / 2 CPU）
- 能访问 DeepSeek、火山引擎、Bing、pollinations（国内服务器注意网络）
- 一个可扫码登录的 QQ 号

---

## 3. 从零部署

### 3.1 上传代码并准备数据目录

```bash
# 在服务器上
cd /opt
git clone <你的仓库> qqbridge     # 或直接上传本目录
cd qqbridge
cp .env.example .env
# 必改：NAPCAT_WEBUI_TOKEN（NapCat 管理面板令牌）
# 可选：DATA_DIR / ADMIN_PORT / WEBCHAT_PORT / TZ

# 创建目录并修正属主（自建容器以 uid=1000 运行）
sudo bash scripts/init-data.sh
```

如果你已经有原来的 `role-card.md` / `shared-memory.md`，直接放进 `./data/`：

```bash
cp /path/to/role-card.md      ./data/role-card.md
cp /path/to/shared-memory.md  ./data/shared-memory.md
```

### 3.2 启动

```bash
docker compose up -d --build
docker compose ps
```

四个服务都应为 `healthy`（NapCat 首次启动稍慢，等 30–60 秒）。

### 3.3 登录配置面板

```bash
docker compose logs admin | grep 初始密码
```

打开 `http://<服务器IP>:8080`，用日志里的 16 位初始密码登录，然后到 **运维 → 修改密码** 立即改掉。

> 忘记密码：`docker compose exec -u 1000 admin node reset-password.mjs`，会输出新的随机密码。

### 3.4 配置 AI

**AI 设置**：

- Base URL：`https://api.deepseek.com`（或你的 OpenAI 兼容地址）
- API Key：`sk-...`
- 模型：`deepseek-chat`
- 点 **测试连接**，应显示 `HTTP 200 · xxxms · 返回…`
- 点 **保存 AI 设置**

### 3.5 配置 NapCat 并扫码

NapCat WebUI 只绑定服务器本机，推荐 SSH 隧道：

```bash
ssh -L 6099:127.0.0.1:6099 user@<服务器IP>
```

本地浏览器打开 `http://127.0.0.1:6099`，WebUI 登录 Token 就是 `.env` 里的
`NAPCAT_WEBUI_TOKEN`。

1. 在 NapCat 中登录 QQ（扫码）。
2. `MODE=ws` 已在首次启动时生成 `onebot11.json`（正向 WS，端口 3001）。
   打开 **网络配置 → WebSocket 服务器** 确认：
   - 启用：是
   - Host：`0.0.0.0`
   - Port：`3001`
   - Token：建议再填一个随机串（不要用空 token）
   - 消息格式：`array`（OneBot v11）
3. 保存并重启 NapCat 的网络配置。

回到配置面板 **QQ 设置**：

- NapCat WS 地址：`ws://napcat:3001`
- Access Token：上面填的随机串
- 机器人自身 QQ：可留空，登录后自动回填
- 允许的 UIN 白名单：一行一个，**强烈建议填写**（留空 = 不限制）
- 点 **测试连接**，应返回在线 QQ 号
- 点 **保存 QQ 设置**

### 3.6 验证

用白名单内 QQ 私聊机器人，应收到回复。面板 **总览** 会显示：

- NapCat：在线
- Bridge：在线
- QQ 登录：QQ 号 + 昵称
- DeepSeek 调用次数 / 最近错误

### 3.7 网页聊天（可选）

webchat 只映射到服务器本机：

```bash
ssh -L 3002:127.0.0.1:3002 user@<服务器IP>
```

本地打开 `http://127.0.0.1:3002`。

---

## 4. 面板功能

| 页面 | 内容 |
|---|---|
| 总览 | 三服务健康、QQ 登录、DeepSeek 调用/错误、磁盘、版本、运行时长 |
| AI 设置 | base_url、apiKey（掩码）、model、temperature、max_tokens、测试连接 |
| QQ 设置 | WS 地址、access token、自身 QQ、UIN 白名单、群聊开关/群号、主动消息 |
| TTS 设置 | 豆包 apiKey/voiceId/resource、edge-tts 开关与音色、试听 |
| 人格与记忆 | 在线编辑 role-card.md / shared-memory.md，保存前自动备份；清空历史需二次确认 |
| 表情库 | 列出 /data/stickers，上传（≤2MB，自动压 512×512）、删除 |
| 抖音自动化 | 总开关 + watch / reply-comments / dynamic / mention，默认全关，红字风险提示 |
| 日志 | 选择服务、最近 N 行、关键词过滤、自动刷新 |
| 运维 | 重启 bridge/webchat、配置导出（打码/完整）、导入、修改密码 |

所有 `/api/*` 都需要登录后的 HttpOnly Cookie（24 小时）。密码用 scrypt 哈希，存
`/data/config.json`，面板与 API 都不会回显明文密钥。

---

## 5. 数据目录

```
data/
├── config.json            # 全部配置（含密钥，权限 1000:1000）
├── role-card.md           # 人格
├── shared-memory.md       # 共同记忆
├── history.json           # QQ 聊天历史
├── web-history.json       # 网页聊天历史
├── stickers/
│   ├── *.png              # 表情
│   └── mine/*.png         # 聊天中自动收藏的表情
├── images/                # 收到的图片
├── drawn/                 # AI 画的图
├── backup/                # 配置 / 人格 / 记忆的时间戳备份
├── logs/                  # bridge.log / webchat.log / admin.log 等，按天切分
├── state/                 # 状态、统计、重启标志、主动消息状态
├── napcat/config/         # NapCat 配置
├── napcat/QQ/             # QQ 登录数据（请务必备份）
├── napcat/logs/           # NapCat 日志
└── napcat/plugins/
```

> `data/` 必须可由 uid=1000 写入。`scripts/init-data.sh` 会执行 chown。
> 备份时请整体打包 `data/`，尤其是 `data/napcat/QQ`（重新扫码很麻烦）。

---

## 6. 配置热加载与重启

- 面板保存配置后，admin 会调用 bridge `:3010/reload`、webchat `:3002/reload`；
  同时两个进程每 2 秒检查 `config.json` 的 mtime，变化后写日志
  `config reloaded (file change)`。**不需要重启容器**。
- QQ WS 地址 / token 变化时 bridge 会自动断开重连。
- 面板「一键重启」写入 `/data/state/restart-{bridge,webchat}.flag`，
  对应进程检测到后退出，由 compose `restart: unless-stopped` 拉起。
- `watchdog.ps1` 已删除，进程守护交给 compose。

---

## 7. 日志

- `/data/logs/bridge.log`、`webchat.log`、`admin.log`
- 辅助脚本：`notify.log`、`watch.log`、`dynamic.log`、`reply-comments.log`、`mention.log`、
  `learn.log`、`research.log`、`diary.log`、`share.log`、`signature.log`、`balance.log`、
  `proactive-slot.log`
- 按天切分：当天写 `xxx.log`，跨天自动改名为 `xxx-YYYY-MM-DD.log`
- 保留 7 天；单文件达到 5MB 时立即切分
- 面板「日志」页可直接看最近 500 行并过滤

---

## 8. 可选定时任务

以下脚本不在 compose 常驻，按需用宿主机 cron 调用（示例）：

```cron
# 每天 01:00 睡觉提醒；10:00 起床；11:00；13:30；19:00
0 1  * * * cd /opt/qqbridge && docker compose exec -T bridge node proactive-slot.mjs sleep
0 10 * * * cd /opt/qqbridge && docker compose exec -T bridge node proactive-slot.mjs wake
0 11 * * * cd /opt/qqbridge && docker compose exec -T bridge node proactive-slot.mjs awake
30 13 * * * cd /opt/qqbridge && docker compose exec -T bridge node proactive-slot.mjs lunch
0 19 * * * cd /opt/qqbridge && docker compose exec -T bridge node proactive-slot.mjs dinner

# 每天 23:30 写日记
30 23 * * * cd /opt/qqbridge && docker compose exec -T bridge node diary.mjs

# 每周一/四 20:00 自习
0 20 * * 1,4 cd /opt/qqbridge && docker compose exec -T bridge node learn.mjs

# 每天 09:00 查余额
0 9 * * * cd /opt/qqbridge && docker compose exec -T bridge node balance.mjs
```

抖音自动化（`watch.mjs` / `reply-comments.mjs` / `dynamic.mjs` / `mention.mjs`）
需要容器外有一个已登录抖音的 Chrome 开启 CDP（默认 `http://127.0.0.1:9227`），
并在面板 **抖音自动化** 同时打开总开关和对应子开关。默认关闭，风险自负。

---

## 9. 常见故障排查

| 现象 | 排查 / 处理 |
|---|---|
| `docker compose ps` 有服务 unhealthy | `docker compose logs <svc>`；多为 `/data` 权限问题，执行 `sudo chown -R 1000:1000 ./data` |
| 面板打不开 8080 | 云安全组放行 8080；`ss -lntp \| grep 8080`；admin 日志 |
| NapCat 容器反复重启 | 确认 `.env` 已设置 `NAPCAT_WEBUI_TOKEN`；确认 `data/napcat/config`、`data/napcat/QQ` 存在且可写；查看 `docker compose logs napcat` |
| 想给 NapCat 也上非 root | 官方镜像 entrypoint 依赖 root，需换支持非 root 的等效镜像或自建入口，然后恢复 compose 里的 `user`/`read_only`/`cap_drop` |
| 面板「测试 QQ」失败 | 检查 NapCat 是否开启 WS、Host 是否 `0.0.0.0`、端口 3001、Token 是否一致；`docker compose exec bridge node -e "fetch('http://napcat:3001')"` 看连通性 |
| QQ 收到消息但不回复 | 白名单没加对方 QQ；`docker compose logs bridge` 看 `ignored stranger`；selfId 是否正确回填 |
| AI 测试 401 | API Key 无效/过期；Base URL 是否多写 `/v1`（系统会自动补 `/chat/completions`） |
| 保存配置后没生效 | 看 bridge 日志是否有 `config reloaded`；admin 日志里 `/reload` 是否 timeout（bridge 未 healthy） |
| TTS 没有声音 | 豆包 Key/voiceId 不完整时会自动走 edge-tts；确认容器能访问外网；`docker compose exec bridge python3 -m edge_tts --list-voices` |
| 上传表情失败 | 镜像内 ffmpeg 是否正常：`docker compose exec admin ffmpeg -version`；图片是否 ≤2MB |
| 面板日志空白 | 对应服务还没产生日志；换 bridge/admin 再看 |
| 忘记面板密码 | `docker compose exec -u 1000 admin node reset-password.mjs` |
| 时区不对 | `.env` 里 `TZ=Asia/Shanghai`，重启容器 |
| 修改端口 8080 | `.env` 的 `ADMIN_PORT=18080`，`docker compose up -d` |

---

## 10. 安全说明

- 镜像不含任何密钥、token、QQ 号；全部运行时写入 `/data/config.json`（权限 600，备份同样 600）
- 面板与 API 不回显明文密钥；密钥输入框只显示 `sk-****后四位`
- 密码 scrypt 哈希；登录 Cookie HttpOnly + SameSite=Strict；登录失败 10 分钟 5 次限流
- webchat 的 `/history` 与 WebSocket 需要会话 Cookie；`/sticker/` 已做 `path.resolve` 前缀校验
- **自建容器**（bridge / webchat / admin）：`user 1000`、`read_only`、`tmpfs /tmp`、`cap_drop ALL`、`no-new-privileges`
- **NapCat 例外**：官方镜像的 entrypoint 需要 root 执行 `usermod/chown/gosu`，否则无法启动。
  该入口最终会用 `gosu` 把 QQ/NapCat 业务进程降权到 uid=1000 的 `napcat` 用户；只有初始化
  入口进程是 root。因此这一个第三方容器保留可写根文件系统（仍保留 `tmpfs /tmp`、
  `no-new-privileges`、内存/CPU 限制）。若你换成支持非 root 的等效 NapCat 镜像，
  可在 compose 中恢复 `user: "1000:1000"`、`read_only: true`、`cap_drop: [ALL]`。
- NapCat WebUI 6099 只绑定 127.0.0.1；webchat 3002 只绑定 127.0.0.1
- 唯一对外端口是 8080；建议前面再套 Nginx/Caddy 做 HTTPS 与访问控制

---

## 11. 升级

```bash
cd /opt/qqbridge
docker compose down
git pull            # 或覆盖新代码
sudo bash scripts/init-data.sh   # 确认权限
docker compose up -d --build
```

配置、历史、记忆、表情都在 `./data`，不会因重建镜像丢失。

---

## 12. 目录结构

```
.
├── admin.mjs              # 配置面板 + REST API（8080）
├── bridge.mjs             # QQ 聊天桥
├── server.mjs             # 网页聊天（3002）
├── config.mjs             # 路径常量 / 配置 / 日志 / 密码 / 原子写
├── tts.mjs                # 豆包 → edge-tts 降级链
├── volc-tts.mjs           # 豆包语音
├── notify.mjs             # QQ 通知（可选抖音兜底）
├── sing-her.mjs           # 语音唱歌
├── balance.mjs / diary.mjs / learn.mjs / research2.mjs / share.mjs / signature.mjs
├── proactive-slot.mjs
├── watch.mjs / reply-comments.mjs / dynamic.mjs / mention.mjs   # 默认禁用
├── reset-password.mjs
├── healthcheck.mjs
├── web/index.html         # 网页聊天前端
├── web/admin/index.html   # 配置面板单页
├── seed/                  # 初始 role-card / shared-memory
├── scripts/init-data.sh
├── scripts/acceptance.sh  # 验收脚本
├── Dockerfile
├── docker-compose.yml
├── .env.example
├── CHANGES.md             # 改动清单
└── ACCEPTANCE.md          # 验收记录 / 目标服务器实测步骤
```

---

## 13. 关于原项目

业务逻辑（人格 prompt、记忆结构、消息处理、TTS/绘图降级链）保持不变，仅做配置化与安全加固。
原 README 保留在 `README.original.md`。
