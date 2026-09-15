FROM docker:27-cli

# 基于官方 docker CLI 镜像（已含 docker 命令），只补 git
RUN apk add --no-cache git openssh-client

WORKDIR /app
COPY updater/server.mjs ./server.mjs

EXPOSE 8765
CMD ["node", "server.mjs"]
