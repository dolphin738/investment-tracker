# 代码架构对比报告：旧项目（NestJS/TypeScript） vs 新项目（FastAPI/Python）

> 本报告**仅依据真实源代码文件**（`.ts` / `.tsx` / `.py` / `.json` 配置等）的结构、import 关系、类/函数定义、装饰器、依赖注入、目录组织得出，不依赖任何 `*.md`/README/注释文字下结论。注释与结构冲突时以结构为准。
>
> 仓库路径：
> - 旧：`D:/sync/obsidian_wiki/w_wiki/04_Projects/AI Coding/app`（pnpm monorepo：`packages/backend`、`packages/web`、`packages/shared`、`packages/finance-core`）
> - 新：`D:/sync/obsidian_wiki/w_wiki/04_Projects/AI Coding/investment_return_tracker`（`backend/app` + `web`）

---

## 0. 执行摘要（结论先读）

新项目后端是**旧项目后端在 FastAPI/SQLAlchemy 上的"同契约重写"**：它刻意 1:1 复刻了旧后端的 API 信封 `{code,data,message}`、业务错误码（1001–5000）、JWT（HS256，`{sub,email}`）、金融算法口径（单位份额净值法 / XIRR）、Decimal 字符串化金额、UTC+8 口径，甚至连 `core/envelope.py`、`core/exceptions.py` 的注释都写明"镜像 app 的 HttpExceptionFilter / ResponseInterceptor"。因此**前端可零改动复用**——新仓 `web/src` 与旧仓 `packages/web/src` 在文件级几乎一致（同名 `api/*`、`stores/*`、`features/*`、同名 `__tests__/sop-control.test.ts`、均 `import '@investment-tracker/shared'`）。

二者**架构理念一致**（分层 + 服务化 + 纯函数计算 + 统一信封 + 统一错误码 + 数据隔离），但在**"模块边界的强制力"**上差异显著：旧项目用 NestJS 的 `@Module` 与 IoC 容器提供**编译期模块边界**、用 factory provider / Passport 策略支撑解耦与扩展；新项目以**目录约定分层 + FastAPI `Depends` 做请求级 DI + `EnvelopeRoute` 子类做全局切面**，更轻量、依赖更少，但分层边界靠开发纪律维持、重构安全性较弱。

---

## 1. 目录与模块组织方式

| 维度 | 旧项目（NestJS） | 新项目（FastAPI） |
|------|------------------|-------------------|
| 仓库形态 | pnpm + turbo **monorepo**；`packages/` 下分 `backend`、`web`、`shared`(TS 类型)、`finance-core`(TS 纯函数) | **单仓单包**；`backend/app`（Python 包）+ `web`（React，文件级复制旧 web） |
| 后端顶层 | `src/{main.ts,app.module.ts}` + `common/`、`modules/`、`prisma/` | `app/{main.py}` + `core/`、`routers/`、`services/`、`models/`、`db/`、`finance_core/`、`schemas.py`、`schemas_resp.py`、`serializers.py` |
| 业务拆分单位 | **按功能模块建目录**：`modules/<feature>/` 内含 `*.controller.ts` + `*.service.ts` + `*.module.ts` + `dto/`（如 `auth/`、`portfolio/`、`calculation/`、`data-transfer/`、`upload/` 等 20 个模块） | **按层建目录**：`routers/`、`services/`、`models/` 各自一文件一资源；同一文件可挂多个 `APIRouter`（如 `routers/calc.py` 内含 `router_holdings/router_xirr/router_nav/router_recalculate`） |
| 跨切面逻辑 | `common/`（decorators、dto、filters、guards、interceptors、utils） | `core/`（config、envelope、exceptions、security、enums、types、date_utils） |
| 数据访问层 | `prisma/`（PrismaService 继承 PrismaClient；PrismaModule 全局导出）；**实体定义在 `schema.prisma`（生成 `@prisma/client`），src 内无手写实体类** | `db/`（database.py 引擎/会话、base.py 声明基类/混入）+ `models/`（SQLAlchemy 2.0 声明式 ORM 类，手写） |
| 算法内核 | `packages/finance-core`（独立 TS 包，零依赖纯函数，被 calculation 服务 import） | `app/finance_core/`（本地 Python 子包：`nav.py`/`xirr.py`/`holding.py`，纯函数 dataclass） |
| 前端目录 | `packages/web/src`：api / components / features / hooks / lib / pages / **stores**(Zustand) / constants | `web/src`：与旧仓**同名同构**（api / components / features / stores / …），未重构 |

