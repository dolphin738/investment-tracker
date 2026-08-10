# 架构模式对比报告：NestJS 参考实现（`app`）vs FastAPI 重写（`investment_return_tracker`）

> 对比对象：同一产品的两套实现。
> 仓库 A（只读参考）：`D:\sync\obsidian_wiki\w_wiki\04_Projects\AI Coding\app`（pnpm monorepo：`packages/backend` NestJS、`packages/web` React、`packages/finance-core`、`packages/shared`）
> 仓库 B（实际项目）：`D:\sync\obsidian_wiki\w_wiki\04_Projects\AI Coding\investment_return_tracker`（FastAPI + React）
>
> 声明：本报告结论严格建立在源码（文件路径 + 关键片段）之上，未读取任何 `docs/`、`README*`、`ARCHITECTURE.md`、`*.md`。源码注释中出现的「对齐 docs/ARCHITECTURE.md §x」仅作为代码自述被引用，不作为论据。

## TL;DR

两套实现在**外层契约上高度一致**（统一信封 `{code,data,message}`、业务错误码 1001/1002/…、JWT-HS256+bcrypt cost=10、派生快照重算编排、纯函数金融核心）。差异主要在**表达风格与落地成熟度**：A 用 NestJS 的「Module + `@Injectable` + 装饰器路由」把每个实体边界硬性固化，所有写操作集中在各 Module 的 Service 中；B 用 FastAPI 的「函数式 router + `Depends` + 独立 Service 类」，模块边界靠约定而非框架强制。B 当前处于「**半服务化**」状态：重算/估值/计算已抽成与 A 一一对应的 Service，现金流水在 router 层也已委托 `CashflowService`，但 **CSV 导入路径仍直接 `CashFlow(...)` + `db.add` 绕过 Service**（与 A 的导入路径同源问题对称），且 auth router 部分逻辑仍内联。A 的可维护性/一致性整体更成熟，B 在与 A 既定风格的对齐上已做大量工作，但内部仍不均匀。

---

## 1. 整体架构风格与分层

### 1.1 仓库 A（NestJS：模块化 + 分层）

A 以 `Module` 为唯一边界单元，每个业务域一个目录，内部固定 `controller / service / dto / module` 四件套。

- 根装配：`app.module.ts` 把 17 个业务 Module 全部 `imports`（`app.module.ts:28-56`），并通过 `providers:[{provide: APP_GUARD, useClass: JwtAuthGuard}]` 注册全局守卫（`:58-61`）。
- 启动装配：`main.ts:41-54` 注册全局 `ValidationPipe`（DTO 校验）、`HttpExceptionFilter`、`ResponseInterceptor`、`Swagger`。
- 典型 Module 边界：`cashflow.module.ts:12-18` 只 `imports:[RecalculationModule]`、`controllers:[CashFlowController]`、`providers:[CashFlowService]`，并 `exports:[CashFlowService]`。

**分层**：`Controller`（薄，仅参数解析 + 委托 Service）→ `Service`（承载写入 + 业务规则 + 重算触发）→ `PrismaService`（数据访问，全局 `@Global`）→ `finance-core`（纯算法）。

### 1.2 仓库 B（FastAPI：函数式 router + 独立 Service）

B 用 `APIRouter` 组织路由，每个 router 文件聚合多个子实体的 CRUD（`routers/data.py` 一个文件内含 cashflows/securities/trades/prices/cashbalances/snapshots 六组 router）。Service 为普通 Python 类，构造时注入 `AsyncSession`。

- 启动装配：`main.py:42-51` 设置 `default_response_class=EnvelopeJSONResponse`、`route_class=EnvelopeRoute`；`:62-69` 注册 5 个异常处理器；`:80-100` 逐个 `include_router`。
- 模块边界表达：靠 `APIRouter(prefix=..., tags=[...], route_class=EnvelopeRoute)`（`routers/data.py:63-65` 等），**框架不强制** provider/import 关系。

