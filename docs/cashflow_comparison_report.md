# 出入金（存款/取款）模块代码对比报告

> 对比对象  
> - **A 项目（app/）**：NestJS + TypeScript 后端（Prisma ORM）+ React/Vite 前端，pnpm monorepo，含共享包 `shared`、`finance-core`。  
> - **B 项目（investment_return_tracker/）**：Python(FastAPI + SQLAlchemy 2.0 async) 后端 + React/TypeScript 前端（TanStack Query + axios），monorepo。  
>
> 方法论：本报告**仅依据代码**（后端源码、前端源码、模型/DTO/Schema、计算内核），不参考任何 Markdown/架构文档。涉及的文件路径与行号均已逐一对齐，并对关键差异点（`amount` 类型、首笔校验、recalculation 响应、精度策略）做了直接源码复核。

---

## 0. 范围与核心结论（TL;DR）

两个项目都对「出入金」做了**拆解式建模**：把资金进出拆成**两套独立数据**——

1. **CashFlow（现金流 / 出入金流水）**：BUY=存入（现金流为负）、SELL=取出（现金流为正），是 **XIRR 现金流的唯一来源**，并通过买入/卖出额改变净值（NAV）份额；
2. **CashBalance（现金余额）**：由用户**手工、独立维护、前向沿用**，才进入 `totalAsset = 市值 + 现金余额`。

即双方都采用**「方案 B」**：**出入金流水本身不会自动修改现金余额**，系统仅在保存后软提示用户手工去更新余额。这是两项目最大的**共性**，决定了二者在业务语义、数据模型、计算联动上高度一致。

差异主要集中在**工程实现层**：金额入参类型（number vs 字符串 Decimal）、首笔必须为存入的校验（B 有 / A 无）、写入后重算反馈的透出方式（A 返回 recalculation 字段 / B 不返回）、以及精度约束在 API 层的覆盖度。

---

## 1. 总体架构对比

| 维度 | A 项目（NestJS / app） | B 项目（Python / FastAPI） |
|---|---|---|
| 后端框架 | NestJS（装饰器路由 + 模块化 DI） | FastAPI（函数式 `APIRouter` + 依赖注入 `Depends`） |
| 出入金模块位置 | `modules/cashflow`、`modules/cash-balance` 两个独立 Module | `routers/data.py` 内两个 `APIRouter`（`router_cashflows`、`router_cashbalances`），**无独立 Service 类**，写入逻辑内联于 router |
| ORM / 数据库 | Prisma（`schema.prisma`）+ PostgreSQL | SQLAlchemy 2.0 async + asyncpg + PostgreSQL |
| 共享计算内核 | `packages/finance-core`（nav.ts / xirr.ts，纯函数） | `app/finance_core`（nav.py / xirr.py，纯函数） |
| 鉴权 | 全局 `APP_GUARD: JwtAuthGuard`（JWT Bearer） | `get_current_user` 依赖（JWT HS256 Bearer），各写接口注入 |
| 响应信封 | 全局 `HttpExceptionFilter` → `{code,data,message}` | `EnvelopeRoute` + `EnvelopeJSONResponse` → `{code,data,message}` |
| 金额序列化 | Decimal → **字符串**（`cf.amount.toString()`） | Decimal → **字符串**（`DecimalStr` / `str()` 编码器） |
| 前端状态库 | React hooks + 自管 query | TanStack Query（`use-transactions` / `use-cash-balances`）+ zustand |
| 前端 API 客户端 | axios，手动拼 envelope | axios + `api-client.ts` 拦截器**自动解包信封**（code===0 取 data） |

**共性**：都采用分层（路由/Controller → Service → 计算内核）、JWT 鉴权、统一信封响应、Decimal→字符串防浮点漂移、TanStack Query 风格的缓存失效刷新。

**差异**：A 是标准 NestJS 模块 + 独立 Service 类；B 把写入逻辑内联在 router 里（没有 CashflowService），更轻但职责集中度低。A 前端手动处理信封；B 前端用拦截器自动解包。

---

## 2. 接口（API）设计对比

### 2.1 CashFlow 端点

