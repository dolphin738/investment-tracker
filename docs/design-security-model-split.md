# 方案记录：证券数据模型拆表（目录表 + 组合持仓表）

> **类型**：方案记录（design record，待评审，未实施）
> **日期**：2026-08-14
> **来源**：会话讨论 —— 回应"主数据 sync 行 vs 录入组合行 双层模型能否更好融合"
> **关联**：`ADR-002`（接口优先级链）、`PRD.md` §5.9 / §11、`ARCHITECTURE.md` §3.1.2 / §3.1.6
> **状态**：决策已锁定（D1–D4 见 §9），已升级为 `ADR-003-security-model-split.md`，待实施。

---

## 0. 一句话结论

把当前的 `securities` 单表（同时存"系统主数据行 `portfolio_id=NULL`"和"组合实例行 `portfolio_id=X`"）**拆成两张表**：

- `securities` → 仅做**目录表**（reference data，跨组合共享，可被搜索）
- 新增 `portfolio_securities` → **组合持仓表**（组合私有实例，承载 trades/prices/holdings）

组合行不再拷贝 `name/exchange`，改为 `master_id` JOIN 回目录读取 —— **顺带根治"主数据改名不同步到组合行"的已知副作用**，并把 `type` 语义收敛为"组合行专属、代码前缀推断 + 可选手动 override"。

---

## 1. 背景与动机

当前 `securities` 一张表双用：

- **主数据行**：`portfolio_id IS NULL`，由市场数据同步（`_upsert_masters`）写入，全组合共享的搜索目录。
- **组合行**：`portfolio_id = 某组合`，录入交易时 `resolve` 懒实例化，承载该组合的 trades/prices/dividends。

由此产生两个痛点：

1. **主数据改名不同步（已知副作用）**：`resolve`（security.py:120-151）创建组合行时**拷贝**主数据的 `name/exchange`，之后主数据若改名/改交易所，已建的组合行不会自动同步。
2. **主数据 `type` 冗余且误导**：`resolve`（security.py:133）创建组合行时用 `infer_security_type(req.code, exchange)` **独立推断** `type`，**从不读主数据的 `type`**；而 `_upsert_masters`（market_data_sync.py:575/583）写主数据 `type` 的注释写着"供 resolve 复制"——**该注释是错的**。主数据的类别维度已由 `asset_class` 字段承担（security.py:62 注释"主数据行 type 即 = asset_class"）。

目标：彻底分离"目录"与"组合实例"，根治痛点①，同时收敛 `type` 语义。

---

## 2. 当前模型现状（已核对，含行号）

| 项 | 位置 | 现状 |
|---|---|---|
| `Security` 模型 | `backend/app/models/security.py:26-78` | 单表双用；列：`portfolio_id`(可空 FK→portfolios, CASCADE)、`code`、`name`、`type`(NOT NULL, default STOCK)、`currency`、`exchange`、`pinyin_initials`、`asset_class`(可空, 复用 `SecurityType` 枚举) |
| 唯一约束 | `security.py:29,31-37` | `uq_securities_portfolio_code(portfolio_id, code)`；部分唯一索引 `uq_securities_master_asset_code(asset_class, code) WHERE portfolio_id IS NULL` |
| FK 指向 `securities.id` | `models/security.py:94,141`；`models/dividend.py:31` | 三张表：`SecurityTrade.security_id`、`SecurityPrice.security_id`、`DividendRecord.security_id`（均 `ondelete=CASCADE`） |
| `resolve` | `backend/app/services/security.py:99-155` | 按 `(portfolio_id, code)` 查组合行 → 否则以主数据行模板**拷贝 name/exchange** + `infer_security_type` 推 `type` 建行 |
| `infer_security_type` | `security.py:21-59` | 健壮：剥离 sh/sz/bj 前缀，按数字前缀识别 ETF/LOF/可转债/指数/A 股股票 |
| 主数据查询 | `modules/admin/router.py:634`；`market_data_sync.py:560-563` | `list_security_masters` = `select(Security).where(portfolio_id.is_(None))`；`_upsert_masters` 写主数据（含误导注释的 `type`） |
| 前端 resolve 调用 | `web/src/features/security-trade/security-trade-form.tsx:257-264` | `handleSelectMaster` 调 `resolveSecurityMutation.mutate({ code, name, type, exchange })` |
| 前端 resolve API | `web/src/api/security.api.ts:101-106` | `POST /portfolios/:pid/securities/resolve` |
| 前端主数据类型 | `web/src/api/security-master.api.ts:16-26` | `SecurityMaster { id, code, name, exchange, type, updatedAt }`；combobox `onSelect(master)` 已持 `master.id` |
| 最新迁移 | `backend/alembic/versions/j9e0f1a2b3c4_lof_remove_cash.py` | 后续迁移接在此之后 |

