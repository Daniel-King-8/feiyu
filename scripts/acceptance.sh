#!/usr/bin/env bash
# qqbridge 验收脚本（在部署服务器上、docker-compose.yml 所在目录执行）
# 用法：
#   ADMIN_PASSWORD='你的面板密码' bash scripts/acceptance.sh
#   TEST_API_KEY='sk-...' ADMIN_PASSWORD='...' RUN_STOP_TEST=1 bash scripts/acceptance.sh
set -uo pipefail

cd "$(dirname "$0")/.."

BASE="${ADMIN_URL:-http://127.0.0.1:8080}"
COOKIE="$(mktemp)"
TMP="$(mktemp -d)"
trap 'rm -f "$COOKIE"; rm -rf "$TMP"' EXIT

PASS=0
FAIL=0
SKIP=0
ok()   { echo "  [PASS] $1"; PASS=$((PASS+1)); }
bad()  { echo "  [FAIL] $1"; FAIL=$((FAIL+1)); }
skip() { echo "  [SKIP] $1"; SKIP=$((SKIP+1)); }

command -v docker >/dev/null 2>&1 || { echo "未找到 docker"; exit 1; }
docker compose version >/dev/null 2>&1 || { echo "未找到 docker compose v2"; exit 1; }
command -v curl >/dev/null 2>&1 || { echo "未找到 curl"; exit 1; }
command -v python3 >/dev/null 2>&1 || { echo "未找到 python3（用于解析 JSON）"; exit 1; }

json_get() {
  # json_get <file> <python 表达式，变量名 d>
  python3 - "$1" "$2" <<'PY'
import json,sys
d=json.load(open(sys.argv[1]))
print(eval(sys.argv[2]))
PY
}

echo "============================================================"
echo "1. docker compose ps 四个服务 healthy"
echo "============================================================"
ALL_OK=1
for svc in napcat bridge webchat admin; do
  cid="$(docker compose ps -q "$svc" 2>/dev/null || true)"
  if [ -z "$cid" ]; then
    bad "$svc 容器不存在"
    ALL_OK=0
    continue
  fi
  health="$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$cid" 2>/dev/null || echo unknown)"
  state="$(docker inspect -f '{{.State.Status}}' "$cid" 2>/dev/null || echo unknown)"
  if [ "$state" = "running" ] && [ "$health" = "healthy" ]; then
    ok "$svc: running / healthy"
  else
    bad "$svc: state=$state health=$health"
    ALL_OK=0
  fi
done

echo
echo "============================================================"
echo "2. 登录页与初始密码登录"
echo "============================================================"
if curl -fsS "$BASE/" -o "$TMP/index.html"; then
  if grep -q '登录' "$TMP/index.html"; then ok "GET $BASE/ 返回登录页"; else bad "登录页内容异常"; fi
else
  bad "无法访问 $BASE/"
fi

PASSWORD="${ADMIN_PASSWORD:-}"
if [ -z "$PASSWORD" ]; then
  PASSWORD="$(docker compose logs admin 2>/dev/null | grep -o '初始密码是 [A-Za-z0-9]*' | tail -1 | awk '{print $2}')"
fi
if [ -z "$PASSWORD" ]; then
  skip "未提供 ADMIN_PASSWORD，且日志中未找到初始密码（可能已修改）"
else
  LOGIN_BODY="$(python3 -c 'import json,sys; print(json.dumps({"password": sys.argv[1]}))' "$PASSWORD")"
  code="$(curl -sS -o "$TMP/login.json" -w '%{http_code}' -c "$COOKIE" \
    -X POST -H 'content-type: application/json' \
    --data "$LOGIN_BODY" "$BASE/api/login")"
  if [ "$code" = "200" ] && grep -q '"ok":true' "$TMP/login.json"; then
    ok "密码登录成功"
  else
    bad "密码登录失败（HTTP $code）"
  fi
fi

if [ ! -s "$COOKIE" ]; then
  echo
  echo "未取得登录态，后续 API 检查跳过。"
  echo "结果：PASS=$PASS FAIL=$FAIL SKIP=$SKIP"
  exit 1
fi

echo
echo "============================================================"
echo "3. DeepSeek 测试连接"
echo "============================================================"
if [ -n "${TEST_API_KEY:-}" ]; then
  code="$(curl -sS -o "$TMP/ai.json" -w '%{http_code}' -b "$COOKIE" \
    -X POST -H 'content-type: application/json' \
    --data "{\"apiKey\":\"$TEST_API_KEY\"}" "$BASE/api/test/ai")"
  if [ "$code" = "200" ]; then
    ok "AI 测试 200：$(cat "$TMP/ai.json" | head -c 200)"
  else
    bad "AI 测试失败（HTTP $code）：$(cat "$TMP/ai.json" | head -c 200)"
  fi
else
  skip "设置 TEST_API_KEY 后重跑可自动验证"
fi

