# 大肥鱼 - QQ/网页聊天桥（原始说明）

这是一套自用的 AI 伴侣桥接代码，需要你自己准备：

1. Node.js 22+
2. NapCat（QQ 协议端，OneBot v11 WS 服务）
3. DeepSeek API Key（或任意 OpenAI 兼容接口）
4. 火山引擎语音合成（可选，用于她的声音）

## 文件说明
- bridge.mjs       QQ 聊天主程序（人格、记忆、表情、画图、语音）
- notify.mjs       QQ/抖音双通道通知
- server.mjs       网页版聊天后端（默认 3002 端口，WS /ws）
- web/index.html   网页版前端
- proactive-slot.mjs 定时问候（1:00 睡觉 / 10:00 起床 / 11:00 / 13:30 / 19:00）
- watch.mjs 等     抖音相关自动化（需要登录的浏览器）

## 配置
把代码里的密钥换成你自己的；路径按你的系统改。
密钥文件不在包内，需自行创建。