---

## 3. 目标模型

```text
securities（目录表 / 仅主数据行）
  id / code / name / exchange / asset_class / pinyin_initials
  唯一约束: (asset_class, code)        —— 不再有组合行，故无需 WHERE portfolio_id IS NULL
  ——— 删除 portfolio_id、type（类别由 asset_class 承担）
  ——— asset_class 仅用于唯一约束 + 接口配置路由，不参与类型推导

portfolio_securities（组合持仓表 / 原组合行独立成表）
  id / portfolio_id(FK→portfolios, CASCADE) / master_id(FK→securities.id)
  type(SecurityType, 可空 override: NULL=由代码前缀推断, 有值=手动覆盖)
  currency / created_at / updated_at
  唯一约束: (portfolio_id, master_id)

Trade / Price / Dividend.security_id  →  改指 portfolio_securities.id
```

**展示层**：`name / exchange / currency` 通过 `master_id` JOIN 目录表读取 → 目录改名/改交易所全局自动可见（根治痛点①）。
**隔离性**：组合 A、B 各录一次平安银行 → 1 条目录主数据 + 2 条 `portfolio_securities`（各组合一份），符合组合隔离预期。

---

## 4. 类型推导链路（关键修正）

```text
resolve(买入录入):
  1. 按 (portfolio_id, master_id) 查组合行
  2. 有 → 返回（type 层自动 COALESCE）
  3. 无 → 新建组合行, type = NULL
     → 返回时 type 层自动计算: COALESCE(portfolio_securities.type,
                                   infer_security_type(catalog.code, catalog.exchange))

get_holdings / 导出 / 交易筛选:
  type 一律 = COALESCE(portfolio_securities.type,
                       infer_security_type(catalog.code, catalog.exchange))
```

**重要约束**：`infer_security_type` 是 **Python 函数**，数据库里没有对应实现。因此 `COALESCE` **不能在 SQL 里算**，必须在**序列化 / 响应层用 Python 计算**，并保证所有出口（SecurityOut、交易/持仓/价格响应、前端筛选）调用同一处工具函数。

- `infer_security_type(code, exchange)`（security.py:21）**保持不动**，继续作为真相源。
- 手动改类型 → `PATCH portfolio_securities.type`（override），不再走 `resolve` 设 type。

---

## 5. 改动清单（精确位置）

### 5.1 模型层 `backend/app/models/security.py` + `models/dividend.py`
- `Security` 删 `portfolio_id`、`type` 列；唯一约束改为 `(asset_class, code)`。
- 新增 `PortfolioSecurity` 模型（字段见 §3；`__tablename__ = "portfolio_securities"`）。
- `SecurityTrade.security_id`、`SecurityPrice.security_id`、`DividendRecord.security_id` 的 FK 目标从 `securities.id` 改为 `portfolio_securities.id`（均 `ondelete=CASCADE`）。
- 关系 `back_populates` 由 `Security` 改为 `PortfolioSecurity`（`trades`/`prices`/`dividends` 关系迁移到 `PortfolioSecurity`）。

### 5.2 Schema
- `SecurityResolveReq`（`schemas.py:107-113`）：`code/name/type/exchange` → 改为 `master_id`（必填）+ 可选 `type`（仅手动 override 用，resolve 不再用于设 type）。
- `SecurityOut`（`schemas_resp.py:98-105`）：补充 `exchange`、`masterId`（来自 JOIN）；`type` 仍为必填 `SecurityType`（后端 COALESCE 后填，**永远非 null**）。
- `SecurityMaster`（`security-master.api.ts:16`）：目录行本就无 `type` 语义，保留 `code/name/exchange`；前端可改用 `asset_class` 作为目录行的类别提示（替代原 `type`）。