| 维度 | A（NestJS） | B（FastAPI） |
|---|---|---|
| 边界单元 | `@Module`（框架强制） | `APIRouter` + 约定（非强制） |
| 路由声明 | 装饰器 `@Get() @Controller()` | 函数装饰器 `@router.get()` |
| 写操作归属 | 各 Module 的 Service | Service 类（部分 router 仍内联，见 §8） |
| 全局横切 | `APP_GUARD` / `useGlobalFilters` / `useGlobalInterceptors` | `add_exception_handler` / `route_class` / `default_response_class` |

---

## 2. 依赖注入与装配

### 2.1 A：构造注入 + DI 容器 + 装饰器

- `@Injectable()` 标记可注入类，`@Module({providers, controllers, imports, exports})` 声明依赖图（`cashflow.module.ts:12-18`）。
- 构造注入：`CashFlowService` 构造函数注入 `PrismaService` 与 `RecalculationService`（`cashflow.service.ts:78-81`）；`RecalculationService` 注入 `PrismaService / AssetValuationService / CalculationService`（`recalculation.service.ts:40-44`）。
- 全局单例：`PrismaModule` 用 `@Global()` 让 `PrismaService` 全应用可注入（`prisma.module.ts:11-16`）。

### 2.2 B：构造注入 + `Depends`

- Service 类构造注入 `AsyncSession`：`CashflowService(PortfolioChildService)` 继承基类持有 `self.session`（`services/base.py:22-24`）；`RecalculationService.__init__(self, session)`（`services/recalculation.py:40-42`）。
- 请求级依赖：`get_db` 是 `Depends` 依赖（`db/database.py:31-34`），router 用 `db: AsyncSession = Depends(get_db)` 获取（`routers/data.py:71`）。
- 鉴权依赖：`user: CurrentUser = Depends(get_current_user)`（`routers/auth.py:57`）。

**边界表达差异**：A 的模块依赖在 `@Module.imports` 里显式声明（编译期可静态分析、循环依赖会被 framework 报错）；B 的 Service 间依赖是「运行期按需 `XxxService(self.session)` 实例化」（`services/cashflow.py:97` `RecalculationService(self.session)`），没有 import 图，依赖方向靠约定保证，循环依赖不会被框架拦截。

---

## 3. 数据访问层

### 3.1 A：Prisma（schema + SQL migration + repository 风格）

- 实体定义：`packages/backend/prisma/schema.prisma`（Prisma schema，单点事实源；`prisma/` 下含 `migrations/` 6 个版本化迁移目录，如 `20260804000000_init_schema_b/migration.sql`，以及 `seed.ts`）。
- 客户端：`PrismaService extends PrismaClient`（`prisma/prisma.service.ts:14-15`），全局可用。
- 访问方式：直接 `this.prisma.cashFlow.create({data})`、`this.prisma.assetSnapshot.deleteMany(...)`（`cashflow.service.ts:127`、`recalculation.service.ts:92`）。无独立 repository 类，Service 直接持有 `PrismaService`。
- 迁移：`package.json` 脚本 `prisma:migrate` → `prisma migrate dev`（`package.json:15`）。

### 3.2 B：SQLAlchemy 2.0 async + Alembic

- 实体定义：声明式 `Base`（`db/base.py:18-19`）+ 各 `models/*.py`，如 `models/cashflow.py:17-35`（`CashFlow(Base, TimestampMixin)`，`Numeric(18,2)`，`Enum(CashFlowType, native_enum=True)`）；`models/user.py:13-30`（`User`，含 `deleted_at` 软删）。
- 引擎/会话：`create_async_engine(... asyncpg)` + `async_sessionmaker` + `get_db` 依赖（`db/database.py:19-34`）。
- 访问方式：`select(CashFlow).where(...)` + `session.add()` / `session.execute(delete(...))`（`services/cashflow.py:88-96`、`services/asset_valuation.py:231-246`）。
- 迁移：`pyproject.toml` 依赖 `alembic==1.19.0`（`pyproject.toml:14`）；`alembic.ini` + `alembic/` 目录存在；`alembic/env.py:19-31` 以 `Base.metadata` 为 `target_metadata` 并 `import app.models`（autogenerate 比对模型）。