| 方法 | 路径（A / B 一致） | A 处理函数 | B 处理函数 |
|---|---|---|---|
| POST | `/api/portfolios/{pid}/cashflows` | `CashFlowController.create` → `CashFlowService.create` | `create_cashflow` (data.py:187) |
| GET | `/api/portfolios/{pid}/cashflows` | `findAll`（分页/筛选） | `list_cashflows` (data.py:159) |
| GET | `/api/portfolios/{pid}/cashflows/{id}` | `findOne` | `get_cashflow` (data.py:177) |
| PATCH | `/api/portfolios/{pid}/cashflows/{id}` | `update` | `patch_cashflow` (data.py:218) |
| DELETE | `/api/portfolios/{pid}/cashflows/{id}` | `remove` | `delete_cashflow` (data.py:242) |

### 2.2 CashBalance 端点

| 方法 | 路径（A / B 一致） | A 处理函数 | B 处理函数 |
|---|---|---|---|
| POST | `/api/portfolios/{pid}/cash-balances` | `upsert`（覆盖式） | `create_cashbalance`（覆盖式 upsert，data.py:607） |
| GET | `/api/portfolios/{pid}/cash-balances` | `findAll` | `list_cashbalances` (data.py:592) |
| PATCH | `/api/portfolios/{pid}/cash-balances/{id}` | （无独立 patch，upsert 覆盖） | `patch_cashbalance` (data.py:634) |
| DELETE | `/api/portfolios/{pid}/cash-balances/{id}` | `remove` | `delete_cashbalance` (data.py:655) |

### 2.3 请求/响应形状

| 维度 | A（NestJS DTO） | B（Pydantic Schema） |
|---|---|---|
| 创建入参 `date` | `string` + `@IsDateString` | `date`（Python `date` 类型） |
| 创建入参 `type` | `CashFlowType` 枚举（`@IsEnum`） | `str`（枚举约束在路由层 `_coerce` 完成，非法→400） |
| 创建入参 `amount` | **`number`**（`@Type(Number) @IsNumber @Min(0.01) @Max(1e15)`） | **`DecimalStr`（字符串）**（`@field_validator` 校验 `v<=0` 报错） |
| 创建入参 `note` | `string? @MaxLength(500)` | `Optional[str]`（`max=200` 仅前端 zod 限制） |
| 列表查询 | `startDate/endDate/type/types/sortBy/sortOrder/page/pageSize`，`types` 逗号分隔转数组 | GET 参数解析（`query-params.ts`），分页同 `page/pageSize` |
| 响应 `amount` | **字符串** | **字符串** |
| 创建/更新/删除响应 | **附带 `recalculation` 字段**（`fromDate`/`affectedDays`/`skippedManualDays`） | **仅返回序列化实体，无 `recalculation` 字段**（前端用 fallback 文案兜底） |

**关键差异**：
- **`amount` 入参类型**：A 用 JS `number`（前端天然浮点，靠 DB `Decimal(18,2)` 兜底精度）；B 用字符串 `DecimalStr`（全程 `Decimal`，彻底规避浮点）。
- **`recalculation` 透出**：A 后端把重算结果写进响应体；B 后端只返回实体，前端 `use-transactions.ts` 的 `buildRecalcSuffix` 以 `已触发净值与 XIRR 重算` 等兜底文案反馈——**B 的 recalc 反馈是「降级」的**（与前端旧契约 `F3` 期望不一致）。

---

## 3. 出入金业务流程

### 3.1 创建一笔入金/出金

| 步骤 | A（NestJS） | B（Python） |
|---|---|---|
| 1. 归属校验 | `verifyOwnership`（404「组合不存在或无权访问」） | `get_portfolio`（404，不泄露存在性） |
| 2. 日期校验 | `validateDateNotFuture`（未来日期→400） | 复用通用日期处理（未见显式未来日拦截于 cashflow 创建；重算终点默认 `today_app_tz()`） |
| 3. 业务校验 | 无首笔类型校验 | **M1：首笔必须为存入**（若为 SELL 且组合尚无任何 CashFlow→400，data.py:192-204） |
| 4. 写入 | `prisma.cashFlow.create` | `db.add(CashFlow)` + `commit` |
| 5. 级联重算 | `recalculationService.recalculateRange(pid, date)` | `RecalculationService(db).recalculateRange(pid, req.date)` |
| 6. 返回 | 实体 + `recalculation` | 实体（无 recalculation） |

