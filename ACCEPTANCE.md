# 验收记录

> 说明：开发环境是 Windows 11，**没有 Docker / docker compose / ffmpeg / edge-tts**，
> 因此依赖容器的验收项无法在本机伪造输出。本文件分为两部分：
>
> 1. 当前环境**真实执行**的本地集成测试（Node 服务、面板、模拟 NapCat）；
> 2. 验收标准 1–12 在目标 Linux 服务器上的逐条执行命令与当前状态。
>
> 目标服务器执行：`ADMIN_PASSWORD='...' TEST_API_KEY='sk-...' RUN_STOP_TEST=1 bash scripts/acceptance.sh`

---

## 一、当前环境

| 项 | 值 |
|---|---|
| OS | Windows 11 Home China 10.0.26200 |
| Node | v22.16.0 |
| npm | 10.9.2 |
| Docker | 未安装（`docker: command not found`） |
| ffmpeg | 未安装 |
| edge-tts | 未安装 |
| 测试数据目录 | `.testdata/`（已被 `.gitignore` / `.dockerignore` 排除） |
| 测试端口 | admin 18080、webchat 13002、bridge control 13010、mock NapCat 13001 |

---

## 二、静态检查（真实执行）

```console
$ for f in *.mjs; do node --check "$f"; done
checked 21 mjs files OK

$ node --check .testdata/admin-ui.js
admin-ui.js OK
$ node --check .testdata/web-ui.js
web-ui.js OK

$ python -c "import yaml; d=yaml.safe_load(open('docker-compose.yml',encoding='utf-8')); print(sorted(d['services']))"
services: ['admin', 'bridge', 'napcat', 'webchat']

$ grep -RInE "sk-[A-Za-z0-9_-]{12,}" --exclude-dir=node_modules --exclude-dir=.testdata .
无 sk- 长密钥

$ grep -RInE "123456789|987654321|REDACTED_QQ_TOKEN" --exclude-dir=node_modules --exclude-dir=.testdata .
（仅 CHANGES.md 中描述“已删除”的文字，无源码硬编码）
```

---

## 三、配置面板集成测试（真实执行）

启动：

```console
$ QQBRIDGE_DATA_DIR=... PORT=18080 node admin.mjs
[admin] 首次启动：管理员初始密码是 Wvd2YTnrZaxqdvEh （登录后请立即修改）
[admin] admin panel listening on 127.0.0.1:18080
[admin] data dir: ...\.testdata
[admin] version: 1.0.0
```

接口测试脚本输出：

```console
$ node .testdata/api-test.mjs
login: 200 { ok: true, data: { mustChangePassword: true } }
memory put: { ok: true, data: { saved: true, length: 17 } } roundtrip equal: true
memory content: "你是测试人格。\n第二行：鲸鱼与海。"
stickers: 200 0
sticker traversal: 404 表情不存在
sticker delete traversal: 404 表情不存在
config save: 200 sk-****abcd [ 123456789, 987654321 ]
status: 200 qq allow count: 2 auto: false
logs: 200 matched lines: 5
export masked: 200 sk-****abcd to****-xyz false
import: 200 sk-****abcd [ 123456789 ]
password change: 200 { ok: true, data: { changed: true } }
re-login new password: 200 { ok: true, data: { mustChangePassword: false } }
old password rejected: 401 密码错误
```

覆盖点：

- 未登录 `GET /api/config` → `401 {"ok":false,"error":"未登录或会话已过期"}`
- 错误密码 → 401；正确密码 → 200 + HttpOnly Cookie
- 配置返回掩码 `sk-****abcd` / `to****-xyz`，不回显明文
- 掩码回传保存后，`config.json` 内真实密钥保持不变
- 部分配置保存不会清空未提交的字段（曾发现并修复 `allowUins` 被空数组覆盖的 bug）
- 人格 UTF-8 中文保存/读取完全一致
- 保存前自动备份到 `.testdata/backup/时间戳_memory_role-card.md`
- 表情路径穿越 `../../config.json` GET/DELETE 均为 404
- 导出默认打码；`?secrets=full` 返回明文；两者都不含 `auth.passwordHash` / `internalToken`
- 修改密码后旧密码 401、新密码 200

### 面板 UI（无头 Chrome 实测）