| 维度 | A（Prisma） | B（SQLAlchemy 2.0 async） |
|---|---|---|
| 实体定义 | `schema.prisma`（DSL） | Python `Mapped[mapped_column]` 声明式 |
| 会话 | `PrismaClient`（同步风格 Promise） | `AsyncSession`（原生 async/await） |
| 事务 | `prisma.$transaction([...])` / `async (tx)=>{}` | `session.commit()` 提交 + `session.flush()` |
| 迁移 | Prisma Migrate（SQL 迁移文件） | Alembic（Python 迁移脚本） |
| 命名 | snake_case via `@map`（DB 表名 snake） | 直接 snake_case 表名/列名（`db/base.py` 注释说明对齐 Prisma `@map`） |

---

## 4. 统一响应信封与错误处理

两套都实现 `{code, data, message}`，`code:0` 成功、非 0 业务错误。

### 4.1 A：Interceptor + ExceptionFilter

- 成功包装：`ResponseInterceptor` 把 handler 返回值包成 `{code:0, data, message:'ok'}`；`undefined→null`；已是信封则透传（`response.interceptor.ts:46-67`，`isEnvelope` `:37-44`）。
- 错误包装：`HttpExceptionFilter` 把任意异常转信封（`http-exception.filter.ts:122-171`）；业务码：异常自带 `code` 透传，否则按 HTTP 状态映射（`businessCodeByStatus` `:82-99`：`400→2000`、`401→1001`、`403→1002`、`404→3001`、`409→1003`、`500→5000`）。
- 注册：`main.ts:51-54` 全局 `useGlobalFilters` / `useGlobalInterceptors`。

### 4.2 B：自定义 `EnvelopeRoute` + 异常处理器

- 成功包装：`EnvelopeRoute(APIRoute)` 在路由构建期把 handler 包一层 `_wrap_endpoint`，返回 `{code:0, data, message:'ok'}`；`Decimal→str`；已是信封则透传（`core/envelope.py:70-97`、`104-119`）。`EnvelopeJSONResponse.render` 自写 JSON 序列化避免 `Decimal→float`（`envelope.py:52-58`）。
- 错误包装：`BusinessException(code, message, data, status_code)`（`core/exceptions.py:22-42`）；`business_exception_handler` / `http_exception_handler` 转信封；`HTTP_STATUS_TO_CODE` 映射（`:73`）。
- 注册：`main.py:49-50`（`default_response_class` + `route_class`）+ `:62-69`（`add_exception_handler`）。

**实现位置差异**：A 在「响应返回后」用拦截器/过滤器**运行时包裹**；B 在「路由注册时」用 `APIRoute` 子类**包裹 handler**，并用自定义 `JSONResponse` 接管序列化（绕过 FastAPI `response_model`，见 `schemas_resp.py:1-11` 注释）。两者最终契约等价，且都显式规避「双重包裹」。

**业务错误码**：
- A 定义在 `@investment-tracker/shared`（monorepo 共享包），如 `BUSINESS_ERROR_CODE`，filter 与 service 共同引用（`http-exception.filter.ts:42-49`、`auth.service.ts:36-40` 从 `@investment-tracker/shared` 引入）。
- B 镜像到 `core/enums.py:BusinessErrorCode(IntEnum)`（`core/enums.py:11-28`），并维护 `HTTP_STATUS_TO_CODE` / `CODE_TO_HTTP_STATUS` 两张映射表（`:32-54`）。
- 两者取值逐一对齐（1001/1002/1003/1004/1007/1008/1009/2000/3001/5000），符合「三端共用单一事实来源」的意图。

---

## 5. 鉴权

### 5.1 A：Passport JWT 策略 + 全局 Guard

- Guard：`JwtAuthGuard extends AuthGuard('jwt')`，全局注册，遇 `@Public()` 元数据放行（`jwt-auth.guard.ts:18-36`）。
- 策略：`JwtStrategy`（passport-jwt），从 Bearer 取 token，验签后 `validate()` 查库确认用户存在且未软删，挂 `request.user={userId,email}`（`jwt.strategy.ts:42-55`）。
- Payload：`{sub, email}`（`auth.service.ts:49-58`），`signAsync` 签发（`:85-88`）。
- 密码哈希：`bcrypt` `BCRYPT_ROUNDS = 10`（`auth.service.ts:67`），`bcrypt.hash(password, 10)`（`:151`）、`bcrypt.compare`（`:107,181`）。
- 查库鉴权落点：`jwt.strategy.ts:43`（`prisma.user.findUnique`）+ `auth.service.ts` 的 login/register（每次请求经策略查库）。