**观察结论**：旧项目用"模块"作为一等公民组织代码（模块 = 功能 + 边界）；新项目用"分层目录"组织代码（router/service/model 是横向切片）。新项目的 `finance_core` 与旧的 `packages/finance-core` 角色一致（纯函数算法），但前者内嵌为子包，不再跨语言复用。

---

## 2. 核心设计模式

| 模式        | 旧项目（NestJS）                                                                                                                                                         | 新项目（FastAPI）                                                                                                                         |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| 分层        | Controller → Service → Repository（Repository 由 Prisma Client 承担）                                                                                                    | Router（handler）→ Service → SQLAlchemy Session/Model                                                                                  |
| 控制反转 / DI | **完整 IoC 容器**：`@Module({providers,controllers,exports})`，构造器注入（`constructor(private prisma: PrismaService)`）；`APP_GUARD`、`registerAsync` + `useFactory` 工厂 provider | **无容器**：Service 在 handler 内手动 `UserService(db)` 实例化；请求级依赖用 FastAPI `Depends(get_db)`、`Depends(get_current_user)` 注入；Session 作为构造参数透传 |
| 装饰器驱动     | 重度：`@Controller` `@Get` `@Injectable` `@Module` `@UseGuards` `@Public` `@CurrentUser` `@Catch` `@Injectable`                                                        | 中等：`@router.get` 路由装饰器 + `@app.add_exception_handler`（显式注册，非装饰器）                                                                     |
| 面向切面（AOP） | `ResponseInterceptor`（成功包信封）、`HttpExceptionFilter`（异常包信封）、`JwtAuthGuard`（鉴权）均为**全局**                                                                                | `EnvelopeRoute(APIRoute)` 子类在路由构建期包裹 handler（成功包信封）；异常处理器显式注册（异常包信封）；鉴权为**每路由** `Depends(get_current_user)`                          |
| 校验 / 序列化  | `class-validator` + `class-transformer`（DTO 类 + 全局 `ValidationPipe{transform:true}`）；响应在 Service 内 `toResponse()` 手动转驼峰/日期字符串                                       | Pydantic v2（`schemas.py` 入参校验、`schemas_resp.py` 响应模型仅给 OpenAPI）；ORM→dict 由 `serializers.py` 纯函数完成；`DecimalStr` 标注                    |
| 认证策略      | Passport + `JwtStrategy extends PassportStrategy`（`passport-jwt`），`@nestjs/jwt`                                                                                     | `HTTPBearer(auto_error=False)` + `jwt` 库 + `get_current_user` 依赖（自实现验签+查库）                                                           |
| 调度        | `ScheduleModule.forRoot()` + `@Cron`（CleanupService 物理清理软删账户）                                                                                                       | 未见（新后端未实现定时清理任务）                                                                                                                     |
| 工厂 / 抽象   | `StorageService` 抽象 + `storageServiceFactory`（按 `STORAGE_DRIVER` 选本地/COS/S3）                                                                                        | 未见存储抽象；上传直接落 `UPLOAD_DIR`                                                                                                            |

**观察结论**：旧项目是"框架即架构"——NestJS 强制分层与模块边界；新项目是"代码即架构"——用 FastAPI 的 `Depends` 与自定义 `APIRoute` 复刻同等能力，但约束力来自约定而非框架。

---

## 3. 组件 / 模块间依赖与耦合关系

| 维度 | 旧项目（NestJS） | 新项目（FastAPI） |
|------|------------------|-------------------|
| 依赖声明 | `@Module` 的 `imports/exports` **显式声明**编译期边界 | 无模块系统；依赖即 Python `import`，**无编译期边界** |
| 依赖方向（可观测） | 有意保持**无环**：`PortfolioModule → RecalculationModule → CalculationModule → (PrismaService 全局) + finance-core`；`RecalculationModule` 还 `imports ValuationModule`（`valuation/`）；`DataTransferModule` 依赖 `RecalculationModule`（见各 `.module.ts` 注释与 imports） | `routers/ → services/ → models/ + finance_core/ + db/`；`services/` 间少量直接 import（如 `services/user.py` 懒导入 `services.upload._remove_old`；`routers/data_transfer.py` 用 `from app.services import data_transfer`） |
| 反向依赖防护 | 模块边界天然阻止 service→router 反向引用 | 曾存在 service→router 反向依赖，后把 `serialize_*` 从 `routers/common.py` 抽到独立 `serializers.py`（见 `serializers.py` 注释）以保持单向 |
| 解耦手段 | 接口/抽象（`StorageService`）+ 工厂 provider；Passport 策略可替换；`PrismaModule` 用 `@Global()` 一处提供全局复用 | 靠目录约定 + 共享 `AsyncSession`；信封统一由 `EnvelopeRoute` 处理，service 只返回纯 dict，间接降低耦合 |
| 跨语言共享 | `packages/shared`(TS 类型，如 `BUSINESS_ERROR_CODE`、`UserPublic`) 被后端与前端共同 import | 后端**无** TS `shared` 包；`core/enums.BusinessErrorCode` 是 Python 侧"镜像"，与旧 `shared/types/api.ts` 保持数值一致（注释明示） |