### 3.2 编辑 / 删除

- **A**：`update` 补丁更新 → 重算；`remove` 先查存在性 → 硬删 → 重算。前端 `AlertDialog` 二次确认（纯 UI）。
- **B**：`patch_cashflow` 重算区间取 `min(cf.date, old_date)`；`delete_cashflow` 删除后 `recalculateRange` + **`prune_zero_orphans`**（清理 0 值孤儿 DERIVED 快照，data.py:254-255）。前端 `AlertDialog` 二次确认。

### 3.3 审批 / 状态流转

**两项目均「未发现」任何审批流或状态机**。CashFlow / CashBalance 实体均无 `status` / `approvedAt` 字段；创建即生效、立即重算；前端的「确认删除」仅为 UI 层对话框，后端无对应状态逻辑。

---

## 4. 数据模型与状态流转

### 4.1 CashFlow 模型

| 字段 | A（Prisma） | B（SQLAlchemy） |
|---|---|---|
| 主键 | `id String @id @default(uuid())` | `id` = `pk_uuid()`（DB 端 `gen_random_uuid()`） |
| 组合外键 | `portfolioId`，`onDelete: Cascade` | `portfolio_id`，`ForeignKey(..., ondelete="CASCADE")` + `passive_deletes=True` |
| `date` | `DateTime @db.Date` | `date`（Python `Date`） |
| `type` | `CashFlowType` 枚举（PG 原生枚举 `BUY/SELL`） | `CashFlowType` 枚举（`str, Enum`，`native_enum=True`，`BUY/SELL`） |
| `amount` | `Decimal @db.Decimal(18, 2)` | `Numeric(18, 2)` |
| `note` | `String?` | `Text`（nullable） |
| 时间戳 | `createdAt` / `updatedAt` | `TimestampMixin`（created_at / updated_at） |
| 索引 | `@@index([portfolioId, date])` | `Index("ix_cashflows_portfolio_date", portfolio_id, date)` |
| 软删除 | **无**（硬删除） | **无**（硬删除 + FK CASCADE） |

### 4.2 CashBalance 模型（独立、零联动）

| 字段 | A（Prisma） | B（SQLAlchemy） |
|---|---|---|
| 主键 / 外键 | 同 CashFlow 模式 | 同 CashFlow 模式 |
| `amount` | `Decimal(18,2)` | `Numeric(18,2)` |
| `asOf` | `DateTime @db.Date` | `as_of`（Date） |
| 索引 | `@@index([portfolioId, asOf])` | `Index(..., portfolio_id, as_of)` |
| 写入语义 | upsert（删同日旧值 + 建新值，`$transaction` 原子） | 覆盖式 upsert（同 `as_of` 不重复插入） |

### 4.3 关联关系与级联

- **共性**：`Portfolio` 一对多持有 `cashflows` / `cashBalances` / `assetSnapshots` / `dailyNavs` / `dailyXirrs`；组合删除时 `onDelete: Cascade` 级联删出入金/余额/快照/NAV/XIRR。CashFlow 与持仓、**无直接外键**，仅通过「日期 + 计算层」间接参与 NAV/XIRR。
- **差异**：A 用 Prisma 声明式 `onDelete: Cascade`；B 用 SQLAlchemy `ondelete="CASCADE"` + `passive_deletes=True`（ORM 级联删除必备项，否则 `session.delete(parent)` 会先 UPDATE 子表 FK 为 NULL 报错）。

---

## 5. 关联业务逻辑（出入金如何影响余额 / 成本 / 快照 / NAV / XIRR）

