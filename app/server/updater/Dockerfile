FROM docker:27-cli

# 基于官方 docker CLI 镜像（已含 docker 命令），补 git 与 node（镜像本身不含 node）
RUN apk add --no-cache git openssh-client nodejs

WORKDIR /app
COPY updater/server.mjs ./server.mjs

EXPOSE 8765
# 基础镜像的 docker-entrypoint.sh 会把首参数当 docker 子命令转发，
# 这里必须用 ENTRYPOINT 直接指定 node；脚本用绝对路径（compose 的 working_dir 是 /workspace）
ENTRYPOINT ["node", "/app/server.mjs"]