### 5.2 B：依赖注入式 `get_current_user`

- 依赖：`get_current_user(creds=Depends(_bearer), db=Depends(get_db))`，验签 → 查 `select(User).where(User.id==sub)` → 校验 `deleted_at`（`core/security.py:67-106`）。`auto_error=False` 以便自行抛 1001（`:27-28`）。
- Payload：`{sub, email, iat, exp}`，HS256（`core/security.py:31-39`）。
- 密码哈希：`bcrypt.hashpw(password, bcrypt.gensalt(rounds=10))`（`core/security.py:48-52`，注释说明跨语言兼容旧库哈希）。
- 查库鉴权落点：`core/security.py:97-99`（每个受保护请求查库）。

| 维度 | A | B |
|---|---|---|
| 机制 | Passport `AuthGuard('jwt')` + 全局 Guard | FastAPI `Depends(get_current_user)` 逐路由声明 |
| 跳过鉴权 | `@Public()` 装饰器 + `Reflector` | 不声明依赖（公开路由天然无此依赖，无等价元数据） |
| payload | `{sub, email}` | `{sub, email}`（含 iat/exp） |
| bcrypt cost | 10 | 10（注释强调与 A 跨语言兼容） |
| 查库 | 策略 `validate()` 每次请求查 User | `get_current_user` 每次请求 `select(User)` |

---

## 6. 业务计算（XIRR / NAV）

两边都把金融数学抽成**零依赖纯函数核心包**，由「计算 Service」做 DB 查询适配。

### 6.1 A：`packages/finance-core`（自研 Newton-Raphson）

- `finance-core/src/xirr.ts`：`calculateXirr` 用 Newton-Raphson 迭代（初始 0.1、`maxIter=100`、`tol=1e-7`、全同号→`null`、同日→`null`、`rate≤-0.999` 钳制）（`xirr.ts:70-127`）。文件头注释明确「**本文件由 backend/src/modules/calculation/xirr.service.ts 原样迁出**」（`:19-22`）。
- `finance-core/src/nav.ts`：`computeNav` 纯函数单位份额法（`nav.ts:98-190`），业务校验抛 `NavCalculationError`（`:62-73`）。
- `index.ts` 导出纯函数，声明「**零运行时依赖**」（`:6-9`）。
- 调用方：`modules/calculation/xirr.service.ts` 是**薄适配层**，仅做 Prisma 查询，数学委托 `calculateXirr as calculateXirrPure`（`xirr.service.ts:5-41`）；`calculation.service.ts:41-99` 的 `triggerCalculation` 串起 Nav→XIRR。

### 6.2 B：`backend/app/finance_core`（委托 pyxirr）

- `finance_core/xirr.py`：**`import pyxirr`**，数值核心委托 `pyxirr.xirr(dates, amounts, guess=0.1)`（`xirr.py:18`、`57`）；float f64 → `Decimal` 量化 8 位（`NUMERIC(20,8)`），含超量程保护（`:22-80`）。注释说明「数值核心委托 pyxirr」「精度/口径对齐 pyxirr」。
- `finance_core/nav.py`、`holding.py`：纯函数（`compute_daily_nav` / `derive_holdings`）。
- 调用方：`services/calculation.py:CalculationService.compute_range` 做 SQLAlchemy 查询 + 调 `finance_core.calculate_xirr` / `compute_daily_nav`（`:21-22`、`:117`、`:148`）。

**关键差异（是否委托外部库）**：A **自研** Newton-Raphson（纯 TS，无第三方数值库）；B **委托 `pyxirr`**（外部库，`pyproject.toml:18`）。功能口径一致（guess=0.1、ACT/365、全同号→None），但数值实现来源不同：A 完全自包含、可独立测试；B 依赖 `pyxirr` 的数学结果（精度/行为跟随该库）。两边都为「纯函数核心 + 薄适配 Service」结构，对齐良好。

---

## 7. 事务与一致性 / 派生快照重算编排

两边把「派生净值快照重算」拆成三个 Service，依赖方向**完全一致**：