```console
$ node .testdata/ui-test.mjs
title: 大肥鱼 · 控制台
login visible: true
app visible: true
overview qq: 999000111
overview calls: 3 次调用
view ai: true
view qq: true
view tts: true
view memory: true
view stickers: true
view automation: true
view logs: true
view ops: true
view overview: true
log meta: bridge · 32 行 · 文件：bridge.log
role text length: 17
toast: 日志已刷新
errors: [ 'console: Failed to load resource: the server responded with a status of 401 (Unauthorized)' ]
```

> 唯一的 401 控制台信息来自未登录时页面启动探测 `/api/config`，属于预期行为。
> 截图：`docs/screenshots/ui-login.png`（其余含测试 QQ/日志的截图已从交付物移除）。

---

## 四、网页聊天（真实执行）

```console
$ curl -s -w "\n%{http_code}\n" http://127.0.0.1:13002/healthz
{"ok":true,"service":"webchat"}
200

$ curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:13002/history
401
$ curl -s -b cookies.txt -o /dev/null -w "%{http_code}\n" http://127.0.0.1:13002/history
200

$ curl -s -o /dev/null -w "%{http_code}\n" "http://127.0.0.1:13002/sticker/..%2F..%2Fconfig.json"
404

$ curl -s -X POST -H "x-internal-token: <正确令牌>" http://127.0.0.1:13002/reload
{"ok":true,"data":{"reloaded":true}} [200]
$ curl -s -X POST -H "x-internal-token: bad" http://127.0.0.1:13002/reload
{"ok":false,"error":"unauthorized"} [401]
```

WebSocket：

```console
NO_COOKIE_HTTP 401
WS_OPEN
WS_REPLY {"type":"reply","text":"诶，我刚刚走神了一下，你再说一遍嘛 (´･ω･`)","sticker":null,"audio":null}
```

（因为没有真实 DeepSeek Key，模型 401 后走了原有兜底文案；说明消息管线、历史落盘、
错误处理均正常。）

---

## 五、bridge + 模拟 NapCat（真实执行）

用 `ws` 起了一个 OneBot v11 模拟端，验证 bridge 的连接、登录信息、白名单、消息处理、
模型调用失败降级、发送私聊消息全链路：

```console
$ node .testdata/mock-napcat.mjs
mock napcat listening 13001
bridge connected
recv action: get_login_info
recv action: send_private_msg
SEND_PRIVATE 123456789 诶嘿，我刚刚走神了一下下，你再说一遍嘛 (๑•̀ㅂ•́)و✧

$ tail .testdata/logs/bridge.log
[INFO] config reloaded (file change)
[INFO] qq connection settings changed, reconnecting
[INFO] ws open
[INFO] self id 999000111 (MockBot)
[INFO] <- 123456789: 你好，测试一下
[ERROR] model error HTTP 401 Authentication Fails, Your api key: ****abcd is invalid
[INFO] -> 123456789: 诶嘿，我刚刚走神了一下下，你再说一遍嘛 (๑•̀ㅂ•́)و✧
```

状态文件：

```json
{
  "service": "bridge",
  "online": true,
  "wsUrl": "ws://127.0.0.1:13001",
  "selfId": 999000111,
  "nickname": "MockBot",
  "lastUserAt": 1792947791540,
  "lastError": "",
  "updatedAt": "2026-10-25T17:03:11.540Z"
}
```

配置热加载：

```console
$ docker-equivalent: 面板保存 ai.temperature 后 2 秒
[2026-10-25T17:02:32.907Z] [INFO] config reloaded (file change)

$ curl -X POST -H "x-internal-token: <正确令牌>" http://127.0.0.1:13010/reload
{"ok":true,"data":{"reloaded":true}} [200]
[2026-10-25T17:02:44.842Z] [INFO] config reloaded (admin)
```

### 5.1 语音回复（豆包未配置 → edge-tts 降级）

模拟端发送「用语音说句话」，bridge 走 TTS 降级链并发送 `record` 段：

```console
$ node .testdata/mock-voice.mjs
mock voice napcat listening 13003
bridge connected
recv action: get_login_info
recv action: send_private_msg
SEND_PRIVATE 123456789 [record base64 35145 bytes]

