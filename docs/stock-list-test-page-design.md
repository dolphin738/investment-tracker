# 「股票列表和测试」分页 — 前端页面结构方案（设计 / 提案）

> 本文档是**前端页面结构方案（设计 / 提案）**，不含实现代码，仅描述结构、组件树、数据流、类型契约与后端前置依赖。
> 所有结论均基于真实代码阅读（见「参考代码」一节），文件路径与字段以实际仓库为准。
>
> 参考代码：
> - `web/src/pages/admin.tsx`
> - `web/src/features/admin/quote-provider-section.tsx`（含 `ProviderInterfaces` / `InterfacesByCategoryOverview` 等子组件组织方式）
> - `backend/app/models/security.py`（`Security` 模型）
> - `backend/app/models/quote_interface.py`（`QuoteInterface` 模型）
> - `backend/app/services/market_data_sync.py`（`MarketDataSyncService`）
> - `backend/app/modules/admin/router.py`（`router_admin`，前缀 `/api/admin`，`EnvelopeRoute` 自动包信封）
> - `web/src/api/quote-interface.api.ts`、`web/src/api/security.api.ts`、`web/src/api/types.ts`
> - `web/src/hooks/use-quote-interface.ts`
> - `web/src/components/ui/`（shadcn 可用组件：card / table / button / badge / dialog / alert-dialog / input / select / textarea / tabs / skeleton 等）

---

## TL;DR（要点摘要）

- **入口**：在 `admin.tsx` 的 `MODULES` 注册表追加第三个分页 `股票列表和测试`，挂载新组件 `StockListTestSection`。
- **布局**：`StockListTestSection` 顶部做左右两栏（`lg:grid-cols-2`）；左栏 `StockListPanel`（只读展示系统级股票主数据），右栏 `InterfaceTestPanel`（选接口 → 填参数 → 执行测试 → 看原始响应）。
- **左栏数据**：当前 `securities` 表是**组合（portfolio）维度**主数据、由用户交易产生，**不是**系统级全市场股票主数据。（详见 §4.2「改造 securities」方案：不新建表，`portfolio_id` 可空 + 新增 `exchange`，定时任务 upsert 主数据行，列表端点 `GET /api/admin/securities/masters`。）
- **右栏数据**：选中接口（`listAllInterfaces`）→ 动态渲染该接口 `params` 模板为可编辑键值对（支持增删多个参数）→ 可选填 codes → 「执行测试」调**新端点** `POST /api/admin/quote-interfaces/:id/test`（body `{params, codes?}`）→ 展示原始响应（pretty-print JSON）+ 解析出的 `{code→price}` + 状态 / 耗时。**该测试端点目前不存在，是后端前置依赖。**
- **风格一致性**：复用 shadcn（Card/Table/Button/Badge/Input/Select/Textarea/Dialog）、TanStack Query（`useQuery`/`useMutation`）、`lucide-react` 图标、`sonner` toast，对齐 `quote-provider-section.tsx` 组织方式。
 - **后端前置依赖**（§8 决策后已收窄）：① 改造 `securities`（portfolio_id 可空 + exchange + 部分唯一索引）+ 定时同步任务 + `GET /api/admin/securities/masters`（+ 可选 `POST /api/admin/securities/sync`）；② 单接口测试端点 `POST /api/admin/quote-interfaces/{id}/test`（执行单接口、回传原始响应）。
- **决策点状态**：§8 五项已全部拍板（改造 securities / 不持久化 / 任意 enabled 接口 / 支持左右联动 / `.../quote-interfaces/{id}/test`）。详见 §8。

---

## 1. 页面定位与入口

「股票列表和测试」是「金融数据接口」管理页（`web/src/pages/admin.tsx`）内的**第三个分页（标签）**。该页本身仅管理员可见（`useIsAdmin()` 门禁），页内以 `MODULES` 注册表驱动标签分页：