| 影响链路 | A（NestJS） | B（Python） | 结论 |
|---|---|---|---|
| 出入金 → XIRR 现金流 | `buildCashflows`：BUY→负、SELL→正；同日净额 0 跳过；末位追加正终值=`totalAsset` | `calculation.py:142-148`：BUY→负、SELL→正；末位追加 `total_asset` 正终值 | **一致** |
| 出入金 → NAV 份额 | `computeNav`：成立日 `shares=buyAmount`；非成立日还原当日申赎求 shares | `finance_core/nav.py`：成立日 `day_buy>0` 才建链；`new_shares=(buy−sell)/unit_nav` | **一致**（口径对齐 PRD 附录 B） |
| 现金余额 → 总资产 | `computeDerivedBatch`：取 `asOf<=date` 最近一条 CashBalance，`totalAsset=marketValue+cashBalance` | `asset_valuation.py`：`_latest_cash_balance` 前向沿用，同公式 | **一致** |
| 出入金 → 现金余额 | **不自动改**（方案 B，仅 UI 软提示） | **不自动改**（前端明示「存取不会自动调整此值」） | **一致** |
| 持仓成本 | 仅由 `SecurityTrade` 推导 | 仅由 `SecurityTrade` 推导（`finance_core/holding.py`） | **一致** |
| 分红 | 不写 CashFlow、不触发重算引擎 | 不写 CashFlow、不触发重算引擎 | **一致** |
| 组合成立日 | `baseDate` = 首笔 `type:'BUY'` 的 `cashFlow.date`（设置后不可改） | `base_date` = `min(最早CashFlow日, 最早快照日)`，每次重算动态跟踪 | **细微差异**：A 首笔 BUY 后锁定不可改；B 动态调整 |
| 重算编排 | `recalculation.service.ts`：删 DERIVED 快照→逐事件日 persist→清理孤儿→NAV→XIRR | `recalculation.py`：同源逻辑（事件日集合驱动 + `prune_zero_orphans`） | **一致** |
| 费用字段 | CashFlow **无** fee/commission/stampTax | CashFlow **无** fee_total/commission/stamp_tax | **一致**（费用只在 SecurityTrade / Dividend） |

---

## 6. 金额计算规则与精度处理

| 维度 | A（NestJS） | B（Python） |
|---|---|---|
| 存储精度 | `Decimal(18, 2)` | `Numeric(18, 2)` |
| API 层 `amount` 类型 | `number`（浮点），DTO 仅 `@IsNumber`，**未限制小数位**（无 `@IsDecimal({decimal_digits})`） | `DecimalStr`（字符串），`@field_validator` 仅校验 `>0`，**也未限制小数位** |
| 后端显式四舍五入 | **不做**，直接写入，依赖 DB 列自动舍入到 2 位 | 同样依赖 DB `Numeric(18,2)` 约束 |
| 响应序列化 | Decimal→**字符串**（`toString()`） | Decimal→**字符串**（`str()` / `DecimalStr`） |
| NAV 精度 | `Math.round(x*100)/100`（2 位）参与派生层 | `_NAV_Q=1e-6` → `NUMERIC(12,6)` |
| XIRR 精度 | `Decimal(20,8)`；`|xirr|>1e11` 存 `null` 防溢出 | `_XIRR_Q=1e-8` → `NUMERIC(20,8)`；`_XIRR_MAX` 量程保护 + 落库 try/except 兜底 |
| 共享金额工具 | `shared/money.ts`（`toCents`/`sumMoney` 等）**cashflow 后端 DTO 未使用**（主要被 dividend 与前端的 zod 使用） | 无等价工具，精度由 `DecimalStr` + DB 约束保证 |
| 手续费 | 无 | 无 |

**共性**：DB 层统一 `Decimal(18,2)`、响应统一字符串化、NAV/XIRR 各自量化精度、XIRR 量程保护。

**关键差异**：
- **A 的 CashFlow 与同项目 Dividend 模块精度策略不一致**：Dividend 用 `@IsDecimal({decimal_digits:'0,2'})`（字符串）+ `toFixed(2)`；CashFlow 却用 `number` + 无小数位限制。B 全项目用 `DecimalStr` 风格，出入金与分红口径统一。
- **B 全程 `Decimal` 更稳妥**：金额在 API→DB 全程不丢精度；A 在 JS `number` 层可能引入浮点误差（虽最终由 DB 列约束）。

---

## 7. 校验机制对比

