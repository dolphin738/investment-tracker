> 本文档作为架构决策记录（ADR-003）。2026-08-14 由设计记录 `docs/design-security-model-split.md` 升级而来；当日锁定全部待决项（D1–D4，见 §2.5）。**核心决策已收口，待实施**。

# 证券数据模型拆表：目录表（securities）+ 组合持仓表（portfolio_securities）（ADR-003）

> 架构师：dolphin738 ｜ 上游输入：会话讨论"主数据 sync 行 vs 录入组合行 双层模型能否更好融合" ｜ 状态：核心决策已收口，待实施
> 变更性质：**证券数据模型重构**（单表双用 → 目录表 + 组合持仓表），触及 `Security` 模型、`PortfolioSecurity` 新模型、Trade/Price/Dividend 外键、`SecurityService.resolve/list/patch/delete`、`Security.create` 端点、约 10 处 `select(Security)` 查询、前端 combobox resolve 调用
> 全部结论均基于本次实际代码核实（`backend/app/models/security.py`、`services/security.py`、`modules/admin/router.py`、`market_data_sync.py`、前端 `security-search-combobox.tsx` / `security-trade-form.tsx`），非记忆推断

---

## 0. 决策现状核实（先于记录）

| 项 | 位置（实际代码） | 状态 |
|----|------------------|------|
| `Security` 模型 | `backend/app/models/security.py:26-78` | ⚠️ 单表双用：`portfolio_id`（组合行标记）+ `type`（NOT NULL）冗余列 |
| 唯一约束 | `security.py:29,31-37` | ⚠️ `(portfolio_id, code)` + 部分唯一索引 `uq_securities_master_asset_code(asset_class, code) WHERE portfolio_id IS NULL` |
| FK 指向 `securities.id` | `models/security.py:94,141`；`models/dividend.py:31` | ⚠️ `SecurityTrade/SecurityPrice/DividendRecord.security_id`（3 张表，均 CASCADE） |
| `resolve` | `services/security.py:99-155` | ⚠️ 拷贝主数据 `name/exchange` + `infer_security_type` 推 `type`（已知"主数据改名不同步"副作用） |
| `infer_security_type` | `security.py:21-59` | ✅ 健壮：按 sh/sz/bj 前缀 + 数字前缀识别 ETF/LOF/可转债/指数/A 股股票，作 COALESCE 真相源 |
| `Security.create` 端点 | `data/router.py:171` → `service.create:75` | ⚠️ 手动建组合行；前端已无调用方（`security-trade-form.tsx:428` 注释"不再支持新建标的"） |
| 前端 resolve 调用 | `security-trade-form.tsx:257-264` | ⚠️ `mutate({code,name,type,exchange})`；新模型应传 `master_id`（combobox `onSelect(master)` 已持 `master.id`） |
| 最新迁移 | `alembic/versions/j9e0f1a2b3c4_lof_remove_cash.py` | — 后续迁移接此 |

**结论**：当前 `securities` 单表双用（主数据行 `portfolio_id IS NULL` + 组合行 `portfolio_id=X`）带来两个痛点——① 主数据改名不同步组合行；② 主数据 `type` 冗余且注释误导（`resolve` 从不读主数据 `type`，改用 `infer_security_type` 独立推断）。需拆表根治。

---

## 1. 背景与问题

`securities` 一张表同时承载两类语义完全不同的数据：
- **主数据行**（`portfolio_id IS NULL`）：全市场搜索目录，由 `_upsert_masters` 写入，跨组合共享。
- **组合行**（`portfolio_id = X`）：某组合私有标的实例，录入交易时 `resolve` 懒实例化，承载 trades/prices/dividends。

由此产生：
1. **主数据改名不同步（副作用）**：`resolve` 创建组合行时**拷贝**主数据 `name/exchange`，之后主数据改名/改交易所，已建组合行不自动同步。
2. **主数据 `type` 冗余且误导**：`resolve` 用 `infer_security_type` 独立推断 `type` 从未读主数据 `type`；而 `_upsert_masters` 写主数据 `type` 的注释"供 resolve 复制"是错误的。主数据类别维度已由 `asset_class` 承担。

---

## 2. 决策内容