```ts
// web/src/pages/admin.tsx（结构示意，非实现）—— 在 MODULES 追加第三项
import { ServerCog, Tags, ListChecks } from 'lucide-react';
import { QuoteProviderSection } from '@/features/admin/quote-provider-section';
import { InterfaceCategorySection } from '@/features/admin/interface-category-section';
import { StockListTestSection } from '@/features/admin/stock-list-test-section'; // 新增

const MODULES: AdminModule[] = [
  { key: 'quote-provider',   label: '接口API来源',   icon: <ServerCog className="mr-2 h-4 w-4" />, component: QuoteProviderSection },
  { key: 'interface-category', label: '接口分类管理', icon: <Tags className="mr-2 h-4 w-4" />,      component: InterfaceCategorySection },
  // ↓↓↓ 新增：股票列表和测试 ↓↓↓
  { key: 'stock-list-test',  label: '股票列表和测试', icon: <ListChecks className="mr-2 h-4 w-4" />, component: StockListTestSection },
];
```

**挂载关系**：`admin.tsx` 不改变（仅追加 `MODULES` 项 + 顶部 `import`）；标签切换时按 `active` key 渲染 `StockListTestSection`（即 `findModule(active).component`）。`StockListTestSection` 内部自行编排左右两栏与各自子组件，与现有两个 section 平级，无额外权限处理（已继承 admin 门禁）。

---

## 2. 组件树

```mermaid
classDiagram
    direction TB
    class StockListTestSection {
        +JSX 渲染入口
        布局: lg:grid-cols-2 左右两栏
        内含 StockListPanel + InterfaceTestPanel
    }
    class StockListPanel {
        +useSecurityMasters() 读取主数据
        +本地 state: query(搜索)
        只读 Table: code/name/exchange/type/updatedAt
    }
    class InterfaceTestPanel {
        +useQuoteInterfacesAll() 接口下拉
        +useInterfaceTest() 执行测试
        +state: selectedInterfaceId
        +state: paramRows[{key,value}]
        +state: codesText
        +state: result(测试响应)
        选接口 → 渲染 params → 填 codes → 执行 → 展示原始响应+解析
    }
    StockListTestSection --> StockListPanel : 左栏(只读)
    StockListTestSection --> InterfaceTestPanel : 右栏(测试)
```

> 组织方式对齐 `quote-provider-section.tsx`：**三个组件同文件 `stock-list-test-section.tsx`**（`StockListTestSection` 导出为主，内部含 `StockListPanel` / `InterfaceTestPanel` 及必要的辅助子组件），避免文件零散。

### 组件职责与 props/state 设计

| 组件 | 职责 | 主要 state / hooks | 关键 UI |
|------|------|--------------------|----------|
| `StockListTestSection` | 顶层容器，左右两栏布局；串联左右两面板 | 无（或统管 loading 态） | `Card` 包裹两栏；`grid grid-cols-1 lg:grid-cols-2 gap-6` |
| `StockListPanel`（左） | 只读展示系统级股票主数据；支持关键字搜索 | `useSecurityMasters()`（见§4）；`query: string` | `CardHeader`(标题+说明) + `Input`(搜索) + `Table`(code/name/交易所·类型/更新时间) |
| `InterfaceTestPanel`（右） | 选接口、动态渲染 `params`、可选 codes、执行测试、展示原始响应 | `useQuoteInterfacesAll()`、`useInterfaceTest()`；`selectedInterfaceId`、`paramRows: {key,value}[]`、`codesText`、`result` | `Select`(接口) + 可编辑键值对表格(增删) + `Textarea`(codes) + `Button`(执行) + `Card`(响应区：状态 Badge / 耗时 / 解析表 / 原始 JSON) |

**左右联动（§8 决策 4，支持）**：左栏每行提供「填入测试」操作，将 `code` 注入右栏 `InterfaceTestPanel` 的 `codesText`（追加，不覆盖）；默认两面板仍解耦、互不依赖。

---

## 3. 文件清单