### 5.3 Service 层 `backend/app/services/security.py`
- `resolve`（:99）：按 `(portfolio_id, master_id)` 查/建 `PortfolioSecurity`；新建 `type=NULL`；返回 `(PortfolioSecurity, is_new)`。
- 新增 `compute_type(holding, catalog)` 工具：Python `COALESCE`（被 `list`/`get`/序列化复用，保证单一出口）。
- `list_stmt`（:63）：改为 `select(PortfolioSecurity).join(Security).where(portfolio_id == X)`。
- `patch`（:88）：改为 `PATCH portfolio_securities.type`（override）。
- `delete`：级联删 `portfolio_securities` 及其 trades/prices（调整 FK 关系链）。
- `create`（:75）：**D3 已决删除** `Security.create` 端点 + service + 前端 `createSecurity`/`useCreateSecurity`；组合行只经 `resolve` 创建。若未来需手动建目录主数据，另置 admin 端点（不在本 ADR 范围）。

### 5.4 其他 `select(Security)` 查询改 JOIN（核对清单）

**组合行相关（→ JOIN `portfolio_securities`）**：
- `modules/calculation/router.py:131` 重算
- `modules/data_transfer/router.py:104` 导入
- `services/data_transfer.py:310, 324, 372` 导出 ×3
- `services/market_data_sync.py:423` sync 组合行处理
- `services/security.py:111, 123`（resolve 内部查重/模板）
- `modules/dividend/router.py:49` 按 `id.in_(sec_ids)` 取（保持，仅换表名）

**纯目录查询（→ 直接查 `securities`，不再有组合行）**：
- `modules/admin/router.py:634` `list_security_masters`
- `services/market_data_sync.py:560-563` `_upsert_masters`

### 5.5 `_upsert_masters`（`market_data_sync.py:560-587`）
- 删掉 `inferred_type` 推断与两处 `type=inferred_type`；修正"供 resolve 复制"错误注释。
- 目录行不再有 `type` 列。

### 5.6 前端
- `security-search-combobox.tsx`：`onSelect(master)` 已持有 `master.id` → 父表单 resolve 传 `master_id`（替代现 `{code,name,type,exchange}` 全量）。
- `security-trade-form.tsx:257` `handleSelectMaster`：`mutate` 体改为 `{ masterId: master.id, type?: manualOverride }`；`securityId` 回填改为 `portfolio_securities.id`（语义不变）。
- 分红/持仓等所有引用 `securityId` 的表单：指向 `portfolio_securities.id`（外键语义不变，仅底层表变）。
- 下拉展示（combobox:128 `[s.exchange, s.type].filter(Boolean)`）：目录行 `type` 不存在，改用 `asset_class` 或仅显示 `exchange`。
- `trade-security-filter`：前端拿到的列表 `type` 已是后端 COALESCE 值，过滤逻辑不变。

### 5.7 API 端点
- `POST /portfolios/:pid/securities/resolve`：入参 `master_id`。
- `GET /portfolios/:pid/securities`（list）：返回 JOIN 后的 `SecurityOut`（含 computed `type`/`exchange`/`masterId`）。
- `PATCH /portfolios/:pid/securities/:id`：改 `portfolio_securities.type` override。
- 目录端点 `/api/admin/securities/masters`、`/sync`：仅操作 `securities` 目录表。

---

## 6. 迁移策略（Alembic）— D1 已决「干净重建」

新建迁移（接 `j9e0f1a2b3c4` 之后）。**D1 决定走"干净重建"路线，故迁移仅含 schema 操作，不写任何存量数据迁移脚本**：

1. `CREATE TABLE portfolio_securities`（含 FK → `portfolios`、`securities`；`(portfolio_id, master_id)` 唯一约束；`created_at/updated_at`；`type` 可空）。
2. `ALTER securities`：`DROP COLUMN portfolio_id`、`DROP COLUMN type`、DROP 旧唯一约束 `uq_securities_portfolio_code` 与部分唯一索引、ADD 新唯一约束 `(asset_class, code)`。
3. `Trade/Price/Dividend.security_id` 的 FK 目标由 `securities.id` 改为 `portfolio_securities.id`（`ondelete=CASCADE` 不变）。

> **已删除原 §6.2「数据迁移（若需保留开发数据）」整段**：D1 已决整库重建，不存在存量组合行，无需反查 `master_id` / 建 `id map` / 删旧行。开发库 `investment_tracker` 与测试库均从 Alembic head 整体 `DROP+CREATE` 重建；手测数据（示例交易/价格）一并清空，需重新录入或走 sync 拉取。

