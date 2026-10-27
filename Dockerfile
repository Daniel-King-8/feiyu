# syntax=docker/dockerfile:1

# ---------- builder：只装生产依赖 ----------
FROM node:22-slim AS builder
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund
COPY . .
# 构建期语法自检，任何模块写错直接让镜像构建失败
RUN for file in *.mjs; do node --check "$file"; done

# ---------- runtime ----------
FROM node:22-slim AS runtime

ENV NODE_ENV=production \
    TZ=Asia/Shanghai \
    HOME=/tmp \
    XDG_CACHE_HOME=/tmp/.cache \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

# ffmpeg 用于表情压缩/视频抽帧/音频拼接；edge-tts 作为豆包 TTS 的降级链
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        ffmpeg python3 python3-pip ca-certificates \
    && pip3 install --no-cache-dir --break-system-packages \
        -i https://pypi.tuna.tsinghua.edu.cn/simple edge-tts \
    && apt-get purge -y python3-pip \
    && apt-get autoremove -y \
    && rm -rf /var/lib/apt/lists/* /root/.cache

WORKDIR /app
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/*.mjs ./
COPY --from=builder /app/web ./web

RUN groupadd --gid 1000 app \
    && useradd --uid 1000 --gid 1000 --create-home --shell /usr/sbin/nologin app \
    && mkdir -p /data /tmp/qqbridge \
    && chown -R app:app /app /data /home/app

USER app
EXPOSE 8080 3002 3010

HEALTHCHECK --interval=30s --timeout=5s --start-period=25s --retries=3 \
    CMD ["node", "healthcheck.mjs"]

CMD ["node", "bridge.mjs"]