| 文件 | 操作 | 说明 |
|------|------|------|
| `web/src/pages/admin.tsx` | 修改 | `MODULES` 追加 `stock-list-test` 项 + 顶部 `import { StockListTestSection }` |
| `web/src/features/admin/stock-list-test-section.tsx` | **新增** | `StockListTestSection` + `StockListPanel` + `InterfaceTestPanel`（同文件，对齐现有 section 组织） |
| `web/src/api/security-master.api.ts` | **新增** | `listSecurityMasters()`（→ `GET /api/admin/securities/masters`）；可选 `syncSecurityMasters()`（→ `POST /api/admin/securities/sync`）；并定义 `SecurityMaster` / 测试相关类型 |
| `web/src/api/quote-interface.api.ts` | 修改 | 扩展 `testInterface(id, body)`（→ `POST /api/admin/quote-interfaces/:id/test`）；定义 `InterfaceTestRequest` / `InterfaceTestResponse` 类型 |
| `web/src/hooks/use-security-master.ts` | **新增** | `useSecurityMasters()`（`useQuery`，`enabled: isAdmin`）；可选 `useSyncSecurityMasters()`（`useMutation`） |
| `web/src/hooks/use-interface-test.ts` | **新增** | `useInterfaceTest()`（`useMutation`，调 `testInterface`，`onSuccess/onError` toast） |
| `web/src/api/types.ts` | 可选 | 若项目约定类型集中放此处，可把 `SecurityMaster` / 测试类型 re-export 到此（当前 `Security` 即在此，`QuoteInterface` 类型在 `quote-interface.api.ts`） |

> 说明：现有类型约定为「接口类型就近放在其 api 文件」（如 `QuoteInterface` 在 `quote-interface.api.ts`，`Security` 在 `api/types.ts`）。本方案将 `SecurityMaster` / `InterfaceTest*` 类型就近放入 `security-master.api.ts` 与 `quote-interface.api.ts`，保持与现状一致。

---

## 4. 左栏数据流（StockListPanel）

### 4.1 关键事实：现有 `securities` 不是系统级股票主数据

`backend/app/models/security.py` 的 `Security`：

```
Security(portfolio_id, code, name, type, currency)
UniqueConstraint("portfolio_id", "code")
```

- 它是**组合（portfolio）维度**的主数据，`portfolio_id` 为外键；由用户的证券买卖流水（`SecurityTrade`）产生，是「我持有的标的」，**不是全市场股票字典**。
- 现有前端 `listSecurities(portfolioId)`（`web/src/api/security.api.ts`）按组合拉取，返回 `PaginatedResponse<Security>`，类型定义见 `web/src/api/types.ts`（`Security`：`{id, portfolioId, code, name, type, note, createdAt, updatedAt}`）。

因此**不能**直接用「用户持仓行」充当全市场字典；但经 §8 决策，采用**改造 `securities`** 方案（见 §4.2）：新增 `portfolio_id IS NULL` 的系统主数据行承载全市场代码与名称，与用户持仓行同表共存、互不污染。

### 4.2 最终决策（改造 securities，即「方案 A」的落地形态，§8 决策 1）

经用户拍板：**不新建 `stock_masters` 表**，而是**改造现有 `securities` 表**以同时承载「系统级全市场股票主数据」与「用户持仓标的」两种语义——因为下游持仓标的（`SecurityTrade`）正是按 `code` 关联 `securities` 并读取其 name/code 的，让主数据即 `securities` 本身，**不存在污染「持仓标的」语义**，反而成为单一可信源（Single Source of Truth）。

`Security` 模型改造点（具体迁移见实现阶段）：

- `portfolio_id`：`nullable=False` → `nullable=True`。
  - **系统级主数据行**：`portfolio_id = NULL`（NULL 不触发 `portfolios` 的 `ON DELETE CASCADE`，语义干净）。
  - **用户持仓行**：仍填真实组合 id，保持原有 CASCADE 行为不变。
- 新增 `exchange: Mapped[Optional[str]]`（如 `SH`/`SZ`/`BJ`，可空）—— 同步任务填充。
- `type`：已存在（`SecurityType` 枚举 STOCK/INDEX/ETF…），同步主数据时填具体值（主数据多为 `STOCK`）。
- `updated_at`：`Security` 已继承 `TimestampMixin`，同步 upsert 时自动刷新，直接作为「最近同步时间」展示，无需新增列。
- **唯一约束调整**：保留现有 `uq_securities_portfolio_code(portfolio_id, code)`（约束用户行）；系统主数据行（`portfolio_id IS NULL`）需按 `code` 唯一，新增 **PostgreSQL 部分唯一索引** `uq_securities_master_code ON securities(code) WHERE portfolio_id IS NULL`，保证全市场主数据 code 不重复且不干扰用户行。
  - （备选：新增 `is_master: bool` 标志 + 部分索引；当前采用 `portfolio_id IS NULL` 判定，零新增列、最简洁。）