| 校验层 | A（NestJS / class-validator） | B（Python / Pydantic + 路由层） |
|---|---|---|
| `date` | `@IsDateString` | Python `date` 类型解析 |
| `type` | `@IsEnum(CashFlowType)`（编译期枚举） | `str` + 路由层 `_coerce(CashFlowType, ...)` 校验（非法→400 `VALIDATION_FAILED`） |
| `amount` | `@Type(Number) @IsNumber @Min(0.01) @Max(1e15)` | `DecimalStr` + `@field_validator` `v<=0`→400（**无显式上限**，依赖 DB `Numeric(18,2)`） |
| `note` | `@MaxLength(500)` | 后端 `Optional[str]`；前端 zod `max(200)` |
| 全局多余字段 | `ValidationPipe(whitelist+forbidNonWhitelisted)` → 多字段 400 | 未严格禁止未知字段（Pydantic 默认忽略额外字段） |
| 归属隔离 | `verifyOwnership` → 404 | `get_portfolio` → 404（`cf.portfolio_id != p.id` 二次校验） |
| 首笔必须为存入 | **无** | **有（M1）**（data.py:192-204） |
| 未来日期 | `validateDateNotFuture` → 400 | 创建入口未见显式拦截（重算终点用 `today_app_tz()` UTC+8） |
| HTTP 状态码映射 | 400→2000 / 401→1001 / 403→1002 / 404→3001 / 500→5000 | 400→`VALIDATION_FAILED(2000)` / 404→`NOT_FOUND(3001)` / 500→`INTERNAL_ERROR(5000)` |

**差异要点**：
- **首笔校验**：B 有 M1（首笔必须为存入），A 完全没有——A 允许一个组合以「取出(SELL)」作为首笔现金流，这在 NAV 成立日逻辑里可能产生不一致（依赖首笔 BUY 设 baseDate）。
- **未知字段处理**：A 严格拒绝未知字段；B 宽松忽略。
- **amount 上限**：A 显式 `@Max(1e15)`；B 无显式上限，仅靠 DB 列 `Numeric(18,2)` 上限（`99999999999999.99`）。

---

## 8. 异常情况与边界条件

| 边界场景 | A（NestJS） | B（Python） | 对比 |
|---|---|---|---|
| 负数 / 零金额 | `@Min(0.01)` 拒绝；前端 `Number(v)>0` | `_amount_positive`（`v<=0`→400）；前端 zod `>0` + `min="0.01"` | 一致 |
| 超大额 | `@Max(1e15)` 拦截 | 依赖 DB `Numeric(18,2)` 上限（无显式 API 校验） | A 更主动 |
| XIRR <2 条现金流 | `null` | `None`（xirr.py:49） | 一致 |
| XIRR 全同号 | `null` | `None`（xirr.py:51-52） | 一致 |
| XIRR 同日等量反向 | 返回 `0.0`（当日无收益） | 返回 `0.0`（pyxirr 退化行为） | 一致 |
| XIRR 量程溢出 | `|xirr|>1e11` 存 `null` | `_XIRR_MAX` 量程保护 + 落库 try/except | 一致（B 额外有每日起见 try/except 兜底，单日异常不阻断整区间） |
| NAV 成立日 `day_buy<=0` | `INCEPTION_WITHOUT_BUY` → 400 | 返回 `None`（跳过落库，不推进 prev） | **差异**：A 抛错阻断；B 容忍临时不完整状态 |
| NAV 除零 | `NON_POSITIVE_PRE_ASSET`（买入≥期末资产→400） | `prev.shares==0`/`nav_numerator==0`→`unit_nav=prev.cumulative_nav` 防除零 | 思路一致但实现不同（A 报错，B 容错） |
| 同日对冲净额 0 | `buildCashflows` 跳过该日（防 XIRR 发散） | 同日多笔合并，公式自然抵消 | 一致 |
| 删除后孤儿快照 | `cleanupOrphanDerivedSnapshots`（totalAsset=0 三条件才删） | `prune_zero_orphans`（删除日非事件日 + 区间内 0 值一律删） | 一致（B 命名更直接） |
| 软删除 | CashFlow/CashBalance 硬删除 | 硬删除 + FK CASCADE | 一致 |
| 时区 | `validateDateNotFuture` 用 `new Date(dateStr)`(UTC) 与本地 `new Date()` 比较，**跨时区边界日可能偏差**；写库用 UTC 午夜 | 重算终点 `today_app_tz()`（UTC+8 语义）；`date` 无时分秒 | 都有微妙时区边界，A 的「未来日」校验口径更易出边界问题 |
| 并发 / 幂等 | **无** CashFlow 幂等保护（同日同额可重复提交）；CashBalance 有 upsert 去重；重算异步非事务包裹（重算失败 cashflow 已落库不回滚） | **无** 显式锁/乐观并发；每个请求独立 `AsyncSession` 事务，重算在事务内 commit；无 `SELECT ... FOR UPDATE` | 一致（均无 CashFlow 去重/幂等） |
| CSV 导入 | cashflows **纯 insert 不去重**（同日多笔合法）；`new Prisma.Decimal`；仅调一次 `recalculateNavRange` | **绕过 M1 首笔校验**直接落库（data_transfer.py:537-548）；金额限 2 位小数（`max_scale=2`） | **差异**：B 导入可绕过首笔必须为存入业务规则，与 UI 创建路径不一致 |

