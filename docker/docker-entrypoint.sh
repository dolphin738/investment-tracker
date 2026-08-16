#!/bin/sh
# 容器启动入口：先应用数据库迁移，再启动后端（同源 serve 前端 + SPA 深链回退）
# 数据库须由编排（docker-compose / k8s）保证就绪后再启动本容器。
set -e

echo "-> 应用数据库迁移 (alembic upgrade head)"
uv run alembic upgrade head

echo "-> 启动后端 uvicorn (0.0.0.0:3000)"
exec uv run uvicorn app.main:app --host 0.0.0.0 --port 3000