定时同步任务：

- 沿用 `MarketDataSyncService`，新增 `sync_security_masters()`：调用 AKShare `stock_info_a_code_name` 取全 A 股代码+名称，按 `code` upsert 到 `securities` 主数据行（`portfolio_id = NULL` 的行；存在则更新 `name`/`exchange`/`type`，不存在则 insert 并置 `portfolio_id = NULL`）；同时刷新 `updated_at`。
- 触发：调度器（APScheduler/Celery beat）定时 + 可选管理面手动端点 `POST /api/admin/securities/sync`（对齐现有 `POST /api/admin/quote-providers/sync` 风格）。
- （可选）交易所/类型枚举：与 AKShare 返回对齐，前端仅展示，不强制约束。

列表端点：`GET /api/admin/securities/masters`

- 返回 `portfolio_id IS NULL` 的 `securities` 行，即系统级股票主数据（`SecurityMaster[]`：`code`/`name`/`exchange`/`type`/`updated_at`）。
- 支持可选 `?q=` 关键字搜索（匹配 `code`/`name`）；量级可控，建议一次性返回或较大 pageSize。

> 原「方案 B（复用 securities 伪造 portfolio 上下文）」已被本决策取代，不再采用——本方案虽仍复用 `securities` 表，但**以 `portfolio_id IS NULL` 正名系统行**，而非伪造组合，语义清晰。

### 4.3 取舍回顾（改造 securities vs 原新表方案）

| 维度 | 改造 securities（采用） | 原新表 stock_masters（未采用） |
|------|--------------------------|--------------------------------|
| 语义 | ✅ 主数据即 securities 单一可信源，持仓按 code 关联，无污染 | 多一张表，持仓仍需关联 |
| 迁移成本 | 中（portfolio_id 改可空 + exchange 列 + 部分唯一索引） | 中（新模型+迁移+任务+端点） |
| 对现有表 | 侵入 securities（但语义正向收敛） | 无侵入 |
| 前端 | 新增 `security-master.api.ts` + hook，读 `securities/masters` | 新增 `stock-master.api.ts` |

**结论：采用改造 securities 方案**（§8 决策 1）。

### 4.5 左栏调用流（sequence）

```mermaid
sequenceDiagram
    participant U as 管理员
    participant S as StockListTestSection
    participant P as StockListPanel
    participant H as useSecurityMasters()
    participant API as GET /api/admin/securities/masters
    participant DB as securities 表(主数据行 portfolio_id=NULL, 定时任务已填充)

    U->>S: 切换到「股票列表和测试」标签
    S->>P: 渲染左栏
    P->>H: useQuery 发起
    H->>API: listSecurityMasters()
    API->>DB: SELECT ... WHERE portfolio_id IS NULL
    DB-->>API: SecurityMaster[]
    API-->>H: 信封解包数据
    H-->>P: data 就绪
    P-->>U: Table 展示 code/name/交易所·类型/更新时间
    Note over U,DB: 数据由后端定时任务自动维护，前端只读
```

---

## 5. 右栏数据流（InterfaceTestPanel）

### 5.1 交互与数据流

1. **选接口**：`Select` 数据源来自 `useQuoteInterfacesAll()`（→ `listAllInterfaces()`，返回全部 `QuoteInterface`）。（§8 决策 3：允许对任意 `enabled` 接口测试，不限分类。）
2. **动态渲染 params**：读取选中接口的 `params: Record<string, unknown>` 模板，渲染为「可编辑键值对」表格。每行 `{key, value}`，支持：
   - 编辑 value（覆盖模板默认值）；
   - **新增**参数行（灵活添加多个参数）；
   - **删除**参数行。
3. **可选 codes**：`Textarea` / `Input` 输入以逗号或换行分隔的 `codes`（可选，对应 `MarketDataSyncService` 中 `codes` 入参，用于接口按 code 过滤）。
4. **执行测试**：`useInterfaceTest()` 调新端点 `POST /api/admin/quote-interfaces/:id/test`，body `{ params, codes? }`。
5. **结果展示**（`Card` 响应区）：
   - 状态 Badge（成功 / 失败）；
   - 耗时（`elapsedMs`）；
   - 解析出的 `{code→price}` 表（`parsed`，用接口的 `resp_code_field` / `resp_price_field` 解析）；
   - **原始响应**（`raw`）：`Textarea`（只读）pretty-print JSON；若为 list-of-dicts 也可表格渲染。