- `RecalculationService`（统一入口：T1~T4 `recalculateRange` / T5 `recalculateNavRange`）
- `AssetValuationService`（写 `source='DERIVED'` 快照，遇 `MANUAL` 跳过）
- `CalculationService`（单日 NAV→XIRR，落 `daily_nav`/`daily_xirr`）

### 7.1 A 编排（`recalculation.service.ts`）

- `recalculateRange`：① `DELETE` 区间内 `DERIVED`（`prisma.assetSnapshot.deleteMany`，`:92-98`）→ ② 逐事件日 `assetValuation.persistDerived`（`:105-107`）→ ②.5 `cleanupOrphanDerivedSnapshots`（`:116`）→ ③ `recalculateNavRange`（`:124`）。
- 孤儿清理：`cleanupOrphanDerivedSnapshots` 用 `this.prisma.$transaction([deleteMany x3])` 同事务删快照+nav+xirr（`:232-242`）。
- 单向依赖：`recalculation → valuation → calculation`，无反向（`calculation.service.ts:13-17` 注释）。

### 7.2 B 编排（`services/recalculation.py` / `asset_valuation.py`）

- `recalculateRange`：① `session.execute(delete(AssetSnapshot)...)`（`:82-89`）→ ② 逐事件日 `av.persistDerived`（`:93-94`）→ `session.flush()`（`:95`）→ ③ `recalculateNavRange`（`:97`）。
- 孤儿清理：`AssetValuationService.prune_zero_orphans`（`:271-301`）+ `CashflowService.delete` 内再调一次 `recalculateNavRange`（`services/cashflow.py:128-130`）。
- 依赖方向同样单向（`asset_valuation.py:8-10` 注释「valuation 不再依赖 recalculation」）。

**事务差异**：A 在孤立清理处显式用 `$transaction([...])`；B 全程靠单个 `AsyncSession` 的 `commit/flush` 隐式事务（`services/calculation.py:161` `session.commit()`）。两者 cashflow 写入与重算都**非原子**：A 是 `prisma.cashFlow.create()` 后单独 `recalculateRange()`（`cashflow.service.ts:127-141`）；B 是 `session.add(cf); session.commit()` 后 `recalculateRange()`（`services/cashflow.py:95-99`）。一致地未把「写+重算」包进同一事务。

---

## 8. 写入逻辑归属（重点）

### 8.1 任务前提的修正

任务描述假设「B 的 cashflow 创建/修改/删除**内联在 router**（`routers/data.py`）」。但**当前源码已不是这样**：`routers/data.py:89-133` 的 `create_cashflow/patch_cashflow/delete_cashflow` 全部委托 `CashflowService(db).create/patch/delete`，与 A 的 `cashflow.controller.ts:40-88`（委托 `CashFlowService`）如出一辙。即 **B 的 cashflow router 已服务化**，与 A 对齐。

### 8.2 真正的「逻辑分叉 / 双真源」在 CSV 导入路径

问题不在 cashflow router，而在 **CSV 导入**路径——且**两套都存在同源问题**：

- **A `DataTransferService.commit`**：在 `prisma.$transaction(async (tx)=>{...})` 内直接 `tx.cashFlow.create({data})`（`data-transfer.service.ts:522-531`），**绕过 `CashFlowService`**；提交后仅调一次 `recalculateNavRange`（`:578-590`）。
- **B `commit_import`**：`cashFlows` 分支直接 `db.add(CashFlow(portfolio_id=..., ...))`（**绕过 `CashflowService`**），`db.commit()` 后调一次 `recalculateRange`/`recalculateNavRange`（`services/data_transfer.py:537-569`、`597-619`）。

更具体的分叉证据（仅 B 侧，因为 B 给 cashflow 加了 A 没有的规则）：
1. **M1「首笔必须为存入（BUY）」校验重复实现**：
   - `CashflowService.create` 内实现（`services/cashflow.py:73-87`）；
   - CSV 路径又**独立重写了一遍**（`services/data_transfer.py:541-558`，注释「D10：导入补齐 M1…与 UI 创建口径一致」）。
   - 两者逻辑相同但**代码分叉**——若后续在 Service 侧改 M1 口径，导入路径不会自动同步。
