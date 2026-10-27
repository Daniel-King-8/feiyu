#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."
if [ -f .env ]; then
  set -a
  # shellcheck disable=SC1091
  . ./.env
  set +a
fi
DATA_DIR="${DATA_DIR:-./data}"

echo "[init-data] 准备目录：$DATA_DIR"
mkdir -p \
  "$DATA_DIR/napcat/config" \
  "$DATA_DIR/napcat/QQ" \
  "$DATA_DIR/napcat/plugins" \
  "$DATA_DIR/napcat/logs" \
  "$DATA_DIR/stickers/mine" \
  "$DATA_DIR/images" \
  "$DATA_DIR/drawn" \
  "$DATA_DIR/backup" \
  "$DATA_DIR/logs" \
  "$DATA_DIR/state"

if [ ! -f "$DATA_DIR/role-card.md" ]; then
  cp seed/role-card.md "$DATA_DIR/role-card.md"
  echo "[init-data] 已写入默认 role-card.md（可替换为你原有的人格文件）"
fi
if [ ! -f "$DATA_DIR/shared-memory.md" ]; then
  : > "$DATA_DIR/shared-memory.md"
fi
if [ ! -f "$DATA_DIR/config.json" ]; then
  echo "[init-data] config.json 尚未创建，首次启动 admin 时自动生成"
fi

if [ "$(id -u)" -eq 0 ]; then
  chown -R 1000:1000 "$DATA_DIR"
  echo "[init-data] 已 chown 1000:1000 $DATA_DIR"
else
  echo "[init-data] 当前不是 root；若容器报 Permission denied，请执行："
  echo "            sudo chown -R 1000:1000 $DATA_DIR"
fi

echo "[init-data] 完成。"