$ tail .testdata/logs/bridge.log
[INFO] <- 123456789: 用语音说句话
[ERROR] model error HTTP 401 Authentication Fails ...
[INFO] -> 123456789: [voice] s-1792948306535-0.mp3
```

### 5.2 模型引用表情并发出

用本地 mock OpenAI 接口返回 `[[图片:测试表情]]`，模拟端捕获到先文本、后图片两条消息：

```console
$ node .testdata/mock-ai.mjs
mock AI listening 13004
AI request POST /chat/completions bytes 1397
system has sticker list: true

$ node .testdata/mock-sticker.mjs
bridge connected
recv action: get_login_info
recv action: send_private_msg
SEND_PRIVATE 123456789 给你看个表情
recv action: send_private_msg
SEND_PRIVATE 123456789 [image base64 2709 bytes]

$ tail .testdata/logs/bridge.log
[INFO] <- 123456789: 发个表情看看
[INFO] -> 123456789: 给你看个表情
[INFO] -> 123456789: [image] 测试表情.png
```

这验证了：表情列表进入 system prompt → 模型输出标签 → 标签清理 → 找到表情文件 → 发送图片。

### 5.3 修改人格后下一次回复生效

通过面板 API 把 role-card 改为 `人格测试-PERSONA-XYZ。你是新人格。`，重启模拟连接后再发消息；
mock 模型从 system prompt 中检出了新人格：

```console
persona in system prompt: false   # 修改前
persona in system prompt: true    # 修改后
user text: 你还记得自己是谁吗
SEND_PRIVATE 123456789 新人格生效啦
```

### 5.4 断开 NapCat 后 bridge 不崩、自动重连

```console
$ kill <mock-napcat-pid>
$ kill -0 <bridge-pid> && echo "bridge still alive"
bridge still alive
$ curl http://127.0.0.1:13010/healthz
{"ok":true,"service":"bridge","online":false}
$ cat state/bridge-status.json
status online= false lastError= connect ECONNREFUSED 127.0.0.1:13007

$ # 重新启动模拟 NapCat 后
status online= true wsUrl= ws://127.0.0.1:13007 updated= ...
[INFO] ws open
[INFO] self id 999000444 (MockPersonaBot)
```

容器场景对应 `docker compose stop napcat / start napcat`，验收脚本
`RUN_STOP_TEST=1` 会自动执行。

---

## 六、抖音自动化默认关闭（真实执行）

默认（`automation.enabled=false`）：

```console
$ node watch.mjs
[watch] douyin automation disabled by design
$ node dynamic.mjs
[dynamic] douyin automation disabled by design
$ node reply-comments.mjs
[reply-comments] douyin automation disabled by design
$ node mention.mjs
[mention] douyin automation disabled by design
```

面板打开总开关 + watch 后再运行：

```console
$ node watch.mjs
[watch] automation enabled: watch starting (风险自负)
browserType.connectOverCDP: connect ECONNREFUSED 127.0.0.1:9227
```

说明默认状态确实是关闭的；打开后才会进入自动化分支。

---

## 七、DeepSeek / TTS / 表情上传（真实执行）

### 7.1 DeepSeek（无有效密钥）

```console
$ curl -X POST .../api/test/ai -d '{"apiKey":"sk-****abcd",...}'
{"ok":false,"error":"Authentication Fails, Your api key: ****abcd is invalid ...",
 "data":{"latencyMs":353,"status":401}} [502]
```

- DeepSeek 网络可达，请求/耗时/错误回传链路正常；填入真实 Key 后应返回 200。

### 7.2 edge-tts 试听

本机用 `uv` 临时安装了 edge-tts（仅为测试，不进入交付物），通过面板接口合成固定文本：

```console
$ curl -b cookies.txt -X POST -H 'content-type: application/json' -d '{}' \
       -o tts-test.mp3 -w "HTTP %{http_code} bytes=%{size_download} type=%{content_type}\n" \
       http://127.0.0.1:18080/api/test/tts
