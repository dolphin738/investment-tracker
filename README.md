# investment_return_tracker

投资收益统计系统 —— **后端完全 Python 化（零遗留）** 重建项目。

> ⚠️ **硬约束**：`../app` 目录是**只读参考源**。本项目的所有代码从 `app` 复制/参考而来，
> 但**绝不改动或删除 `app` 内的任何文件**。`app` 原样保留，仅作为来源被读取。

## 方案来源

按 `app/scripts/backend-python-migration-feasibility/python-backend-migration-feasibility.html`
（v2.3）推进。目标：后端 100% Python（FastAPI + SQLAlchemy 2.0 + Alembic + PyJWT + bcrypt），
前端（React）从 `app/packages/web` 复制后改造，类型由 FastAPI OpenAPI 经
`openapi-typescript` 生成（取代旧 `@shared` 双份契约）。

## 技术栈

| 层 | 技术 |
|----|------|
| 后端 | FastAPI 0.115 + SQLAlchemy 2.0(async) + asyncpg + Alembic + PyJWT(HS256) + bcrypt |
| 前端 | React + Vite（Phase 5 接入，类型由 OpenAPI 生成） |
| 测试 | pytest + pytest-asyncio + httpx(TestClient) |
| 包管理 | uv（pyproject.toml）；本地用 venv + pip |

## 契约基线（Phase 0 已冻结）

- 统一响应信封：`{ code: 0, data: <原值>, message: "ok" }`；错误：`{ code: <业务码>, data: null|对象, message }`
- 已是信封（带 number 型 `code`，如 upload 手工信封）→ 原样透传，不二次包裹
- `data` 为 `None` → 归一为 `null`
- 金额 `Decimal` → **字符串**序列化（防精度/类型漂移，对齐 Prisma Decimal 行为）
- 业务错误码：`1001/1002/1003/1004/1006/1007/1008/1009/2000/3001/5000`，与 `app` shared 一致
- JWT：`HS256`，payload `{ sub, email }`；bcrypt cost=10（哈希跨语言兼容）
- 全局前缀 `/api`；CORS 放行 `http://localhost:5173`；Swagger `/api/docs`；静态 `/api/uploads`

## 目录结构

```
investment_return_tracker/
├── backend/                # Python 后端（FastAPI）
│   ├── app/
│   │   ├── core/           # config / enums / exceptions / envelope / security / types
│   │   ├── routers/        # 业务路由（每个 router 用 EnvelopeRoute）
│   │   ├── models/         # SQLAlchemy 模型（Phase 1）
│   │   └── main.py         # 应用入口
│   ├── tests/              # pytest 冒烟 + 契约测试
│   └── pyproject.toml
├── web/                    # React 前端（Phase 5 接入）
└── docs/                   # openapi-baseline.phase0.json 等
```

## 本地运行（Phase 0）

```bash
cd backend
python -m venv .venv && source .venv/bin/activate
pip install -e ".[dev]"        # 或 uv sync
cp .env.example .env           # 按需修改 JWT_SECRET / DATABASE_URL
pytest                          # 跑契约冒烟测试
uvicorn app.main:app --reload --port 8000
# Swagger: http://localhost:8000/api/docs
```

## 阶段进度

- [x] **Phase 0** — 契约冻结 & 脚手架（信封/错误码/JWT/Decimal/静态/Swagger + 冒烟测试）
- [ ] Phase 1 — 数据层（SQLAlchemy 模型 + Alembic 迁移）
- [ ] Phase 2 — 算法内核（finance_core：XIRR / NAV + 数值 oracle）
- [ ] Phase 3 — 认证与账户
- [ ] Phase 4 — 业务模块（68 端点平移）
- [ ] Phase 5 — 前端类型重生成 + 联调 + 收尾