**关键约束（D1 已锁定）**：
- 迁移纯 schema 操作；不依赖任何存量数据。
- 测试库由 conftest 每会话自动 `upgrade head` 重建，**无需手动迁移**。
- 开发库重建前建议手动 `pg_dump` 一份以防误删需回看（非强制，因无保留需求）。
- `alembic/env.py` 已异步 + `compare_type=True`（可检测类型/精度变化）。

---

## 7. 风险与坑（实施前必读）

1. ~~存量组合行无 `master_id` 回链~~ —— **D1 已决「干净重建」，无存量数据，该风险消除**。
2. **COALESCE 不在 SQL** —— `infer_security_type` 是 Python，必须序列化层算，保证所有出口一致（§4）。
3. **~10 处 `select(Security)` 需改 JOIN**（§5.4 清单），工作量大头在查询改写。
4. ~~resolve 契约变更 + 孤儿语义~~ —— D2 已决「禁止手输 code，必须选目录主数据」，「无主数据手输」入口直接移除，孤儿语义问题消除；仅剩前端改传 `master_id` 的契约调整。
5. **唯一约束迁移风险**：`securities` 唯一键从 `(portfolio_id, code)` 改为 `(asset_class, code)`；D1 干净重建下无需存量清理/校验，风险由"单事务+备份+断言"降为纯 schema 操作。
6. **边界一致性**：`SecurityOut.type` 在新模型下**永远非 null**（COALESCE 保证）；前端 `filter(Boolean)` 容错可保留但理论上不再需要。

---

## 8. 实施阶段（建议）

- **P1** 模型 + Alembic 迁移（仅 schema：建 `portfolio_securities` / `securities` 去 `portfolio_id`+`type` / 改唯一约束为 `(asset_class, code)` / 三张 FK 表改指 `portfolio_securities.id`）。D1 干净重建，无数据迁移脚本。
- **P2** `resolve` 重写（`master_id` 查/建）+ 序列化 COALESCE 工具。
- **P3** 查询层 ~10 处 JOIN 改写。
- **P4** 前端传 `master_id` + 响应处理。
- **P5** 测试回归（`pytest` 全量 + `vitest` 相关套件）。
- 提交按特性拆分、不 push（作者 `senior-dev`）。

---

## 9. 待决事项（需用户拍板）

- **D1** 【**已决：干净重建**】开发库 `investment_tracker` 与测试库均从 Alembic head 整体 `DROP+CREATE` 重建，迁移**仅含 schema 操作**，不写数据迁移脚本。`investment_tracker` 虽含真实开发数据且"禁止随意改动"，但因无历史数据需保留价值（D4 同理），整库重建最干净，手测数据一并清空。
- **D2** 【**已决：禁止手输 code**】录入买卖必须选目录主数据（combobox 搜索 → 点击选中 → `resolve` 传 `master_id`）；移除"无主数据手输 code"入口。目录里还没有的标的，正确动作是先建目录主数据（走 sync 或 admin 建 master）再选，而非录入时手输。
- **D3** 【**已决：删除 `Security.create`**】`POST /portfolios/:pid/securities` 端点 + `SecurityService.create` + `createSecurity` API / `useCreateSecurity` hook 一并删除，组合行只经 `resolve` 创建。前端已无调用方（`security-trade-form.tsx:428` 注释"不再支持新建标的"），零风险。
- **D4** 【**已决：全部重置 NULL**】存量组合行 `type` 在 COALESCE 下全部重置为 NULL，靠代码前缀 `infer_security_type` 在读取时重推。理由：无历史手动 override 数据需保留；存量 `type` 均来自代码前缀推断（resolve 路径，非手工），重置后重推结果一致；迁移时 `portfolio_securities.type` 直接建 NULL，省去类型拷贝。

---

## 10. 关联文档

- `docs/adr/ADR-002-quote-interface-priority-chain.md`（接口优先级链）
- `docs/PRD.md` §5.9 接口字段 / §11 配置驱动主数据
- `docs/ARCHITECTURE.md` §3.1.2 securities / §3.1.6 quote_provider_interfaces
- 本方案是"主数据去 type、type 归组合行"的**超集**（更彻底：连 `portfolio_id` 双用也拆掉）
