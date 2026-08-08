# 架构设计（investment_return_tracker · 后端真相源）

> 本文档是 **Python 重建项目**的架构唯一真相源（Canonical）。
> 上游参考：`../app/docs/ARCHITECTURE.md`（NestJS 原版，只读参考，本项目的 `app/` 目录绝不动）。
> 金融口径、方案 B 数据架构决策详见 `app/docs/ARCHITECTURE.md` 与 `docs/adr/ADR-001-xirr-pyxirr.md`。

## 0. 定位与硬约束

- 后端 100% Python（FastAPI + SQLAlchemy 2.0 + Alembic + PyJWT + bcrypt），彻底移除 NestJS/Prisma/TS 后端栈。
- `../app` 是**只读参考源**：可复制/参考，绝不改删。新项目自身不含任何 NestJS/Prisma/TS 后端代码（零遗留）。
- 全新项目、无存量数据 → XIRR/NAV 一致性风险低，Alembic 可直接建 schema。

## 1. 技术栈

| 层 | 技术 |
|----|------|
| 后端框架 | FastAPI（异步，`EnvelopeRoute` 自定义路由类） |
| ORM | SQLAlchemy 2.0 async + asyncpg；Alembic 迁移 |
| 认证 | PyJWT(HS256) + bcrypt(cost=10) |
| 计算内核 | `finance_core` 纯函数（XIRR 委托 `pyxirr`；NAV 单位份额法） |
| 序列化 | Pydantic v2；`Decimal` → **字符串**（金额精度/类型对齐 Prisma Decimal） |
| 前端（Phase 5） | React + Vite；类型由 `docs/openapi.json` 经 `openapi-typescript` 生成 → `web/src/types/api.ts` |
| 测试 | pytest + pytest-asyncio + httpx(TestClient)；Python CI 跑 pytest + ruff |

## 2. 分层结构

```
backend/app/
├── main.py              # 应用入口：路由注册、CORS、全局异常→信封、OpenAPI 注入 Bearer
├── core/                # config / enums / exceptions / envelope / security / types(DecimalStr)
├── db/                  # database(engine/session) + base(TimestampMixin)
├── models/              # SQLAlchemy 2.0 模型（12 表 + 6 枚举）
├── schemas.py           # 请求体 Pydantic DTO（金额统一 DecimalStr）
├── finance_core/        # 纯函数：xirr.py / nav.py / holding.py
├── services/            # 业务逻辑：calculation / holding / asset_valuation / recalculation / aggregation / data_transfer / user
└── routers/             # 业务路由（每个 router 用 EnvelopeRoute）
```

## 3. 统一响应信封（契约基线 · Phase 0 冻结）

- 成功：`{ code: 0, data: <原值>, message: "ok" }`
- 错误：`{ code: <业务码>, data: null|对象, message }`
- 已是信封（带 number 型 `code`，如 upload 手工信封）→ 原样透传，不二次包裹
- `data` 为 `None` → 归一为 `null`
- 金额 `Decimal` → 字符串序列化（前端 `money.ts` 已适配字符串形态）
- 业务错误码：`1001/1002/1003/1004/1006/1007/1008/1009/2000/3001/5000`

实现：`EnvelopeRoute`（`core/envelope.py`）在 `get_dependant` 前包裹 endpoint；
`EnvelopeJSONResponse.render` 用自带 `decimal_jsonable_encoder`（Decimal→str）。

## 4. 路由注册铁律

- `router_aggregation` **必须在** `portfolios.router` **之前** include：
  `/comparison` 字面路由需优先于 `/{portfolio_id}` 参数路由（Starlette 按注册顺序匹配）。
- 每个业务 `APIRouter` 必须显式传 `route_class=EnvelopeRoute`，否则 `include_router`
  进来的路由仍用默认 `APIRoute` 不包裹信封。

## 5. 鉴权与数据隔离

- `get_current_user`：验签 JWT(HS256) + 查库校验用户存在且未软删 → 否则 401/`1001`。
- 组合归属隔离依赖 `get_portfolio`（非本人/不存在 → 404）；分红/标的二级隔离
  （`securityId` 必须属于本组合）。

## 6. 计算引擎（方案 B · 交易明细法）

- 由 `SecurityTrade` 流水重放推导持仓（取代旧「持仓快照法」）。
- `RecalculationService`：写操作（快照/交易/出入金/价格/现金余额变更）触发区间重建；
  `asset_valuation` 落库 `DERIVED`、遇 `MANUAL` 快照跳过、手工三路径 + reset。
- 首日期 NAV 递推要求当日有 BUY 入金（`compute_daily_nav` 抛 ValueError 约束）。
- XIRR 退化现金流（<2 条 / 全同号）返回 `None`（不可计算），不崩。

## 7. 数据精度约定（PRD 8.1）

- 金额 `NUMERIC(18,2)`；XIRR `NUMERIC(20,8)`；净值 `NUMERIC(12,6)`；份额 `NUMERIC(18,6)`。
- JSON 层金额一律字符串（见 §3）。

## 8. OpenAPI 与前端类型

- 完整契约：`docs/openapi.json`（由 `backend/scripts/gen_openapi.py` 从 `app.main:app` 导出，49 paths / 67 ops）。
- 生成：`web/` 下 `npm run generate:api` → `web/src/types/api.ts`（openapi-typescript v7）。
- 取代旧 `app/packages/shared` 双份契约：前端只依赖后端生成的 `api.ts`。

## 9. 模块映射（v2.3 Phase 4 业务模块全量）

| 模块 | 端点 | 位置 |
|------|------|------|
| auth | register/login/me/profile/restore/password/email/account | `routers/auth.py` |
| portfolio | CRUD portfolios + archive | `routers/portfolios.py` |
| cashflow | cashflows CRUD | `routers/data.py` |
| security | securities CRUD | `routers/data.py` |
| security-trade | trades CRUD | `routers/data.py` |
| security-price | prices CRUD | `routers/data.py` |
| cash-balance | cash-balances CRUD | `routers/data.py` |
| snapshot | snapshots CRUD + reset + by-date | `routers/data.py` |
| dividend (§4.2.18) | dividends CRUD | `routers/dividend.py` |
| data-transfer (§4.2.17) | export/preview/commit/template | `routers/data_transfer.py` + `services/data_transfer.py` |
| preference (§4.2.16) | GET/PATCH /api/users/preferences | `routers/preference.py` |
| upload (§19) | POST /api/upload/avatar | `routers/upload.py` |
| query | xirr/nav/holdings/drawdown/summary/overview/comparison + nav/history + xirr/history | `routers/calc.py` + `routers/aggregation.py` |
| account | /api/account/stats | `routers/aggregation.py` |

> `fees` 模块按 §4.2.19 已删除，不计入。Phase 4.5 补齐 9 真实缺口（auth password/email/account、portfolio archive、nav/history、xirr/history、cashflow/securities/security-trades 单资源 GET），业务端点合计 **69**（含 Phase 4 重命名净差异；fees 已删）。

## 10. 测试底座铁律

- pytest `>=8.4,<9`；`pytest.ini` function 作用域 + 每测试重建引擎并 patch 全局 `app.db.database`
  的 `engine`/`AsyncSessionLocal` + **NullPool**（解 asyncpg「different loop」与 `MissingGreenlet`）。
- 切勿退回 9.x 或 session 作用域。