### 5.2 新测试端点（后端前置依赖，当前不存在）

> 经阅读 `backend/app/modules/admin/router.py` 与 `market_data_sync.py` 确认：**目前没有「单独测试某接口并回传原始响应」的端点**；现有 `POST /api/admin/quote-providers/sync` 是整库全组合同步，不回传单接口原始响应。需新增：

- **端点**：`POST /api/admin/quote-interfaces/{interface_id}/test`
  - 命名参考现有 `PATCH /api/admin/quote-interfaces/reorder`（同用 `/quote-interfaces/` 前缀）。
  - 鉴权：`Depends(require_admin)`（与同文件其它端点一致）。
- **请求体**：`{ params: Record<string, unknown>, codes?: string[] }`
  - `params`：经前端编辑后的**完整有效参数**（后端可直接用于调用，覆盖 `itf.params`；或由后端 merge —— 建议以前端提交的 `params` 为准）。
  - `codes`：可选代码列表。
- **响应**（建议结构，由 `EnvelopeRoute` 自动包 `{code,data,message}`）：
  - `ok: boolean`
  - `status: 'success' | 'error'`
  - `httpStatus?: number`（HTTPS 接口的上游状态码；SDK 接口可无）
  - `elapsedMs: number`（调用耗时）
  - `raw: unknown`（HTTPS：`resp.json()`；SDK：`DataFrame` 转 `list[dict]`）
  - `parsed: Record<string, string> | null`（按 `resp_code_field`/`resp_price_field` 解析出的 `{code→price}`）
  - `error?: string`（异常信息）
  - `interfaceId: string`
- **后端实现建议**：在 `MarketDataSyncService` 新增 `test_single_interface(interface_id, params, codes)` 方法，复用 `_call_interface` 的 HTTPS/SDK 分派逻辑，但用**调用方传入的 `params`** 而非 `itf.params`，并用 `time.perf_counter()` 计时、捕获异常、原样回传 `raw` 与解析结果（不计入 `consecutive_failures` 告警，仅做测试用途）。

### 5.3 右栏调用流（sequence）

```mermaid
sequenceDiagram
    participant U as 管理员
    participant P as InterfaceTestPanel
    participant H as useInterfaceTest()
    participant API as POST /api/admin/quote-interfaces/:id/test
    participant SVC as MarketDataSyncService.test_single_interface
    participant EXT as 上游接口 / SDK

    U->>P: 选接口 + 编辑 params + 填 codes(可选)
    U->>P: 点击「执行测试」
    P->>H: mutate({params, codes?})
    H->>API: testInterface(id, body)
    API->>SVC: 计时调用单接口(传入 params/codes)
    SVC->>EXT: HTTPS 请求 / SDK 函数
    EXT-->>SVC: 原始响应(或异常)
    SVC-->>API: {raw, parsed, status, httpStatus, elapsedMs, error}
    API-->>H: 信封响应(InterfaceTestResponse)
    H-->>P: result 就绪
    P-->>U: 展示 状态/耗时/解析表/原始 JSON
```

---

## 6. 与现有风格一致性

| 维度 | 现有约定（已确认） | 本方案遵循 |
|------|---------------------|------------|
| UI 组件 | shadcn：`Card`/`Table`/`Button`/`Badge`/`Dialog`/`AlertDialog` | 左栏 `Card+Table`，右栏 `Card+Select+Input+Textarea+Table`；状态用 `Badge`（`variant="success"|"secondary"` 对齐 `EnabledBadge`） |
| 数据请求 | TanStack Query：`useQuery`（配 `enabled: isAdmin`）+ `useMutation` + `queryClient.invalidateQueries` | `useSecurityMasters()` / `useInterfaceTest()` 完全一致 |
| 图标 | `lucide-react`（如 `ServerCog`/`Tags`/`Loader2`/`Plus`） | 新分页用 `ListChecks`；加载用 `Loader2`；增删用 `Plus`/`Trash2` |
| 反馈 | `sonner` `toast.success/error` | 测试成功/失败、`useSecurityMasters` 错误回退提示沿用 |
| 加载/错误态 | `Loader2` 旋转 + 「加载中…」/「加载失败，请刷新重试」 | `StockListPanel` 复用同一套占位文案 |
| 信封 | 后端 `EnvelopeRoute`（`/api/admin`）自动包 `{code,data,message}`，前端 `http` 已解包 | `listSecurityMasters()` / `testInterface()` 经 `http` 直接拿 `data`，与现有 api 文件一致 |
| 组件组织 | 一个 section 文件内含主组件 + 子组件（如 `quote-provider-section.tsx`） | `stock-list-test-section.tsx` 内含 `StockListTestSection`+`StockListPanel`+`InterfaceTestPanel` |