2. **删除后孤儿清理只在 Service 侧**：`CashflowService.delete` 在 `recalculateRange` 后又调 `prune_zero_orphans` + 二次 `recalculateNavRange`（`services/cashflow.py:124-130`）；导入路径只做插入、无删除分支，故不触发该清理——但**构造路径本身绕过了 Service**，使「未来若在 Service.create 加副作用（如写审计/事件），导入将漏掉」成为结构性风险。

### 8.3 另一个 B 内部不均：auth router 部分内联

`routers/auth.py` 中 `register/login/restore/password/email/delete_account` 委托 `UserService`（`:30-147`），但 `me`/`get_profile`/`profile` **直接在 router 内写 DB**（`select(User)...scalar_one()`、`u.name=...; await db.commit()`，`auth.py:57-108`）。A 的 `auth.controller.ts` 则**全部**委托 `AuthService`。说明 B 是「部分服务化」而非全面服务化。

### 8.4 小结（写入归属对照）

| 写入口 | A | B |
|---|---|---|
| cashflow 单条 CRUD（UI） | `CashFlowService`（controller 薄） | `CashflowService`（router 薄，已对齐） |
| cashflow CSV 导入 | 直接 `tx.cashFlow.create`（绕过 Service） | 直接 `CashFlow(...)`+`db.add`（绕过 Service） |
| trade/snapshot CSV 导入 | 直接 `tx.securityTrade.create` / `upsert` | 直接构造 + `upsertManual`（`data_transfer.py:509-595`） |
| auth 写操作 | 全部 `AuthService` | 混合：`UserService` + router 内联 |
| 删除孤儿清理 | `recalculateRange` 内 `cleanupOrphanDerivedSnapshots` | `CashflowService.delete` 内 `prune_zero_orphans` |

**结论**：B 相对 A 的确「半服务化」——重算/估值/计算三件套已与 A 一一对应抽成 Service，cashflow 单条写入也已服务化；但**导入路径仍直接造 ORM 对象**（与 A 同源），且 B 额外在导入路径复制了 M1 校验，构成「双真源/逻辑分叉」。这是 B 相对 A 更需收敛的点。

---

## 9. 测试策略

### 9.1 A：Jest + ts-jest，单测与源码同目录

- 配置：`jest.config.js`（preset `ts-jest`、`roots:['<rootDir>/src']`、`testRegex:'.*\\.spec\\.ts$'`），`moduleNameMapper` 把 `@investment-tracker/shared`、`@investment-tracker/finance-core` 映射到 TS 源码（免先 build）。
- 组织：`.spec.ts` 与源码**同目录共置**，如 `recalculation.service.spec.ts`、`auth.service.spec.ts`、`data-transfer.service.spec.ts`、`holding-derivation.service.spec.ts`、`calculation/*.spec.ts`、`portfolio.service.spec.ts`、`filters/*.spec.ts` 等。
- 纯函数测试：`finance-core/src/__tests__/xirr.spec.ts`、`nav.spec.ts`；并配套 `finance-core/src/testing/in-memory-prisma.ts`（内存 Prisma，供 Service 单测 mock）。
- 脚本：`package.json` `"test":"jest"`（`:12`）。

### 9.2 B：pytest + pytest-asyncio，集成测试集中 `tests/`

- 配置：`pytest.ini`（`asyncio_mode = strict`、`asyncio_default_test_loop_scope = function`，`:9-10`）+ `pyproject.toml` 同样 `asyncio_mode="strict"`、`testpaths=["tests"]`（`:32-37`）。
- 组织：`backend/tests/` 独立目录，**真实 PostgreSQL** 集成测试：`test_api_*.py`（httpx `AsyncClient`+`ASGITransport` 打真实 app）、`test_calculation_service.py`（Service 级）、`test_finance_core.py`（纯函数）、`test_models.py`、`test_contract.py`、`test_defect_fixes.py` 等。
- 夹具：`conftest.py` 用 `NullPool` 每测试重建引擎（规避 asyncpg loop 错位），`_clean_db` autouse `TRUNCATE ... RESTART IDENTITY CASCADE`，`client` 用 `httpx.AsyncClient(transport=ASGITransport(app=app))`（`conftest.py:26-65`）。