---

## 9. 共性汇总（两项目共同具备）

1. **方案 B 数据拆解**：CashFlow（出入金流水）与 CashBalance（现金余额）两套独立数据，出入金不自动改余额。
2. **枚举语义**：`BUY=存入（现金流负）` / `SELL=取出（现金流正）`，均为两个枚举值，无 `DEPOSIT/WITHDRAW` 命名。
3. **金额存储**：`Decimal(18,2)` / `Numeric(18,2)`，响应统一**字符串化**防浮点漂移。
4. **无手续费**：CashFlow 无 fee/commission/stampTax；费用只存在于证券买卖/分红。
5. **无审批/状态机**：创建即生效、立即重算；无 status 字段。
6. **硬删除 + 组合级联**：无软删除；组合删除级联删出入金/余额/快照/NAV/XIRR。
7. **XIRR 边界**：<2 条、全同号、同日等量反向(0.0)、量程溢出保护。
8. **NAV 联动**：出入金通过 buy/sell 额改变份额，成立日建链。
9. **孤儿快照清理**：删除 CashFlow 后清理 0 值 DERIVED 快照防污染。
10. **JWT 鉴权 + 统一信封**：`{code,data,message}`，业务码 2000/3001/5000 等。
11. **CSV 导入不去重**：同日多笔合法。
12. **前端一致**：独立的 cashflow 管理页 + 录入/编辑弹窗 + 列表 + 现金余额手工维护区 + 二次确认删除 AlertDialog。

---

## 10. 差异汇总与风险清单

| #   | 差异点              | A（NestJS）                                                                    | B（Python）                                                                   | 风险/建议                                       |
| --- | ---------------- | ---------------------------------------------------------------------------- | --------------------------------------------------------------------------- | ------------------------------------------- |
| D1  | `amount` 入参类型    | `number`（浮点，靠 DB 兜底）                                                         | `DecimalStr`（字符串，全程 Decimal）                                                | B 精度更稳妥；A 在 JS 层可能浮点误差                      |
| D2  | 首笔必须为存入校验        | 无                                                                            | 有（M1）                                                                       | **A 风险**：允许首笔 SELL，可能与 baseDate=首笔 BUY 逻辑冲突 |
| D3  | 重算反馈透出           | 响应带 `recalculation` 字段                                                       | 响应仅实体，无该字段（前端 fallback 文案降级）                                                | **B 风险**：与前端旧契约 F3 不一致，反馈信息降级               |
| D4  | 精度约束覆盖           | CashFlow 用 number 无小数位限制；与同项目 Dividend（`@IsDecimal decimal_digits:'0,2'`）不一致 | 全项目 `DecimalStr`，出入金与分红口径统一                                                 | A 内部口径不一致                                   |
| D5  | amount 上限        | 显式 `@Max(1e15)`                                                              | 无显式上限（仅 DB 列约束）                                                             | B 略宽松                                       |
| D6  | 未知字段处理           | 严格禁止（whitelist+forbid）                                                       | 宽松忽略                                                                        | A 更安全                                       |
| D7  | NAV 成立日处理        | `day_buy<=0` 抛 400 阻断                                                        | 返回 None 跳过（容错临时不完整）                                                         | B 更健壮；A 更严格                                 |
| D8  | 组合成立日(base_date) | 首笔 BUY 后锁定不可改                                                                | 每次重算动态取 min                                                                 | 语义差异，需确认预期                                  |
| D9  | 未来日期拦截           | `validateDateNotFuture`（UTC 解析，跨时区边界易偏）                                      | 创建入口未见显式拦截                                                                  | A 的边界日校验口径有隐患                               |
| D10 | CSV 导入绕过业务校验     | 不去重但走标准创建约束                                                                  | **绕过 M1 首笔校验**直接落库                                                          | **B 风险**：导入可创建「首笔为取出」数据                     |
| D11 | Service 分层       | 独立 `CashFlowService` 类                                                       | 写入内联 router，无独立 Service                                                     | B 职责集中度低（维护性）                               |
| D12 | 响应字段漂移（B）        | —                                                                            | 前端 `TransactionResponse` 声明 `securityId/quantity/price/fee` 等，后端从不返回（旧契约遗留） | B 前端类型冗余                                    |

