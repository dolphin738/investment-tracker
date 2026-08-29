# 投资收益统计系统 — 单镜像部署（FastAPI 后端同源 serve 前端 + SPA 深链回退）
# 构建：docker build -f docker/Dockerfile -t invest-tracker:latest .
# 运行（开发）：docker run -d -p 3000:3000 --env-file backend/.env invest-tracker:latest
# 运行（生产）：docker run -d -p 3000:3000 --env-file docker/.env.production invest-tracker:latest
#   → 生产 env 见 docker/.env.production.example（务必含 STRICT_SECURITY=1 与强随机密钥）
#
# 关键点：前端 API 地址为相对路径 /api，与后端同源，故单进程即可同时
# 提供 /api 与前端资源，深链刷新由后端 catch-all 路由回退 index.html。
#
# 前端：web/ = Vue 3 正式版（Vite + Vue 3 + Tailwind 3 + shadcn-vue）。
# 2026-08-18 正式切换：React 版已删除，web/ 为唯一前端目录。

# ---- 阶段 1：前端构建 ----
FROM node:22-alpine AS frontend
WORKDIR /web
# 启用 pnpm（与 web/pnpm-lock.yaml 一致；web 为独立 pnpm workspace）
RUN corepack enable
# 仅复制依赖清单以利用层缓存
COPY web/package.json web/pnpm-lock.yaml web/pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile
COPY web/ ./
RUN pnpm build
# 构建产物位于 /web/dist

# ---- 阶段 2：后端运行 ----
FROM python:3.13-slim AS backend
WORKDIR /app
ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1

# 安装 uv（与 dev.ps1 的依赖管理一致）
RUN pip install --no-cache-dir uv

# 复制后端依赖清单并安装（仅生产依赖，排除 dev extras）
COPY backend/pyproject.toml backend/uv.lock ./
RUN uv sync --frozen --no-dev

# 复制应用源码（含 alembic 迁移）
COPY backend/ ./

# 复制前端构建产物；由后端同源 serve（见 app/core/config.py 的 FRONTEND_DIR）
COPY --from=frontend /web/dist ./web/dist

# 启用前端托管：指向构建产物目录
ENV FRONTEND_DIR=/app/web/dist

COPY docker/docker-entrypoint.sh /app/docker-entrypoint.sh
RUN chmod +x /app/docker-entrypoint.sh

EXPOSE 3000
ENTRYPOINT ["/app/docker-entrypoint.sh"]