| 项 | 决策 | 理由 |
|----|------|------|
| 模型拆分 | `securities` 仅作**目录表**；新增 `portfolio_securities` **组合持仓表** | DDD reference-data / transactional-instance 标准分离，根治痛点① |
| 组合行属性来源 | `name/exchange` 经 `master_id` JOIN 目录读取；不再拷贝 | 目录改名全局自动可见 |
| `type` 语义 | 收敛为"组合行专属 + 代码前缀推断 + 可选手动 override" | `type` 本就是组合维度属性（resolve 独立推断，不依赖主数据） |
| 唯一约束 | `securities`: `(asset_class, code)`；`portfolio_securities`: `(portfolio_id, master_id)` | 拆表后无需 `portfolio_id` 维度的旧约束 |
| 类型推导 | Python 层 `COALESCE(holding.type, infer_security_type(catalog.code, catalog.exchange))` | `infer_security_type` 是 Python 函数，库内无对应实现，不能 SQL COALESCE |
| 孤儿/手输 | 禁止"无主数据手输 code"，必须选目录主数据 | holding 必挂靠目录主数据，手输会逼出孤儿主数据 |
| `Security.create` | 删除端点，组合行只经 `resolve` 创建 | 前端已无调用方，零风险 |

### 2.1 目标模型

```text
securities（目录表 / 仅主数据行）
  id / code / name / exchange / asset_class / pinyin_initials
  唯一约束: (asset_class, code)        —— 删除 portfolio_id、type
  asset_class 仅用于唯一约束 + 接口配置路由，不参与类型推导

portfolio_securities（组合持仓表 / 原组合行独立成表）
  id / portfolio_id(FK→portfolios, CASCADE) / master_id(FK→securities.id)
  type(SecurityType, 可空 override: NULL=由代码前缀推断, 有值=手动覆盖)
  currency / created_at / updated_at
  唯一约束: (portfolio_id, master_id)

Trade / Price / Dividend.security_id  →  改指 portfolio_securities.id
```

**展示层**：`name / exchange / currency` 经 `master_id` JOIN 目录读取 → 目录改名/改交易所全局自动可见（根治痛点①）。
**隔离性**：组合 A、B 各录一次平安银行 → 1 条目录主数据 + 2 条 `portfolio_securities`（各组合一份），符合组合隔离预期。

### 2.2 类型推导链路（关键修正）

```text
resolve(买入录入):
  1. 按 (portfolio_id, master_id) 查组合行
  2. 有 → 返回（type 层自动 COALESCE）
  3. 无 → 新建组合行, type = NULL
     → 返回时 type = COALESCE(portfolio_securities.type,
                               infer_security_type(catalog.code, catalog.exchange))

get_holdings / 导出 / 交易筛选:
  type = COALESCE(portfolio_securities.type,
                  infer_security_type(catalog.code, catalog.exchange))
```

**约束**：`COALESCE` 必须在**序列化/响应层用 Python 计算**，保证所有出口（SecurityOut、交易/持仓/价格响应、前端筛选）调用同一处工具函数（新增 `compute_type(holding, catalog)`）；`infer_security_type`（security.py:21）保持不动作真相源；手动改类型 → `PATCH portfolio_securities.type`（override），不走 `resolve` 设 type。

### 2.3 数据迁移（D1 已决：干净重建）

- **不走数据迁移脚本**。开发库 `investment_tracker` 与测试库均从 Alembic head 整体 `DROP+CREATE` 重建。
- 迁移仅含 schema 操作：① `CREATE TABLE portfolio_securities`（FK + `(portfolio_id, master_id)` 唯一 + 时间戳）；② `ALTER securities`：`DROP COLUMN portfolio_id`、`DROP COLUMN type`、DROP 旧唯一约束 `uq_securities_portfolio_code`、`ADD (asset_class, code)` 唯一；③ 三张 FK 表 `security_id` 目标由 `securities.id` 改为 `portfolio_securities.id`。
- 测试库由 conftest 每会话自动 `upgrade head` 重建；开发库重建前建议 `pg_dump` 一份（非强制）。
- `alembic/env.py` 已异步 + `compare_type=True`。

### 2.4 D2 / D3 决策

- **D2 禁止手输 code**：录入买卖必须选目录主数据（combobox 搜索 → 点击选中 → `resolve` 传 `master_id`）；移除"无主数据手输 code"入口。目录缺失标的须先建主数据（sync 或 admin）再选。
- **D3 删除 `Security.create`**：`POST /portfolios/:pid/securities` + `SecurityService.create` + 前端 `createSecurity`/`useCreateSecurity` 一并删除。前端已无调用方，零风险。

### 2.5 待决项收口（全部已决）

| # | 项 | 决策 | 理由 |
|---|----|------|------|
| D1 | 开发库整库重建 vs 数据迁移脚本 | **干净重建**（仅 schema） | 无历史数据需保留价值；整库重建最干净，手测数据一并清空 |
| D2 | "无主数据手输 code"路径 | **禁止手输，必须选目录主数据** | holding 必挂靠目录主数据，手输逼出孤儿主数据，违背拆表初衷 |
| D3 | 保留 `Security.create` 端点 | **删除，统一走 resolve** | 前端已无调用方，零风险；收敛入口减少分支 |
| D4 | 存量组合行 `type` 处理 | **全部重置 NULL** | 无历史手动 override；存量 `type` 均来自代码前缀推断，重置后重推结果一致，省去类型拷贝 |