**观察结论**：旧项目用模块系统把耦合"焊死在边界上"，扩展新功能=新建模块并声明 imports；新项目耦合更松也更隐式，重构时缺少编译器保护（例如 service 误 import router 不会报错，只能靠约定）。

---

## 4. 数据流与状态管理

| 阶段 | 旧项目（NestJS） | 新项目（FastAPI） |
|------|------------------|-------------------|
| 请求入口 | `main.ts`：`NestFactory.create` → `setGlobalPrefix('api')` → 全局 `ValidationPipe` → 全局 `HttpExceptionFilter` → 全局 `ResponseInterceptor` | `main.py`：建 `FastAPI`（`default_response_class=EnvelopeJSONResponse, route_class=EnvelopeRoute`）→ `app.add_exception_handler(...)` → `include_router(...)` → 挂载静态 |
| 鉴权流 | 全局 `JwtAuthGuard`（`APP_GUARD`）→ `@Public()` 放行；`JwtStrategy.validate()` 查库后把 `{userId,email}` 挂 `request.user`；`@CurrentUser()` 取参 | 受保护路由签名声明 `user: CurrentUser = Depends(get_current_user)`；`get_current_user` 验签→查库→返回 `CurrentUser`；缺 token 自己抛 1001（非 Starlette 403） |
| 业务处理 | Controller 取 `@Body()` DTO + `@CurrentUser()` → 调 Service（构造函数注入 `PrismaService`）→ 返回裸对象 | Router 取 Pydantic `req` + `Depends(get_db)` → 调 `Service(session)` → 返回 dict/ORM |
| 序列化 | Service 内 `toResponse()` 手写：日期→`YYYY-MM-DD`/`ISO`，Decimal 原样（Prisma Decimal 经 JSON 即字符串） | `serializers.py` 纯函数 `serialize_*(orm)→camelCase dict`；`EnvelopeJSONResponse.render` 用 `decimal_jsonable_encoder`（Decimal→str、date→iso） |
| ORM 用法 | `PrismaService`（`extends PrismaClient`）：`prisma.portfolio.create/findMany/deleteMany/$transaction`；枚举来自 `@prisma/client` | `AsyncSession` + SQLAlchemy 2.0：`select/insert/delete` + `session.commit()`；模型在 `models/` 声明；枚举在 `models/enums.py`（`str,Enum`） |
| 事务 | `prisma.$transaction([...])`（数据迁移 commit 阶段） | `async with session` 单会话；导入 commit 用单次事务循环 `tx.*`（见 `data_transfer` 注释"单事务 + 单次重算"） |
| 后端状态 | **无状态**：每请求走 Prisma 连接池；JWT 自包含 | **无状态**：每请求新建 `AsyncSession`（`get_db` 依赖） |
| 前端状态 | React + **Zustand**（`stores/auth|portfolio|preference.store.ts`，`create` from 'zustand'）+ `localStorage` 持久化 token | 与旧仓**同一套**（文件级复制的 Zustand stores） |
| 金额口径 | `Prisma.Decimal`，wire 为字符串 | `decimal.Decimal`，`DecimalStr` 标注 + `EnvelopeJSONResponse` 序列化为字符串（"与 app shared 口径一致"） |

**观察结论**：两者数据链路同构——「鉴权依赖 → Service 编排 → ORM 读写 → 手动序列化 → 统一信封」。差异在 ORM 范式（约定式 Prisma schema vs 声明式 SQLAlchemy）与 Session 生命周期（连接池 vs 请求级 async session）。

---

## 5. 路由或入口结构设计