> 前端**无需引入新依赖包**（shadcn / `@tanstack/react-query` / `sonner` / `lucide-react` 均已存在）。后端如采用 AKShare 拉取股票主数据，需确保 `akshare` 已在依赖中（现有 `_fetch_sdk` 已懒导入 `akshare`，说明环境中已具备）。

---

## 7. 后端前置依赖清单（独立一节，便于转交实现 / 架构评审）

> 以下均为**当前不存在**、需后端补齐的能力。

### ① 改造 `securities` 承载系统级股票主数据（左栏数据源，§8 决策 1）
- **模型 + 迁移**：改造 `Security`（`securities` 表）：
  - `portfolio_id` 由 `nullable=False` 改为 `nullable=True`；系统主数据行置 `NULL`（不触发 portfolios CASCADE）。
  - 新增 `exchange: Optional[str]`（SH/SZ/BJ，可空）。
  - `updated_at` 继承 `TimestampMixin` 已存在，同步时刷新即「最近同步时间」。
  - `type` 沿用 `SecurityType` 枚举。
  - 唯一约束：保留 `uq_securities_portfolio_code(portfolio_id, code)`（用户行）；新增 **部分唯一索引** `uq_securities_master_code ON securities(code) WHERE portfolio_id IS NULL`（主数据行按 code 唯一）。
- **定时同步任务**：新增 `MarketDataSyncService.sync_security_masters()`，调用 AKShare `stock_info_a_code_name` 拉全 A 代码+名称，按 `code` upsert 到 `portfolio_id IS NULL` 的 `securities` 行（存在更新 name/exchange/type，不存在 insert）。由调度器（APScheduler/Celery beat）定时触发。
- **列表端点**：`GET /api/admin/securities/masters`（返回主数据行 `SecurityMaster[]`，支持 `?q=` 搜索 code/name）。
- **（可选）手动触发端点**：`POST /api/admin/securities/sync`（对齐 `POST /api/admin/quote-providers/sync` 风格，便于联调）。

### ② 单接口测试端点（右栏数据源）
- **端点**：`POST /api/admin/quote-interfaces/{interface_id}/test`，`Depends(require_admin)`。
- **请求**：`{ params: Record<string, unknown>, codes?: string[] }`。
- **响应**：`{ ok, status, httpStatus?, elapsedMs, raw, parsed, error?, interfaceId }`（见 §5.2）。
- **实现**：`MarketDataSyncService.test_single_interface(...)` 复用 `_call_interface` 的 HTTPS/SDK 分派，用调用方 `params`、计时、捕异常、原样回传 `raw`；**不**计入 `consecutive_failures` 告警。

---

## 8. 决策点状态（已全部拍板，2026-08-13）

| # | 决策点 | 用户拍板 | 影响 |
|---|--------|----------|------|
| 1 | 股票主数据来源 | **改造 `securities`**（portfolio_id 可空、系统行 NULL、新增 exchange），不新建 `stock_masters` 表。理由：下游持仓按 `code` 关联同一表读取 name/code，单一可信源、无「持仓标的」语义污染。 | 左栏读 `securities/masters`；§4.2 / §7 ① 改写 |
| 2 | 测试结果是否持久化 | **不保存 / 不收藏**，仅会话内展示。 | 无需测试历史表与写端点 |
| 3 | 测试范围 | **对任意 `enabled` 接口**均可测试（不限分类）。 | 下拉 = 全部 `enabled` 的 `QuoteInterface` |
| 4 | 左右联动 | **支持**：左栏行「一键填入右栏 codes」。 | `StockListPanel` 行操作注入 `codesText` |
| 5 | 测试端点命名 | **`POST /api/admin/quote-interfaces/{id}/test`**（沿用 reorder 前缀）。 | 前端 `testInterface(id, body)` 路径 |