### 重点风险（建议优先处理）

1. **B 的 recalculation 响应缺失（D3）**：前端期望 `create/patch/delete` 返回 `recalculation`（F3 已获批），但后端只返回实体，导致重算反馈文案降级。需补齐或前端明确接受降级。
2. **B 的 CSV 导入绕过 M1（D10）**：UI 创建禁止「首笔为取出」，但导入可绕过，造成数据口径不一致。建议在导入路径复用首笔校验。
3. **A 缺首笔校验（D2）+ 成立日锁定（D8）**：A 既无首笔 SELL 拦截，又锁定 baseDate=首笔 BUY，理论上若首笔为 SELL 会产生不一致。B 用动态 `base_date` 规避了此问题。
4. **A 的 CashFlow 精度口径与自身 Dividend 不一致（D4）**：建议统一为字符串 Decimal 风格（与 B 对齐）。

---

## 附录：关键代码文件清单

### A 项目（app/）
- 后端：`packages/backend/src/modules/cashflow/{cashflow.controller.ts, cashflow.dto.ts, cashflow.service.ts, cashflow.module.ts}`
- 后端：`packages/backend/src/modules/cash-balance/{cash-balance.controller.ts, cash-balance.dto.ts, cash-balance.service.ts}`
- 后端：`packages/backend/src/modules/recalculation/recalculation.service.ts`、`valuation/asset-valuation.service.ts`、`calculation/{calculation.service.ts, nav.service.ts, xirr.service.ts}`
- 后端：`packages/backend/src/{app.module.ts, main.ts, common/filters/http-exception.filter.ts}`、`prisma/schema.prisma`
- 共享：`packages/shared/src/{enums.ts, money.ts}`、`packages/finance-core/src/{nav.ts, xirr.ts}`
- 前端：`packages/web/src/features/cashflow/{cashflow-form.tsx, cashflow-list.tsx, cash-balance-history.tsx}`、`hooks/{use-transactions.ts, use-cash-balances.ts}`、`api/{transaction.api.ts, cash-balance.api.ts}`、`pages/{transactions.tsx, dashboard.tsx}`

### B 项目（investment_return_tracker/）
- 后端：`backend/app/routers/{data.py, common.py}`、`backend/app/schemas.py`、`backend/app/schemas_resp.py`
- 后端：`backend/app/models/{cashflow.py, enums.py, portfolio.py}`、`backend/app/services/{recalculation.py, calculation.py, asset_valuation.py, data_transfer.py}`
- 后端：`backend/app/finance_core/{nav.py, xirr.py}`、`backend/app/core/{envelope.py, security.py, exceptions.py, enums.py, types.py}`
- 前端：`web/src/pages/transactions.tsx`、`web/src/features/cashflow/{cashflow-form.tsx, cashflow-list.tsx, cash-balance-history.tsx}`、`web/src/hooks/{use-transactions.ts, use-cash-balances.ts}`、`web/src/api/{transaction.api.ts, cash-balance.api.ts, types.ts}`、`web/src/lib/api-client.ts`

---

*本报告结论均来自对上述源码的直接阅读与交叉核验（含对 D1/D2/D3/D4 关键差异点的逐行复核），不涉及任何文档描述。*