| 维度 | 旧项目（NestJS） | 新项目（FastAPI） |
|------|------------------|-------------------|
| 入口组装 | `app.module.ts` 导入所有业务模块 + `ConfigModule.forRoot({isGlobal:true})` + `APP_GUARD: JwtAuthGuard` | `main.py` 逐个 `app.include_router(...)`；`FastAPI(...)` 构造即指定 `route_class=EnvelopeRoute` |
| 路由注册 | **装饰器**：`@Controller('auth')` + `@Post('login')`；全局前缀 `/api`（`setGlobalPrefix`）；Swagger `DocumentBuilder().addBearerAuth()` | **APIRouter**：`APIRouter(prefix="/api/auth", tags=["auth"], route_class=EnvelopeRoute)`；前缀写在每个 router 上（无全局 prefix，靠约定统一 `/api`） |
| 版本前缀 | 仅全局 `/api`（无 `/v1`） | 仅 `/api`（无 `/v1`） |
| 中间件 / 守卫链 | 全局：`ValidationPipe` → `JwtAuthGuard(APP_GUARD)` → `HttpExceptionFilter` → `ResponseInterceptor`；可 `@UseGuards` 局部叠加 | 全局：`CORSMiddleware` + 注册异常处理器；**每个路由**声明 `Depends(get_current_user)`；信封由 `EnvelopeRoute` 在 handler 外层包裹 |
| 路由顺序敏感 | 无（装饰器路由由 Nest 解析，参数化 `@Get(':id')` 与字面路由由框架消歧） | **有**：`main.py` 注释明示 `aggregation` 必须在 `portfolios` 前注册，否则 `/comparison` 字面路由会被 `/{portfolio_id}` 吞掉 |
| 静态资源 | `app.useStaticAssets(uploadDir,{prefix:'/api/uploads'})` | `app.mount(settings.STATIC_ASSETS_PREFIX, StaticFiles(...))` |
| 文档 | Swagger `/api/docs`（`addBearerAuth`） | 自定义 `_custom_openapi()` 注入 `JWT-auth` Bearer 到所有 path（对齐 Nest addBearerAuth） |

**观察结论**：旧项目"全局前缀 + 装饰器"声明式、顺序无关；新项目"每 router 自带前缀 + 顺序敏感"更显式也更易踩坑（字面路由 vs 参数路由）。鉴权从"全局守卫"退化为"每路由依赖声明"——更灵活但更易漏写 `@Depends(get_current_user)`。

---

## 6. 配置与错误处理策略

| 维度 | 旧项目（NestJS） | 新项目（FastAPI） |
|------|------------------|-------------------|
| 配置来源 | `ConfigModule.forRoot({isGlobal:true})` 读 `.env` | `pydantic_settings.BaseSettings`，`env_file=".env"`，`get_settings()` 带 `@lru_cache` |
| 类型安全 | `ConfigService.get<string>('JWT_SECRET')` 等字符串读取，默认散落各 `useFactory`；`JWT_SECRET` 缺失时 `JwtStrategy` 构造**抛错** | `Settings` 类字段带类型与默认值（`JWT_SECRET: str = "change-me-in-prod"`、`ACCESS_TOKEN_EXPIRE_MINUTES: int = 60*24*7`），启动即校验 |
| 配置项 | `JWT_SECRET`/`JWT_EXPIRES_IN`/`PORT`/`STORAGE_DRIVER`/`UPLOAD_DIR`/`CORS` | `JWT_SECRET`/`JWT_ALGORITHM`/`ACCESS_TOKEN_EXPIRE_MINUTES`/`DATABASE_URL`/`UPLOAD_DIR`/`CORS_ORIGINS`/`ACCOUNT_RETENTION_DAYS` |
| 统一响应信封 | `ResponseInterceptor`：成功 → `{code:0,data,message:'ok'}`；已是信封则透传（防套娃） | `EnvelopeRoute` + `EnvelopeJSONResponse`：成功 → `{code:0,data,message:'ok'}`；已是信封 dict 则透传（`_is_envelope` 判 `number code`） |
| 异常→信封 | `HttpExceptionFilter`（`@Catch()` 全局）：业务码优先取主动抛的 `HttpException({code,...})`，否则按 HTTP 状态映射（400→2000、401→1001、404→3001、409→1003、500→5000） | `business_exception_handler` 等：捕获 `BusinessException(code,message,data,status_code)` → 原样透传；`HTTPException`→按 `HTTP_STATUS_TO_CODE` 映射；`RequestValidationError`→2000；兜底→5000 |
| 主动业务异常 | `throw new HttpException({code:1004,message},400)` / 自定义异常类（如 `AccountPendingDeletionException`） | `raise BusinessException(BusinessErrorCode.PENDING_DELETION, ..., data={'remainingDays':n}, status_code=409)`（子类 `AccountPendingDeletionException`） |
| 错误码单一来源 | `@investment-tracker/shared` 的 `BUSINESS_ERROR_CODE`（`packages/shared/src/types/api.ts`） | `core/enums.BusinessErrorCode(IntEnum)` + `HTTP_STATUS_TO_CODE` / `CODE_TO_HTTP_STATUS` 双向映射表（注释声明是 shared 的镜像） |
| 校验错误 | `ValidationPipe`（class-validator） | Pydantic v2 自动（请求体/查询参数） |