> 全部决策已落地到本文档各节（§3 / §4 / §5 / §6 / §7 / §9）。

---

## 9. 任务分解（若后续实现，按文件 / 依赖顺序）

> 仅前端侧拆解；后端依赖见 §7，应优先于前端联调。

| 顺序 | 任务 | 涉及文件 | 依赖 |
|------|------|----------|------|
| T1 | 后端补齐前置能力（§7 ① ②），提供 `GET /api/admin/securities/masters` 与 `POST .../quote-interfaces/{id}/test` 并自测 | `backend` 模型/迁移/服务/router | 无（可并行启动） |
| T2 | 新增股票主数据 API + 类型 + hook | `web/src/api/security-master.api.ts`、`web/src/hooks/use-security-master.ts` | T1（① 端点） |
| T3 | 扩展接口测试 API + 类型 + hook | `web/src/api/quote-interface.api.ts`（增 `testInterface`）、`web/src/hooks/use-interface-test.ts` | T1（② 端点） |
| T4 | 实现 `stock-list-test-section.tsx`（左 `StockListPanel` + 右 `InterfaceTestPanel`） | `web/src/features/admin/stock-list-test-section.tsx` | T2、T3 |
| T5 | 接入 `admin.tsx` 的 `MODULES` 注册表 | `web/src/pages/admin.tsx` | T4 |
| T6 | 联调 + 类型 / lint 校验 + 手动验证左右两栏 | 全部新增/修改文件 | T4、T5 |

---

## 附录：关键类型草案（设计用，非实现）

> 仅描述契约形状，供前后端对齐；不写实现逻辑。

```ts
// web/src/api/security-master.api.ts
export interface SecurityMaster {
  id: string;
  code: string;
  name: string;
  exchange: string | null;   // SH / SZ / BJ ...（改造 securities 新增列）
  type: string | null;       // SecurityType: STOCK / INDEX / ETF ...
  updatedAt: string;         // 最近同步时间 ISO8601（TimestampMixin）
}
// GET /api/admin/securities/masters  → SecurityMaster[]（portfolio_id IS NULL 的 securities 行）
// （可选）POST /api/admin/securities/sync → { synced: number; failed: number; errors: string[] }

// web/src/api/quote-interface.api.ts（扩展）
export interface InterfaceTestRequest {
  params: Record<string, unknown>;
  codes?: string[];
}
export interface InterfaceTestResponse {
  ok: boolean;
  status: 'success' | 'error';
  httpStatus?: number;
  elapsedMs: number;
  raw: unknown;                                  // HTTPS: resp.json(); SDK: list[dict]
  parsed: Record<string, string> | null;        // {code→price}，按 resp_code_field/resp_price_field
  error?: string;
  interfaceId: string;
}
// POST /api/admin/quote-interfaces/:id/test → InterfaceTestResponse
```

---

## Anything UNCLEAR（不确定项）

- **`QuoteInterface.access_method` 归属**：`market_data_sync.py` 中 `_call_interface` 按 `itf.access_method`（https/sdk）分派，但 `quote_interface.py` 模型的可见字段未直接含 `access_method`（实际由所属 `SecuritiesDataProvider` 提供，经关系/代理暴露）。本方案把测试端点的调用分派交给后端复用 `_call_interface` 内部逻辑，前端无需感知，故不影响设计；实现时后端自行处理即可。
- **股票主数据交易所/类型枚举**：`exchange`/`type` 的取值集合未在现有模型中定义，建议后端在迁移时定一小套枚举或与 AKShare 返回对齐；前端仅展示，不需强约束。
- **左栏是否分页**：股票主数据量级（全 A 股约 5000+ 行）建议后端一次性返回或给较大 pageSize；若超大再补分页，属实现细节。
- **决策点已全部拍板**（见 §8，2026-08-13）：采用改造 `securities` 承载主数据、测试结果不持久化、对任意 enabled 接口测试、支持左右联动、端点 `.../quote-interfaces/{id}/test`。