HTTP 200 bytes=25776 type=audio/mpeg
```

- 豆包未配置时会自动降级到 edge-tts，返回的 mp3 可播放。
- 容器内 Dockerfile 已安装 edge-tts，目标服务器无需额外操作。

### 7.3 表情上传 / 列表 / 读取 / 删除

本机用 `imageio-ffmpeg` 临时提供 ffmpeg（仅测试，不进入交付物）：

```console
upload 200 {"ok":true,"data":{"name":"测试表情","size":2024}}
list [{"name":"测试表情","bucket":"main","size":2024,"mtime":...,"url":"/api/stickers/%E6%B5%8B%E8%AF%95%E8%A1%A8%E6%83%85"}]
image 200 image/png 2024
delete 200 {"ok":true,"data":{"deleted":"测试表情"}}
```

- multipart 解析、2MB 限制、ffmpeg 压缩到 512×512、列表、鉴权读取、删除全部通过。
- “模型在回复中引用表情并发出”需要真实 QQ + 模型，目标服务器手工验证。

---

## 八、验收标准 1–12 状态

| # | 验收项 | 当前状态 | 目标服务器命令 |
|---|---|---|---|
| 1 | `docker compose up -d` 后四服务 healthy | 本机无 Docker，未执行 | `docker compose ps` / `bash scripts/acceptance.sh` 第 1 项 |
| 2 | 8080 登录页 + 日志初始密码可登录 | **本地等价流程通过**（18080）；容器待验 | 验收脚本第 2 项 |
| 3 | 真实 DeepSeek Key 测试连接 200 + 耗时 | 未执行（无 Key）；错误路径已通过 | `TEST_API_KEY=sk-... bash scripts/acceptance.sh` 第 3 项 |
| 4 | 保存后 bridge 日志出现 `config reloaded` | **通过**（本地实测） | 验收脚本第 4 项 |
| 5 | NapCat 扫码后总览显示在线 | 模拟 NapCat 通过；真实扫码待验 | 验收脚本第 5 项 + 手工扫码 |
| 6 | 白名单 QQ 私聊收到 AI 文本回复 | **模拟全链路通过**（mock NapCat + mock AI）；真实 Key/QQ 待验 | 手工 |
| 7 | 修改 persona 后下一次回复体现 | **本地通过**（mock 模型检出 system prompt 中的新人格）；真实模型待验 | 手工 |
| 8 | 上传表情并被模型引用发出 | **本地通过**（上传/512 压缩/列表/读取/删除 + mock 模型引用后发出图片） | 手工复核真实 QQ |
| 9 | 停 napcat 后 bridge 不崩、面板离线、重启重连 | **本地通过**（mock NapCat 停机/重启）；容器停机待验 | `RUN_STOP_TEST=1 bash scripts/acceptance.sh` |
| 10 | 自动化开关默认关闭 | **通过**（本地实测） | 验收脚本第 10 项 |
| 11 | `docker exec ... whoami` = app | 本机无 Docker；bridge/webchat/admin 已设 uid=1000（NapCat 官方镜像例外，见 README） | 验收脚本第 11 项 |
| 12 | `docker history` 无密钥痕迹 | 源码扫描通过；镜像待验 | 验收脚本第 12 项 |

> 未执行项不是“通过”，请在目标服务器按脚本输出补全记录。验收脚本会打印
> `PASS / FAIL / SKIP` 汇总。

---

## 九、目标服务器执行步骤

```bash
cd /opt/qqbridge
cp .env.example .env
# 编辑 .env：至少把 NAPCAT_WEBUI_TOKEN 改成随机串
sudo bash scripts/init-data.sh
docker compose up -d --build
docker compose ps

# 首次登录密码
docker compose logs admin | grep 初始密码

# 自动化验收（1/2/4/9/10/11/12；3 需要真实 Key）
ADMIN_PASSWORD='面板密码' \
TEST_API_KEY='sk-真实key' \
RUN_STOP_TEST=1 \
bash scripts/acceptance.sh

# 手工项 5-8：
#   5) SSH 隧道开 6099 → NapCat 扫码 → 面板 QQ 设置测试连接
#   6) 白名单 QQ 私聊
#   7) 面板改 role-card 保存 → 再私聊
#   8) 面板上传一张 png → 私聊让它发表情
```

### 必须在目标服务器贴回的真实输出

```bash
docker compose ps
docker inspect -f '{{.Name}} {{.State.Health.Status}}' qqbridge-napcat qqbridge-bridge qqbridge-webchat qqbridge-admin
docker compose exec -T bridge whoami
docker compose logs --tail=50 bridge | grep -E 'config reloaded|ws open|self id'
docker history --no-trunc qqbridge:1.0.0 | grep -i 'sk-' || echo 'no key found'
```