**观察结论**：信封契约与错误码二者**逐字对齐**（新代码注释多次写"镜像 app"）。配置层面新项目更类型安全（pydantic），旧项目更松散（ConfigService 字符串 + 运行期抛错）。错误处理都收敛到"信封 + 业务码"单一出口，但实现机制不同（全局过滤器/拦截器 vs 全局异常处理器 + 自定义 Route）。

---

## 7. 前端组织（补充观察）

两端前端**高度一致**，新仓 `web/src` 几乎为旧仓 `packages/web/src` 的副本：

- 状态管理：React + **Zustand**（`stores/auth.store.ts` 等，`create` from 'zustand'，token/user 存 `localStorage`）。
- 目录：`api/`（按资源分文件，函数式 fetch 封装）、`features/`（按业务域：auth/cashflow/holdings/overview/portfolio/…）、`components/`、`hooks/`、`pages/`、`constants/`、`lib/`、`types/`。
- 共享类型：旧/新 web 均 `import type {...} from '@investment-tracker/shared'`（新仓 backend 内未见该 TS 包，推测由前端侧复用旧仓 shared 或已另行提供）——这是"前端零改动复用"的前提之一。

> 说明：前端为次要观察项（任务重点在后端）。以上基于两端 `src/` 目录树与 `auth.store.ts`、`api/types.ts` 头部内容，未逐文件深读。

---

## 8. 架构理念 / 可扩展性 / 代码组织 异同

**相同点（刻意对齐）**
1. 分层架构（路由/Controller ↔ Service ↔ 数据模型）一致。
2. 统一响应信封 `{code,data,message}` + 统一业务错误码（1001–5000）一致。
3. JWT（HS256，`{sub,email}`）鉴权 + 每请求查库确认用户存在/未软删，一致。
4. 数据隔离：所有查询以 `userId` 过滤，404 不泄露存在性，一致。
5. 金额 `Decimal`→字符串、UTC+8 应用日口径，一致。
6. 金融算法抽为**零依赖纯函数**（旧 `packages/finance-core` ↔ 新 `app/finance_core`），与 IO 解耦，一致。

**不同点（范式差异）**
| 方面 | 旧（NestJS） | 新（FastAPI） |
|------|--------------|---------------|
| 边界强制力 | 模块系统 = 编译期边界，容器保证依赖关系 | 目录约定 = 运行期边界，靠纪律 |
| 依赖注入 | 完整 IoC 容器、构造器注入、factory provider | 函数式 `Depends` + 手动 `Service(db)` |
| ORM | Prisma（schema 约定式 + 生成 client） | SQLAlchemy 2.0（代码声明式 ORM） |
| 配置 | `ConfigService` 字符串读取，运行期校验 | `pydantic-settings` 类型安全，启动校验 |
| 切面 | 全局 Guard/Interceptor/Filter | 全局 `EnvelopeRoute` + 显式异常处理器 + 每路由 `Depends` |
| 扩展新增功能 | 建 Module + 声明 imports/exports，容器装配 | 建 router/service/model 文件 + `include_router` |
| 解耦抽象 | `StorageService` 抽象 + 工厂（可换 COS/S3） | 未见存储抽象；其他解耦靠分层 |
| 依赖规模 | 重（Nest/Passport/Prisma/Swagger 等） | 轻（FastAPI/SQLAlchemy/pydantic/jwt/bcrypt） |

---

## 9. 结论性对比总结