| 维度 | A | B |
|---|---|---|
| 框架 | Jest + ts-jest | pytest + pytest-asyncio |
| 位置 | 与源码同目录 `*.spec.ts` | 独立 `tests/` 包 |
| 数据库 | `in-memory-prisma`（快、隔离好） | 真实 Postgres（重、贴近生产） |
| 风格 | 单元为主、DI 易 mock | 集成/API 为主、需真实 DB |
| async | ts-jest 原生 | `asyncio_mode=strict` 显式标记 |

---

## 10. 前端（简述）

两套前端目录结构**几乎逐字相同**（均含 `__tests/ api App.tsx components constants features hooks index.css lib main.tsx pages stores types`）：
- 仓库 A：`app/packages/web/src/`（React + `stores/` 状态管理 + `api/` 客户端 + `features/` 分域）。
- 仓库 B：`investment_return_tracker/web/src/`（同结构，`stores/`、`api/`、`features/`、`types/`）。

可见 B 的 web 是 A 的近乎 1:1 复刻（同一 React 技术栈、同一目录约定、同一 `api` 信封解包与 `stores` 状态管理风格），前端不是本次架构对比的重点分歧点。后端信封/错误码对齐后，前端基本可复用。

---

## 11. 结论：评分与总结

### 11.1 评分（满分 10，基于源码证据）

| 评估维度 | A（NestJS 参考） | B（FastAPI 实际） | 说明 |
|---|---|---|---|
| 可维护性 | **9.0** | **7.5** | A 的 `@Module` 强制边界、每实体独立 Service，改造可定位；B 边界靠约定，router 内偶有内联（auth）、导入路径绕过 Service。 |
| 可测试性 | **8.5** | **7.0** | A 内存 Prisma + DI mock，单测快；B 需真实 Postgres，集成为主，运行成本高但更贴近生产。 |
| 一致性 | **9.0** | **7.0** | A 全仓统一 Module 模式；B 内部不均：cashflow 服务化、auth 混合、导入路径分叉。 |
| 与既定风格一致性 | — | **8.0** | B 对外契约（信封/错误码/JWT/重算编排/纯函数核心）高度对齐 A，映射关系清晰。 |
| 成熟度（整体） | **9.0** | **7.5** | A 是完整成熟参考实现；B 功能闭环已齐，但内部重构未完成。 |

### 11.2 总结

1. **契约层高度对齐**：信封 `{code,data,message}`、业务错误码、JWT-HS256+bcrypt(10)、派生快照重算三件套、纯函数金融核心——B 几乎 1:1 镜像 A，映射关系在源码中可逐点验证（如 `core/enums.py` ↔ `@investment-tracker/shared`、`EnvelopeRoute` ↔ `ResponseInterceptor`+`HttpExceptionFilter`）。
2. **表达风格不同**：A 用框架强制的模块化 + DI，边界清晰、可静态分析；B 用函数式 router + 运行期 `XxxService(session)`，灵活但边界软、依赖方向靠约定。
3. **金融计算来源不同**：A 自研 Newton-Raphson（零依赖、可独立测）；B 委托 `pyxirr`（跟库行为）。功能等价，工程取舍不同。
4. **B 现状 = 半服务化（核心判断）**：重算/估值/计算已与 A 一一对应抽成 Service；cashflow 单条写入 router 也已委托 `CashflowService`；但 **CSV 导入路径仍直接 `CashFlow(...)`+`db.add` 绕过 Service**，且与 A 的导入路径是**同源问题**（两边都绕过各自 Service）。B 还额外在导入路径复制了 M1 校验，构成「双真源/逻辑分叉」；auth router 亦部分内联。
5. **建议收敛点（给 B）**：把 `services/data_transfer.py` 的 cashflows/trades/snapshots 构造改为调用对应 `CashflowService/SecurityService/...` 的导入友好方法（或抽 `import_rows` 共享入口），消除 M1 等规则的双份实现；将 auth router 内联的 `me/profile` 收口到 `UserService`，使 B 从「半服务化」走向与 A 等价的全服务化。

> 一句话：A 是「框架托底的严格模块化参考」，B 是「契约对齐、结构半服务化的 FastAPI 重写」——外围已对齐，内部写入归属仍需把导入与 auth 两条旁路收口到 Service。
