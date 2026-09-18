# ---- deps ----
FROM node:22-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# ---- runtime ----
FROM node:22-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production
# 玄枢模块工具脚本依赖：python3（排盘/抽牌）+ lunar_python（奇门历法换算）
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 python3-pip \
  && pip3 install --break-system-packages --no-cache-dir lunar_python \
  && apt-get clean && rm -rf /var/lib/apt/lists/*
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src
COPY knowledge ./knowledge
COPY scripts ./scripts
COPY assets ./assets
RUN mkdir -p /app/data && chown -R node:node /app
USER node
EXPOSE 8080
CMD ["node", "src/index.js"]