- **本质**：新项目不是"新架构"，而是旧后端在 Python 技术栈上的**同契约移植**——API 信封、错误码、JWT、Decimal 字符串、UTC+8、金融算法口径全部 1:1 复刻，故 React 前端可零改动复用（事实：新 `web/src` 与旧 `packages/web/src` 文件级一致）。
- **理念一致**：都采用"分层 + 服务化 + 纯函数计算内核 + 统一信封/错误码 + 数据隔离"的工程理念。
- **最大差异在边界强制力**：旧项目用 NestJS 的 `@Module` 与 IoC 容器把"模块边界 / 依赖方向 / 可替换实现"焊死在编译期，扩展性与团队规模化更稳；新项目以目录约定 + FastAPI `Depends` + 自定义 `EnvelopeRoute` 实现同等能力，更轻、依赖更少、上手更快，但分层边界靠纪律、重构缺少编译器保护、且存在路由注册顺序敏感等"显式陷阱"。
- **取舍建议**：追求长期可扩展、多人协作、可插拔实现（如换对象存储）→ 旧项目的模块约束更有利；追求低依赖、快速交付、贴合 Python 生态 → 新项目更省心。二者业务语义与对外契约等价，技术选型主要取决于团队栈与演进需求。

---

## 附录：事实依据与读取文件清单

### 旧项目（NestJS）已读源码（共 26 个核心文件 + 目录树）
入口/根：`main.ts`、`app.module.ts`
通用切面：`common/filters/http-exception.filter.ts`、`common/interceptors/response.interceptor.ts`、`common/guards/jwt-auth.guard.ts`、`common/decorators/public.decorator.ts`、`common/decorators/current-user.decorator.ts`、`common/dto/pagination.dto.ts`、`common/dto/date-range.dto.ts`、`common/utils/app-date.util.ts`
基础设施：`prisma/prisma.module.ts`、`prisma/prisma.service.ts`
认证模块：`modules/auth/auth.module.ts`、`modules/auth/auth.service.ts`、`modules/auth/auth.controller.ts`、`modules/auth/jwt.strategy.ts`
组合模块：`modules/portfolio/portfolio.module.ts`、`modules/portfolio/portfolio.service.ts`、`modules/portfolio/portfolio.controller.ts`
计算/重算：`modules/calculation/calculation.module.ts`、`modules/calculation/calculation.service.ts`、`modules/recalculation/recalculation.module.ts`
上传/数据迁移：`modules/upload/upload.module.ts`、`modules/upload/upload.service.ts`、`modules/security/dto/create-security.dto.ts`、`modules/data-transfer/data-transfer.service.ts`
目录树：`src/common`、`src/modules`、`src/prisma`、`packages/`（backend/web/shared/finance-core）、`packages/web/src`（api/stores/features）

### 新项目（FastAPI）已读源码（共 25 个核心文件 + 目录树）
入口/配置：`main.py`、`core/config.py`、`core/exceptions.py`、`core/envelope.py`、`core/security.py`、`core/enums.py`、`core/types.py`、`core/date_utils.py`
数据层：`db/database.py`、`db/base.py`、`models/user.py`、`models/portfolio.py`、`models/enums.py`、`serializers.py`
路由：`routers/auth.py`、`routers/portfolios.py`、`routers/calc.py`、`routers/common.py`、`routers/data_transfer.py`（头部）
服务：`services/base.py`、`services/portfolio.py`、`services/calculation.py`、`services/user.py`
算法内核：`finance_core/nav.py`
Schema：`schemas.py`（头部）、`schemas_resp.py`（头部）
目录树：`backend/app/{core,db,finance_core,models,routers,services}`、`web/src`

### 未读到 / 存疑（如实说明）
- 旧项目 `schema.prisma` 实体定义文件**未直接读取**；"模型由 Prisma 生成、src 无手写实体类"系据 `PrismaService extends PrismaClient` 与各处 `@prisma/client` import 推断。
- 新项目 backend 内**未发现** `shared`/`finance-core` 这类 TS 包（根目录无 `packages/`）；新 web 仍 `import '@investment-tracker/shared'`，该共享 TS 包在新仓 backend 侧是否存在未核实（推测由前端侧复用旧仓 shared 或另行提供）。
- 新项目**未见**定时清理（对应旧 `ScheduleModule` + `CleanupService` 的软删账户物理清理）实现。
- 前端为次要项，仅读取目录树与 `auth.store.ts`、`api/types.ts` 头部，未逐文件深读。