---

## 3. 被否决 / 替代方案

| 方案 | 表述 | 否决理由 |
|------|------|----------|
| 仅"主数据去 type" | `securities.type` 改 nullable，组合行仍单表 | 弱于拆表：不根治"主数据改名不同步组合行"副作用，且组合行仍拷贝 name/exchange |
| 单表单行 + override 表 | 只留主数据行，私有属性进 `portfolio_security_overrides` | 过度融合：破坏 `(portfolio_id, code)` 隔离模型，trade 外键语义大改 |
| 事件级联同步 | 双行拷贝 + 主数据更新级联刷新组合行 | 引入同步复杂度 + "用户已手动改过的组合行不该被覆盖"语义陷阱 |
| D1 走数据迁移脚本 | 反查 `master_id` / 建 `id map` / 删旧行 | D1 已决干净重建，无存量数据，脚本纯属负担 |

---

## 4. 后果与回退

| 维度 | 影响 | 处理 |
|------|------|------|
| 现有 `Security` 单表双用 | **拆表**：目录 + 组合持仓两表 | 约 10 处 `select(Security)` 改 JOIN；三张 FK 表改指 `portfolio_securities.id` |
| `Security.create` 端点 | **删除**（函数、端点、前端 hook/API） | 前端已无调用方，无 UI 破坏 |
| 数据模型 | `securities` 去 `portfolio_id`/`type` + 改唯一约束；新增 `portfolio_securities` + Alembic 迁移 | `alembic upgrade head` 同步开发/测试库（D1 重建） |
| 展示同步 | 组合行 `name/exchange` 改经 JOIN 目录 | 根治"主数据改名不同步"副作用 |
| 类型推导 | 序列化层 Python COALESCE | 统一 `compute_type` 工具，多出口复用 |
| 复杂度 | JOIN 查询增多、迁移为 schema 级 Breaking | 受控；D1 干净重建规避数据迁移风险 |
| 回退 | 如需回退到单表双用 | 从 git 历史恢复旧 `Security` 模型与 `Security.create`；开发库需从 dump 或重新 sync 恢复数据，接受该风险 |

---

## 5. 落地范围（分阶段，建议顺序）

1. **P1 模型 + Alembic 迁移**（仅 schema）：`PortfolioSecurity` 模型、改 `Security` 列与唯一约束、三张 FK 表改指、`CREATE portfolio_securities` 迁移。D1 干净重建，无数据迁移脚本。
2. **P2 `resolve` 重写**（`master_id` 查/建 `PortfolioSecurity`）+ 序列化 `compute_type` COALESCE 工具。
3. **P3 查询层 ~10 处 JOIN 改写**（组合行相关 7 处 + 纯目录 2 处 + 按 id 取 1 处，见设计文档 §5.4 核对清单）。
4. **P4 前端传 `master_id`** + 响应处理（combobox `onSelect(master)` → `mutate({masterId})`；`securityId` 回填 `portfolio_securities.id`）。
5. **P5 测试回归**：`pytest` 全量（security/trade/price/dividend/holdings/market_data_sync）+ `vitest` 相关套件；全绿后按特性拆分提交（不 push，作者 `senior-dev`）。

> 详见 `docs/design-security-model-split.md`（§5 精确改动清单 / §7 风险 / §8 阶段）。

---

## 6. 参考

- `docs/design-security-model-split.md` — 方案记录（精确改动清单、行号、查询核对清单）
- `backend/app/models/security.py` — 当前 `Security` 单表双用模型
- `backend/app/services/security.py` — `resolve` / `infer_security_type` / `create` / `list_stmt` / `patch` / `delete`
- `backend/app/modules/admin/router.py` — `list_security_masters`（纯目录查询）
- `backend/app/services/market_data_sync.py` — `_upsert_masters`（主数据写入）
- `web/src/components/security/security-search-combobox.tsx` — 前端 `onSelect(master)` 已持 `master.id`
- `web/src/features/security-trade/security-trade-form.tsx:257-264, 428` — resolve 调用 + "不再支持新建标的"注释
- `docs/adr/ADR-002-quote-interface-priority-chain.md` — 关联架构决策
- `docs/PRD.md` §5.9 / §11、`docs/ARCHITECTURE.md` §3.1.2 / §3.1.6 — 待实施后同步更新