echo
echo "============================================================"
echo "4. 保存配置后 bridge 热加载"
echo "============================================================"
curl -sS -b "$COOKIE" -X PUT -H 'content-type: application/json' \
  --data '{"ai":{"temperature":1.0}}' "$BASE/api/config" -o "$TMP/saved.json"
sleep 3
if docker compose logs --since 30s bridge 2>/dev/null | grep -q 'config reloaded'; then
  ok "bridge 日志出现 config reloaded"
else
  bad "bridge 日志未出现 config reloaded"
fi

echo
echo "============================================================"
echo "5. NapCat / QQ 在线状态"
echo "============================================================"
curl -sS -b "$COOKIE" "$BASE/api/status" -o "$TMP/status.json"
if python3 -c 'import json,sys; d=json.load(open(sys.argv[1]))["data"]; sys.exit(0 if d["services"]["napcat"]["online"] else 1)' "$TMP/status.json" 2>/dev/null; then
  ok "面板显示 NapCat 在线"
else
  skip "NapCat 未在线（需要先扫码登录）"
fi
if python3 -c 'import json,sys; d=json.load(open(sys.argv[1]))["data"]; sys.exit(0 if d["qq"]["online"] else 1)' "$TMP/status.json" 2>/dev/null; then
  ok "面板显示 QQ 已登录：$(json_get "$TMP/status.json" 'd["data"]["qq"]["selfId"]')"
else
  skip "QQ 未登录（需要 NapCat 扫码）"
fi

echo
echo "============================================================"
echo "6-8. QQ 私聊 / 人格生效 / 表情发送（需要真实 QQ，人工验证）"
echo "============================================================"
skip "用白名单 QQ 私聊机器人，确认收到文本回复"
skip "面板修改 persona 后保存，再发一条消息确认人格变化"
skip "上传表情并在聊天中触发"

echo
echo "============================================================"
echo "9. 停止 napcat 后 bridge 不崩、面板显示离线"
echo "============================================================"
if [ "${RUN_STOP_TEST:-0}" = "1" ]; then
  docker compose stop napcat >/dev/null
  sleep 4
  curl -sS -b "$COOKIE" "$BASE/api/status" -o "$TMP/status2.json"
  bridge_cid="$(docker compose ps -q bridge)"
  bridge_state="$(docker inspect -f '{{.State.Status}}' "$bridge_cid")"
  if [ "$bridge_state" = "running" ]; then ok "停 napcat 后 bridge 仍 running"; else bad "bridge 状态=$bridge_state"; fi
  if python3 -c 'import json,sys; d=json.load(open(sys.argv[1]))["data"]; sys.exit(0 if not d["services"]["napcat"]["online"] else 1)' "$TMP/status2.json" 2>/dev/null; then
    ok "面板显示 napcat 离线"
  else
    bad "面板仍显示 napcat 在线"
  fi
  docker compose start napcat >/dev/null
  sleep 6
  ok "已重新启动 napcat，等待 bridge 自动重连（请肉眼确认日志 ws open）"
else
  skip "设置 RUN_STOP_TEST=1 可自动执行停机测试"
fi

echo
echo "============================================================"
echo "10. 抖音自动化默认关闭"
echo "============================================================"
auto="$(python3 -c 'import json,sys;d=json.load(open(sys.argv[1]))["data"]["automation"];print(d["enabled"],d["watch"],d["replyComments"],d["dynamic"],d["mention"])' "$TMP/status.json" 2>/dev/null || true)"
echo "  当前 automation: ${auto:-未知}"
if docker compose exec -T bridge node watch.mjs 2>/dev/null | grep -q 'douyin automation disabled by design'; then
  ok "watch.mjs 默认输出 disabled by design"
else
  bad "watch.mjs 未输出默认禁用提示"
fi

echo
echo "============================================================"
echo "11. 非 root 用户"
echo "============================================================"
for svc in bridge webchat admin; do
  who="$(docker compose exec -T "$svc" whoami 2>/dev/null | tr -d '\r')"
  if [ "$who" = "app" ]; then ok "$svc whoami=app"; else bad "$svc whoami=$who"; fi
done

echo
echo "============================================================"
echo "12. 镜像中无密钥痕迹"
echo "============================================================"
if docker history --no-trunc qqbridge:1.0.0 2>/dev/null | grep -Eqi 'sk-[A-Za-z0-9_-]{12,}'; then
  bad "docker history 中发现疑似密钥"
else
  ok "docker history 未发现 sk- 密钥"
fi
if docker run --rm --entrypoint sh qqbridge:1.0.0 -c 'grep -RIlE "sk-[A-Za-z0-9_-]{12,}" /app 2>/dev/null | head' 2>/dev/null | grep -q .; then
  bad "镜像 /app 内发现疑似密钥"
else
  ok "镜像 /app 内未发现密钥"
fi

echo
echo "============================================================"
echo "结果：PASS=$PASS FAIL=$FAIL SKIP=$SKIP"
echo "============================================================"
[ "$FAIL" -eq 0 ]
