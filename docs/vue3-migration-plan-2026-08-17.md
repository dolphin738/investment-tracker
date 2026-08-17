# Vue 3 迁移方案（2026-08-17）

> 状态：已立项（用户确认长期切换 Vue 3 生态）
> 前置输入：`ui-optimization-review-2026-08-17.md`（前端审查报告）、`ui-optimized-preview-2026-08-17.html`（视觉验收基准）
> 边界约束：后端 API 完全不变；前端仅替换展示层与前端状态/请求层；**不新增业务功能**；出入金（Cashflow）与现金余额（Cash Balance）为两个独立模块，各自独立迁移。

---

## 1. 背景与目标

现有前端为 React 18 + Vite 5 + Tailwind 3 + shadcn/ui，功能稳定、测试完善，但团队已决定长期切换到 Vue 3 生态。本次迁移为**前端全量重写**（组件库、状态、数据请求、表单、路由全部替换），非 React 内重构。

### 目标

- 功能与现有 React 版完全等价（功能矩阵逐项对照）。
- 视觉以 `ui-optimized-preview-2026-08-17.html` 为验收基准（布局限宽、术语统一、token 化错误色、统一空态、明暗主题）。
- 复用一切与框架无关的资产：OpenAPI 生成类型、API 层、纯逻辑工具、ECharts 配置、设计 token、术语字典。
- 不再在 React 上投入结构性展示层优化（会沉没）；审查成果直接作为 Vue 实现的规格。

---

## 2. 现状盘点（已核验）

### 2.1 前端技术栈

| 层 | 现状（React） | 目标（Vue 3） |
|---|---|---|
| 构建 | Vite 5 + TS 5 | Vite（不变） |
| 样式 | Tailwind 3 + shadcn/ui（Radix） | Tailwind 3 + shadcn-vue（reka-ui） |
| 状态 | zustand v4 | Pinia |
| 数据请求 | @tanstack/react-query v5 | @tanstack/vue-query |
| 表单 | react-hook-form + zod | vee-validate + zod |
| 路由 | react-router-dom v6 | vue-router 4 |
| 图标 | lucide-react | lucide-vue-next |
| 拖拽 | @dnd-kit | vuedraggable / sortablejs |
| 图表 | echarts + echarts-for-react | echarts + vue-echarts |
| Toast | sonner | vue-sonner |
| 日期 | date-fns | date-fns（复用） |
| CSV | papaparse | papaparse（复用） |
| 测试 | vitest + Testing Library | vitest + @vue/test-utils |

### 2.2 代码规模

- 页面 `pages/`：12 个（login / register / dashboard / holdings / transactions / snapshots / xirr-analysis / nav-analysis / account / settings / admin / not-found）+ 11 个测试。
- 业务模块 `features/`：14 个（auth / account / portfolio / overview / holdings / cashflow / snapshot / security-trade / security-income / security-price / data-transfer / admin / transaction / settings）。
  > 注：原盘点误将 `query` 重复计数、并列入了不存在的 `nav` 模块（分析页 xirr-analysis / nav-analysis 在 `pages/` 下，非独立 feature）。
- Hooks `hooks/`：22 个（use-auth / use-portfolios / use-holdings / use-transactions / use-cash-balances / use-snapshots / use-dividends / use-security-trades / use-security-prices / use-query-data / use-preferences / use-interface-* / use-quote-* / use-portfolio-price / use-notification / use-data-transfer / use-account / use-security-master / use-securities / use-range-preference-sync）。
- Store `stores/`：3 个扁平 `.store.ts` 文件（auth.store.ts / portfolio.store.ts / preference.store.ts），**非目录结构**。
- API `api/`：25 个文件（23 个源码 + 2 个 `.api.test.ts`：security-master / transaction）。其中 `api/types.ts` 为**手写复用类型**（`re-export @/lib/types`），**并非** OpenAPI 生成物；真正的生成物是 `src/types/api.ts`（由 `generate:api` 脚本生成，非方案所写的 `gen-api-types`）。
- 通用 `lib/`：utils（格式化/日期）、api-client、api-error-message、constants、types、url-query、时间工具。
- 组件 `components/`：ui（**19** 个 shadcn 组件：alert / alert-dialog / badge / button / card / dialog / dropdown-menu / input / label / progress / radio-group / search-input / section / select / skeleton / switch / table / tabs / textarea）、charts（6 个）、layout（2 个）、date、security、EmptyState / LoadingSpinner / PageHeader / auth-guard / theme-manager / route-persistence / preference-bootstrap / user-avatar。
  > 注：原盘点少报 1 个，实际为 19（多出 search-input、section）。

---

## 3. 目标技术架构

### 3.1 组件库选型：shadcn-vue（reka-ui）

理由：
- 与现有 shadcn/ui 组件 API 与视觉结构最接近，**设计 token 与 Tailwind 配置可原样平移**，视觉还原成本最低。
- reka-ui 是 Radix UI 的 Vue 移植，可访问性行为一致（dialog 焦点陷阱、select、tabs、switch、alert-dialog 等均有对应）。
- 组件仍为源码内置，可按需裁剪，无重依赖。

备选：Naive UI（更"开箱即用"但视觉与现有差异大，token 复用收益低）。

### 3.2 目录结构规划

```
web-vue/
├── index.html
├── vite.config.ts
├── tailwind.config.ts          # 平移自现有
├── src/
│   ├── main.ts
│   ├── App.vue
│   ├── assets/index.css        # 平移设计 token（明暗两套）
│   ├── api/                    # 平移：api-client / api-error-message / *.api.ts / types.ts
│   ├── constants/              # 平移：路由、API 路径、术语字典、EXPORT 选项、ENTRY_BUTTON_LABELS
│   ├── lib/                    # 平移纯逻辑：utils / url-query / 时间工具 / 金额工具
│   ├── composables/            # hooks → composables（每模块一个）
│   ├── stores/                 # Pinia：auth / portfolio / preference
│   ├── router/index.ts         # vue-router，路由常量与守卫
│   ├── layouts/AppLayout.vue / Sidebar.vue
│   ├── components/ui/          # shadcn-vue 组件
│   ├── components/charts/      # vue-echarts 封装（配置逻辑平移）
│   ├── components/common/      # EmptyState / LoadingSpinner / PageHeader / UserAvatar
│   ├── modules/                # 每业务域一个目录（页面 + 组件 + composable + 测试）
│   │   ├── auth/
│   │   ├── portfolio/
│   │   ├── overview/
│   │   ├── holdings/
│   │   ├── cashflow/           # 出入金流水（独立）
│   │   ├── cash-balance/       # 现金余额（独立）
│   │   ├── snapshot/
│   │   ├── security-trade/
│   │   ├── security-income/
│   │   ├── security-price/
│   │   ├── analysis/           # xirr / nav
│   │   ├── data-transfer/
│   │   ├── admin/              # 行情管理
│   │   └── account/
│   └── tests/                  # 测试工具与 mock
```

> 说明：现有 React 项目将 feature + pages 分置，Vue 采用 `modules/` 按业务域聚合（页面、组件、composable、测试同目录），更贴近 Vue 组织习惯，也便于按模块分批迁移与独立验收。

---

## 4. 模块映射表（React → Vue）

| 批次 | React 现状 | Vue 目标 | 复用资产 |
|---|---|---|---|
| B0 | vite/ts/tailwind/index.html/main.tsx/theme-manager/index.css | Vite 工程 + Pinia + vue-router + shadcn-vue + 主题 | token、tailwind 配置 |
| B1 | pages/login|register、features/auth、hooks/use-auth、stores/auth | modules/auth | api/auth.api、use-auth→composable |
| B2 | components/layout、route-persistence、preference-bootstrap | layouts + router 守卫 + 持久化 | 逻辑平移 |
| B3 | features/portfolio、stores/portfolio | modules/portfolio | api/portfolio.api |
| B4 | pages/dashboard、features/overview、hooks/use-query-data/use-portfolios/use-preferences | modules/overview | overview.api、query.api、ECharts 配置、utils |
| B5 | pages/holdings、features/holdings、hooks/use-holdings | modules/holdings | holding.api、url-query |
| B6 | pages/transactions(cashflow tab)、features/cashflow/cashflow-*、features/transaction、hooks/use-transactions | modules/cashflow | transaction.api、query-params |
| B7 | pages/transactions(balance tab)、features/cashflow/cash-balance-*、hooks/use-cash-balances | modules/cash-balance | cash-balance.api |
| B8 | pages/snapshots、features/snapshot、hooks/use-snapshots | modules/snapshot | snapshot.api |
| B9 | features/security-trade、hooks/use-security-trades | modules/security-trade | security-trade.api |
| B10 | features/security-income、hooks/use-dividends | modules/security-income | dividend.api |
| B11 | features/security-price、hooks/use-security-prices | modules/security-price | security-price.api |
| B12 | pages/xirr-analysis|nav-analysis、components/charts | modules/analysis | query.api、ECharts 配置 |
| B13 | features/data-transfer、hooks/use-data-transfer | modules/data-transfer | data-transfer.api、papaparse、csv 工具 |
| B14 | pages/account、features/account、hooks/use-account | modules/account | account.api |
| B15 | pages/admin、features/admin、hooks/use-interface-*/use-quote-*/use-security-master | modules/admin | 对应 api |
| B16 | pages/settings、features/query（quick-range/dimension-switcher）、hooks/use-range-preference-sync | modules/settings + query | preference.api |

---

## 5. 可复用资产清单（跨框架，直接平移）

| 资产 | 文件 | 说明 |
|---|---|---|
| API 类型 | `api/types.ts`（手写复用类型，非生成） | 原样复用；真正的 OpenAPI 生成物为 `src/types/api.ts`，由 `generate:api` 脚本生成并保留 |
| API 客户端 | `lib/api-client.ts` | axios 封装 + 拦截器 + 信封解包，纯 JS/TS 可复用 |
| 错误消息 | `lib/api-error-message.ts` | 响应码 → 中文提示映射 |
| 业务类型 | `lib/types.ts` | 领域模型与枚举（CashFlowType 等） |
| 格式化工具 | `lib/utils.ts` | formatCurrency/formatPercent/formatDecimal/formatDate 等（已防 NaN） |
| URL 状态 | `lib/url-query.ts` | 查询参数序列化/白名单 |
| 时间工具 | `today-in-app-tz` / `now-in-app-tz` | 应用时区换算 |
| 常量 | `lib/constants.ts` | ROUTE_PATH/API 路径/EXPORT 选项/术语 |
| 术语字典 | `constants/entry-button-labels.ts` 等 | 全站按钮/文案统一取值 |
| 图表配置 | `components/charts/*` 的 option 构造 | 平移为 vue-echarts option |
| CSV 工具 | `features/data-transfer/csv-download.ts` | 纯逻辑复用 |

---

## 6. 迁移批次与验收标准

### 6.1 批次依赖

- B0 为所有批次前置（工程基座 + 路由 + 主题 + API 层 + 认证守卫）。
- B1（认证）为后续所有业务页前置。
- B2（布局）在 B1 后即可并行推进。
- B3-B16 业务域互相独立，可在 B0/B1 就绪、**「共享内核」里程碑（common 组件 + 图表封装 + 基础 composables + 常量）落地后**并行迁移；完全并行会因共享模块冲突，须先设共享内核（见 §11.5）。

### 6.2 每批验收标准

1. **功能等价**：对照功能矩阵逐项操作验证，行为与 React 版一致（含边界：空数据、负数、0 值、加载/错误态）。
2. **视觉达标**：对照 `ui-optimized-preview-2026-08-17.html`（限宽布局、tabular-nums、token 化错误色、统一空态、明暗主题）。
3. **测试通过**：
   - 纯逻辑：现有 vitest 用例（lib/url-query、utils、时间工具、amount 工具、query-params）**原样迁移**。
   - 组件/页面：React Testing Library 用例**不可复用**，按行为补写 @vue/test-utils 用例（每模块至少覆盖：渲染、空态、表单校验、提交、错误提示）。
4. **TypeScript 严格模式**：`vue-tsc --noEmit` 零错误（注意 `tsc` 不检查 `.vue` 模板类型，必须用 `vue-tsc`）。
5. **路由与持久化**：刷新恢复路由、登录意图重定向、主题记忆、偏好同步行为不变。

---

## 7. 关键风险与缓解

| 风险 | 影响 | 缓解 |
|---|---|---|
| 30+ React 测试不可直接复用 | 重写期间回归保障弱 | 按批补写 @vue/test-utils；纯逻辑测试先行平移；每批用功能矩阵人工对照 |
| 长表单/聚合页重写复杂度高（security-trade-form、dashboard） | 单批工时与缺陷风险高 | 拆为独立批次；复用 React 版表单字段/zod schema（zod 跨框架复用） |
| 拖拽（admin 排序）dnd-kit → sortablejs 行为差异 | 交互不一致 | 该批单独验收，功能矩阵含"拖拽排序"项 |
| ECharts 从 react 封装 → vue-echarts | 配置/事件差异 | 仅换挂载层，option 逻辑平移；保留交互（tooltip/联动） |
| 双栈并行期间 bug 双修 | 维护成本 | 迁移完成后即停用 React 维护；期间以 Vue 为准、React 仅修阻断问题 |
| shadcn-vue 组件版本与现有 Radix 行为差异 | 细微交互差异 | B0 先做基础组件对照清单，逐项对齐 |

---

## 8. 术语与文案决策（承接审查报告，已确认）

- **维持原 M2**：业务术语统一为「出入金」系列；页面/组件/导出均使用「出入金流水」，不再使用「现金流 / 交易记录」作同义混用。说明：`features/cashflow` 目录内的 Cashflow（出入金流水）与 CashBalance（现金余额）本就是两个独立模块（transactions 页两个页签），文案上「现金余额」单独命名，不并入「出入金」。
- **维持原 M3**：无组合空态统一为「还没有投资组合 + 创建组合后即可开始录入出入金和买卖数据 + 去创建组合按钮」（EmptyState 组件化）。
- 系统名统一为「投资收益统计系统」（H2）。
- 错误提示统一走 `text-destructive` token（H1）。
- 其他见审查报告 §1（L1/L3/L4/L7 等）在 Vue 实现中直接按优化后形态落地。

---

## 9. 里程碑建议

| 阶段 | 内容 | 出口 |
|---|---|---|
| P0 | 方案评审 + 选定组件库 + B0 工程基座 | Vue 工程可启动、可主题切换、API 联通 |
| P1 | B1 认证 + B2 布局 + B3 组合 | 可登录并进入空态概览 |
| P2 | B4 概览 + B5 持仓 | 核心数据可见 |
| P3 | B6 出入金 + B7 现金余额 + B8 快照 | 数据录入闭环 |
| P4 | B9-B12 买卖/分红/价格/分析 | 完整业务覆盖 |
| P5 | B13-B16 导入导出/账户/管理/设置 | 全功能等价 |
| P6 | 全量功能矩阵回归 + 停用 React 版 | 迁移完成 |

---

## 10. 已确认决策与待确认事项（评审后更新 2026-08-17）

### 10.1 已确认决策（评审通过，标注「已评审确认」）
- 组件库：**shadcn-vue + reka-ui**（评审确认；备选 Naive UI 不采用）。
- 项目目录：**新建 `web-vue/` 与现有 `web/` 并行**，迁移完成且全量回归通过后切换；期间以 Vue 为准、React 仅修阻断问题。
- 包管理器：**pnpm**（与现有 Dockerfile `pnpm install --frozen-lockfile` 一致；`web-vue/` 须同样用 pnpm 并提交 `pnpm-lock.yaml`）。
- Tailwind：**保持 Tailwind 3**，禁止 shadcn-vue CLI 自动升级到 Tailwind 4（TW4 改 oklch + `@theme` 会破坏现有 HSL 配置）；自定义涨跌色工具类（`.text-up/.text-down/.bg-up-soft/.bg-down-soft`）与 `index.html` FOUC 防闪白内联脚本须手动平移。
- 拖拽库：**vue-draggable-plus**（取代方案原写的 `vuedraggable@next`，Vue3 原生、封装 sortablejs、a11y 更佳），仅 1 处 admin 排序用例。
- 验收类型检查：`vue-tsc --noEmit`（原方案 `tsc --noEmit` 不覆盖 `.vue` 模板，已修正）。

### 10.2 仍待确认 / 后续单独处理
- **Docker 部署切换**（Dockerfile / docker-entrypoint.sh / .dockerignore / vite 代理改指 `web-vue/`）：用户 2026-08-17 确认本次先行跳过，不阻塞 P0；待方案主体完成后单独补「部署切换」章节与切流时机。
- 工作量估算（人天）与每批负责人 / 并行边界：评审要求补充，见 §11.5 与 §12 工作量注记。

---

## 11. 技术评审结论（2026-08-17，SoftwareCompany）

> 评审方法：由架构师对照真实 `web/` 代码库逐项实查（Glob / Grep / Read / 抽查 package.json），结论均基于真实代码，非方案文字。

### 11.1 可行性总评

**中等可行（中）。** 在「后端 API 不变、仅换展示层」前提下，全量重写方向合理、技术路线对；但方案 §2 标称"已核验"的盘点有多处事实性偏差，且原存在一处**阻断级部署缺口**（Docker 未规划切换到 `web-vue/`，详见 11.4）。按用户 2026-08-17 指示，**Docker 部署切换本次不作为阻塞项**，待主体完成后单独处理。补齐「功能矩阵 + 部署切换 + 工作量估算」三件套后方可进入 P0。

### 11.2 现状盘点核验偏差（实查 `web/`）

| 核验项 | 方案声称 | 真实代码库（实查） | 结论 |
|---|---|---|---|
| `features/` | 16 | **14**（误重复 `query`、列入不存在的 `nav`） | ❌ |
| `components/ui` | 18 | **19**（多出 search-input、section） | ❌ |
| `api/` | 24（`types.ts` 由 OpenAPI 生成） | **25**（含 2 测试）；且 `api/types.ts` 为**手写复用类型，非生成** | ❌ |
| `stores/` | 3（目录） | 3 个扁平 `.store.ts` 文件 | ⚠️ |
| 测试 | "30+" | **49 个**（约 34 个组件测试不可复用） | ❌ 严重少报 |
| OpenAPI 脚本 | `gen-api-types` → `api/types.ts` | 脚本名 `generate:api` → 生成物 `src/types/api.ts` | ❌ 名/路径错 |
| `dnd-kit` 用法 | admin 排序 | 仅 1 处（`quote-provider-section.tsx`） | ✅ 范围极小 |
| ECharts 用法 | option 可平移 | 6 图均为 `useMemo` 纯 option 对象，无 `onEvents`/跨图联动 | ✅ 风险低 |

### 11.3 依赖升级逐项评估

| 库 | 现状 → 目标 | 成熟度 | 主要坑 | 风险 |
|---|---|---|---|---|
| 组件库 | shadcn/ui+Radix → **shadcn-vue+reka-ui** | 中 | focus-trap / portal 定位 / scroll-lock / toast 队列 / `data-state` 动画差异；动画用 tw-animate-css 而非 tailwindcss-animate | 中 |
| 状态 | zustand → **Pinia** | 高 | 概念 1:1，auth/portfolio/preference 直接映射 | 低 |
| 请求 | react-query → **@tanstack/vue-query** | 高(v5) | query 返回 ref、reactive key 需正确解包 | 低-中 |
| 表单 | react-hook-form+zod → **vee-validate+zod** | 高 | API 范式不同（`useForm`+`<Field>` vs register/Controller）；zod schema 可复用；security-trade-form、dashboard 长表单复杂 | 中 |
| 路由 | react-router6 → **vue-router4** | 高 | 守卫范式（return vs next()）不同；path 常量可复用 | 低-中 |
| 拖拽 | @dnd-kit → **vue-draggable-plus**（评审改荐） | 中 | 原方案写的 `vuedraggable@next` 为 Vue2 时代、a11y 弱；vue-draggable-plus Vue3 原生、a11y 更佳 | 低-中（仅 1 组件） |
| 图表 | echarts-for-react → **vue-echarts** | 高 | option 完全相同；需加 autoresize、保留 formatter/extraCssText | 低（已证无事件联动） |
| Toast | sonner → **vue-sonner** | 中 | API 近似，部分 props（duration/position）差异 | 低-中 |
| 图标 | lucide-react → **lucide-vue-next** | 高 | 图标名 1:1，仅 import 路径变 | 低 |
| 日期/CSV | date-fns / papaparse | 高 | 原样复用 | 无 |
| 测试 | Testing Library → **@vue/test-utils** | 高 | 工具成熟；但 ~34 个组件用例需重写 | 低(工具)/高(工作量) |

### 11.4 兼容性与缺口清单

1. **【已按用户指示跳过，不阻塞 P0】Docker 部署切换遗漏**：`docker/Dockerfile` 硬编码 `WORKDIR /web`、`FRONTEND_DIR=/app/web/dist`；`.dockerignore` 仅排除 `web/`；`vite.config.ts` 含 `/api → :3000` 代理。方案须在未来补「部署切换」专章（改指 `web-vue/` + 切流时机）。本次不阻塞。
2. **pnpm 未声明**：Dockerfile 用 `pnpm install --frozen-lockfile`，`web-vue/` 必须同样用 pnpm 并提交 `pnpm-lock.yaml`。
3. **`tsc` → `vue-tsc`**：验收标准已修正为 `vue-tsc --noEmit`（§6.2）。
4. **Tailwind 3 锁定**：方向正确；须禁 shadcn-vue CLI 自动升 4，并手动补回自定义涨跌色工具类与 `index.html` FOUC 脚本。
5. **OpenAPI 生成脚本复用**：`generate:api` 为纯 Python、框架无关，可原样复用；须（a）在 `web-vue/package.json` 补 `generate:api` 脚本、（b）输出路径保持 `src/types/api.ts`、（c）修正方案对脚本名/路径的错误描述（已在 §2.2/§5 修正）。

### 11.5 组件改造范围与工作量

- **真实规模**（实查）：12 页面 · 14 业务模块 · 22 hooks · 3 stores · 25 api · 19 UI 组件 · 6 图表 · 8 通用组件 · **49 测试（约 34 组件测试不可复用）**。
- **批次拆分（B0-B16）维度合理**，但 **"B3-B16 全并行"不现实**——它们共用图表封装 / common 组件 / 基础 composables（use-portfolios/use-preferences/use-query-data）/ constants。完全并行会冲突。
  - **建议**：B0 后增设**「共享内核」里程碑**（先落地 common 组件 + 图表封装 + 基础 composables + 常量），再并行。
- **缺工作量估算**：全文无「人天 / 负责人 / 并行边界」，里程碑排期无依据（见 §12 工作量注记）。
- **回归体量被低估**：方案称「30+ 测试不可复用」实为 ~34 组件测试需重写，且验收仅靠「人工对照功能矩阵」——无 CI 可验证回归、双栈期无并排比对。建议保留 React 可运行用于并排比对，并考虑 Playwright 冒烟替代纯人工。

### 11.6 关键风险 Top 5（按影响排序）

1. **【已跳过，非阻塞】部署/Docker 切换遗漏**——迁移后镜像仍指向 `web/` 或构建失败。
2. **测试回归保障缺失**——~34 组件测试重写 + 无自动化/并排比对，等价性难验证、缺陷易漏出。
3. **shadcn-vue 行为差异 + 自定义涨跌色/FOUC/动画未纳入平移**——拖拽排序等交互细节回归风险。
4. **「功能矩阵」被反复引用却未附文档**——等价性验收无客观基准（本文 §12 已补齐）。
5. **B3-B16 全并行假设 + 零估算**——共享模块冲突、排期/资源失控。

### 11.7 修改建议清单

**A. 方案须先补充（P0 前置，blocking）**
- ✅ 已补**功能矩阵**（本文 §12，字段级表单 + 行为级非表单）。
- ⏸ Docker「部署切换」专章（用户指示本次跳过）。
- ✅ 已修正 §2.2 / §5 事实错误（features 14、ui 19、api 25 且 types 非生成、stores 扁平、`generate:api` 脚本名/路径）。
- ✅ 已明确决策并在 §10.1 标注「已评审确认」（shadcn-vue+reka-ui / `web-vue` 并行 / pnpm / Tailwind 3 锁定 / vue-draggable-plus / `vue-tsc`）。
- ⏳ 增加**工作量估算（人天）+ 每批负责人/并行边界 + 共享内核里程碑**（见 §12 工作量注记，待排期时填）。
- ✅ 验收标准 `tsc` → `vue-tsc --noEmit`。

**B. 执行期注意事项（non-blocking，供 Engineer 参考）**
- B0 必含共享内核再并行；reka-ui 版本锁定 + B0 做组件逐项对照清单（focus trap/portal/scroll-lock/toast 队列/`data-state` 动画）。
- 手动平移涨跌色工具类与 FOUC 脚本；图表 option 整段平移 + vue-echarts autoresize。
- 拖拽用 vue-draggable-plus；zod schema 复用；约 15 个纯逻辑测试平移、约 34 个组件测试重写、考虑 Playwright 冒烟替代纯人工对照。
- 双栈期保持 React 可运行用于并排比对，以 Vue 为准、React 仅修阻断问题。

---

## 12. 功能矩阵（字段级表单 + 行为级非表单）

> 等价性验收唯一客观基准。表单页按**字段级**（每字段一行：控件 / Zod 校验 / 边界态 / 视觉&行为约束）；图表、列表、布局类非表单页按**行为级**行。
> 列约定（表单）：模块 · 功能点 · 字段 · 控件 · 校验规则(Zod) · 边界/异常态 · 视觉&行为约束 · 来源 · Vue 目标 · 验证。
> 列约定（行为）：模块 · 功能点 · 行为/验收 · 边界态 · 来源 · Vue 目标 · 验证。

### 12.1 认证 / 账户（B1 / B14）

| 模块 | 功能点 | 字段 | 控件 | 校验规则(Zod) | 边界/异常态 | 视觉&行为约束 | 来源 | 目标 | 验证 |
|---|---|---|---|---|---|---|---|---|---|
| 登录 | 邮箱 | email | Input(email) | `.email('请输入有效的邮箱')` | 空/格式错→行内红字 | 错误色须 `text-destructive`（React 现 `text-red-500`，须改 token） | login-form.tsx | auth | 单测+人工 |
| 登录 | 密码 | password | Input(password) | `.min(6,'密码至少 6 位')` | 空/过短→红字 | 同上 | login-form.tsx | auth | 单测+人工 |
| 登录 | 提交 | — | Button | — | 成功→跳概览；1001 邮箱密码错→toast；**1007 注销冷静期**→切 `AccountRestorePrompt` 恢复引导卡 | loading 禁用+spinner | login-form.tsx / account-restore-prompt.tsx | auth | 人工 |
| 注册 | 邮箱 | email | Input(email) | `.email('请输入有效的邮箱')` | 空/格式错→红字 | `text-destructive` | register-form.tsx | auth | 单测+人工 |
| 注册 | 名称 | name | Input(text) | 可选 `.max(50,'名称最多 50 字')` | 超长→红字 | 标签「名称（可选）」 | register-form.tsx | auth | 单测+人工 |
| 注册 | 密码 | password | Input(password) | `.min(8).regex(字母+数字,'密码需同时包含字母和数字')` | 短/缺字符类→红字 | `text-destructive` | register-form.tsx | auth | 单测+人工 |
| 注册 | 确认密码 | confirmPassword | Input(password) | `.refine(===password,'两次输入的密码不一致')` path=confirmPassword | 不一致→红字 | `text-destructive` | register-form.tsx | auth | 单测+人工 |
| 注册 | 提交 | — | Button | — | 成功→跳登录；失败→toast | loading 禁用 | register-form.tsx | auth | 人工 |
| 改邮箱 | 当前邮箱 | currentEmail | Input(disabled) | — | 只读回显 `user.email` | 禁用态 | change-email-dialog.tsx | account | 人工 |
| 改邮箱 | 新邮箱 | newEmail | Input(email) | `.min(1).email()` | 空/格式错→红字；前端拦「与当前相同」 | `text-destructive` | change-email-dialog.tsx | account | 单测+人工 |
| 改邮箱 | 当前密码 | currentPassword | Input(password) | `.min(1,'请输入当前密码')` | 空→红字 | `text-destructive` | change-email-dialog.tsx | account | 单测+人工 |
| 改密码 | 当前密码 | currentPassword | Input(password) | `.min(1)` | 空→红字 | `text-destructive` | change-password-dialog.tsx | account | 单测+人工 |
| 改密码 | 新密码 | newPassword | Input(password) | `.min(8).max(100).regex(字母+数字)` | 短/超长/缺类→红字；强度指示(≥8/字母/数字) | `text-destructive` | change-password-dialog.tsx | account | 单测+人工 |
| 改密码 | 确认新密码 | confirmPassword | Input(password) | `.refine(===newPassword)` path=confirmPassword | 不一致→红字；**提交剔除该字段**（防 400） | `text-destructive` | change-password-dialog.tsx | account | 单测+人工 |
| 改资料 | 头像 | avatar | 上传(文件)+URL输入+移除 | `.max(512).refine(空/站内/外链)` | 非 JPG/PNG/WebP 或 >2MB→仅提示不请求；移除→PATCH '' | 上传成功回写预览；头像 URL 不显示站内路径 | edit-profile-dialog.tsx | account | 人工 |
| 改资料 | 昵称 | name | Input(text) | 可选 `.max(100)` | 超长→红字 | — | edit-profile-dialog.tsx | account | 单测+人工 |
| 改资料 | 手机号 | phone | Input(text) | 可选 `.refine(/^1[3-9]\d{9}$/,'请输入正确的手机号')` | 非法→红字 | — | edit-profile-dialog.tsx | account | 单测+人工 |
| 改资料 | 个人简介 | bio | Textarea | 可选 `.max(200)` | 超长→红字 | 计数 `n/200` | edit-profile-dialog.tsx | account | 单测+人工 |
| 改资料 | 提交 | — | Button | — | 未填字段归一 ''（表达清空）；`disabled=!isDirty` | loading 禁用 | edit-profile-dialog.tsx | account | 人工 |

### 12.2 组合 / 布局 / 路由（B2 / B3）

| 模块 | 功能点 | 字段 | 控件 | 校验规则(Zod) | 边界/异常态 | 视觉&行为约束 | 来源 | 目标 | 验证 |
|---|---|---|---|---|---|---|---|---|---|
| 组合 | 名称 | name | Input(text) | `.min(1,'请输入组合名称').max(50,'名称最多 50 字')` | 空/超长→红字 | — | portfolio-dialog.tsx | portfolio | 单测+人工 |
| 组合 | 描述 | description | Textarea | 可选 `.max(200)` | 超长→红字 | — | portfolio-dialog.tsx | portfolio | 单测+人工 |
| 组合 | 提交 | — | Button | — | 创建/编辑两态 | 按钮「创建/保存」；loading 禁用 | portfolio-dialog.tsx | portfolio | 人工 |

| 模块 | 功能点 | 行为/验收 | 边界态 | 来源 | 目标 | 验证 |
|---|---|---|---|---|---|---|
| 路由守卫(B2) | 鉴权 | 未登录→/login；已登录→/；带 `?redirect=` 登录意图重定向 | 无 token 直访受保护页→跳登录 | auth-guard.tsx | layouts/router | 人工 |
| 路由持久化(B2) | 刷新恢复 | 刷新后停留在当前路径 | 深链刷新不丢 | route-persistence.tsx | router | 人工 |
| 主题记忆(B2) | 明暗 | `.dark` + localStorage 记忆 | **FOUC 防闪白内联脚本须重建**（index.html） | theme-manager.tsx | App.vue | 人工+回归 |
| 偏好引导(B2) | bootstrap | 启动时加载偏好 | 偏好缺失→默认 | preference-bootstrap.tsx | App.vue | 人工 |
| 统一空态(B2) | 无组合 | 文案「还没有投资组合…」+去创建组合按钮 | 任意业务页无组合均触发 | EmptyState.tsx | common | 人工 |
| 通用组件(B2) | UserAvatar/PageHeader/LoadingSpinner | 一致渲染 | 头像加载失败兜底 | components/* | common | 人工 |
| 错误色(B2) | token 化 | 所有错误文案走 `text-destructive` | 取代 React `text-red-500` 硬编码 | 多组件 | ui | 人工+单测 |

### 12.3 出入金 / 现金余额（B6 / B7，两个独立模块）

| 模块 | 功能点 | 字段 | 控件 | 校验规则(Zod) | 边界/异常态 | 视觉&行为约束 | 来源 | 目标 | 验证 |
|---|---|---|---|---|---|---|---|---|---|
| 出入金 | 类型 | type | Select | `nativeEnum(CashFlowType)`：存入(BUY)/取出(SELL) | 默认「存入」；编辑回填 | 选项文案「存入/取出」（M2 术语） | cashflow-form.tsx | cashflow | 单测+人工 |
| 出入金 | 日期 | date | Input(date) | `.min(1).refine(≤今天,'日期不能为未来')` | 空/未来→红字 | `max=today`，默认今天 | cashflow-form.tsx | cashflow | 单测+人工 |
| 出入金 | 金额 | amount | Input(number,.01) | `.min(1).refine(>0,'金额必须大于 0')` | 空/0/负→红字 | 占位 0.00 | cashflow-form.tsx | cashflow | 单测+人工 |
| 出入金 | 备注 | note | Textarea | 可选 `.max(200)` | 超长→红字 | 占位「工资入金/生活支出」 | cashflow-form.tsx | cashflow | 单测+人工 |
| 出入金 | 提交 | — | Button | — | 新建→重置+toast软提示；编辑→回填 | loading 禁用；文案「录入/保存」 | cashflow-form.tsx | cashflow | 人工 |
| 现金余额 | 生效日 | asOf | Input(date) / 编辑锁定显示 | `.min(1).refine(≤今天)` | 新增可选；**编辑锁定**（upsert 按 asOf 覆盖，改日期=新建） | 编辑态显示 `formatDate` +「生效日不可修改」 | cash-balance-form.tsx | cash-balance | 单测+人工 |
| 现金余额 | 金额 | amount | Input(number,.01,min0) | `.min(1).refine(≥0,'金额必须为不小于 0 的数字')` | 空→红字；**允许 0**（清空现金） | 占位 0.00 | cash-balance-form.tsx | cash-balance | 单测+人工 |
| 现金余额 | 备注 | note | Textarea | 可选 `.max(200)` | 超长→红字 | 占位「券商账户可用余额对账」 | cash-balance-form.tsx | cash-balance | 单测+人工 |
| 现金余额 | 提交 | — | Button | — | **失败不关闭弹窗**，就地 `role=alert` 显示后端错误（不重复 toast） | loading 禁用 | cash-balance-form.tsx | cash-balance | 人工 |

> 注意：出入金（`Cashflow`）与现金余额（`CashBalance`）为**两个独立模块**，cashflow 表单**不含证券明细字段**。

### 12.4 快照（B8）

| 模块 | 功能点 | 字段 | 控件 | 校验规则(Zod) | 边界/异常态 | 视觉&行为约束 | 来源 | 目标 | 验证 |
|---|---|---|---|---|---|---|---|---|---|
| 快照 | 日期 | date | Input(date,max today) | `.min(1).refine(≤今天)` | 空/未来→红字 | — | snapshot-form.tsx | snapshot | 单测+人工 |
| 快照 | 当日总资产 | totalAsset | Input(number,.01) | `.min(1).refine(>0,'金额必须大于 0')` | 空/≤0→红字 | 占位 0.00 | snapshot-form.tsx | snapshot | 单测+人工 |
| 快照 | 持仓市值 | marketValue | Input(number,.01) | 可选 `.refine(≥0,'持仓市值不能为负')` | 负→红字 | 占位「可选」 | snapshot-form.tsx | snapshot | 单测+人工 |
| 快照 | 现金余额 | cashBalance | Input(number,.01) | 可选 `.refine(≥0,'现金余额不能为负')` | 负→红字 | 占位「可选」 | snapshot-form.tsx | snapshot | 单测+人工 |
| 快照 | 备注 | note | Textarea | 可选 `.max(200)` | 超长→红字 | 「建议填写修正原因」 | snapshot-form.tsx | snapshot | 单测+人工 |
| 快照 | 覆盖提示 | — | 提示卡 | — | 该日已有自动记录→amber「将被覆盖」+「系统自动计算值 ¥x，保存后取代」 | amber 提示框 | snapshot-form.tsx | snapshot | 人工 |
| 快照 | 提交 | — | Button | — | 新建/编辑 DERIVED→POST upsert（变手工）；编辑 MANUAL→PATCH | 按钮「保存并重算」；loading 禁用 | snapshot-form.tsx | snapshot | 人工 |

### 12.5 证券买卖（B9，长表单）

| 模块 | 功能点 | 字段 | 控件 | 校验规则(Zod) | 边界/异常态 | 视觉&行为约束 | 来源 | 目标 | 验证 |
|---|---|---|---|---|---|---|---|---|---|
| 买卖 | 方向 | side | Select | `nativeEnum(SecuritySide)`：买入/卖出 | 必填；新建默认买入 | — | security-trade-form.tsx | security-trade | 单测+人工 |
| 买卖 | 日期 | date | Input(date,max today) | `.min(1).refine(≤今天)` | 空/未来→红字 | — | security-trade-form.tsx | security-trade | 单测+人工 |
| 买卖 | 标的 | securityId | SecuritySearchCombobox | `.min(1,'请选择标的')` | 空→红字；选中主数据 resolve→回填 | 编辑首帧保底回显「名称（代码）」 | security-trade-form.tsx | security-trade | 单测+人工 |
| 买卖 | 资产类型 | securityType | Select(8 类) | — | 选中证券后自动带出，可手动改（触发 updateSecurity+toast） | 禁用态判定 | security-trade-form.tsx | security-trade | 人工 |
| 买卖 | 数量 | quantity | Input(number,.000001) | `.min(1).refine(>0,'数量必须大于 0')` | 空/≤0→红字 | 占位 0 | security-trade-form.tsx | security-trade | 单测+人工 |
| 买卖 | 成交额 | tradeAmount | Input(text,decimal) | `.min(1).refine(6位小数).refine(>0)` | 空/≤0/超6位→红字 | 占位 0.00 | security-trade-form.tsx | security-trade | 单测+人工 |
| 买卖 | 佣金 | commission | Input(text) | 可选 `.refine(2位小数,≥0)` | 非法→红字 | 三框并列 | security-trade-form.tsx | security-trade | 单测+人工 |
| 买卖 | 印花税 | stampTax | Input(text) | 同佣金 | 同佣金 | 三框并列 | security-trade-form.tsx | security-trade | 单测+人工 |
| 买卖 | 其他 | other | Input(text) | 同佣金 | 同佣金 | 三框并列 | security-trade-form.tsx | security-trade | 单测+人工 |
| 买卖 | 费用合计 | — | 预览 | — | 实时 `formatCurrency`；**卖出费用合计>成交额→阻止**(path tradeAmount '费用合计不能超过成交额') | tabular-nums | security-trade-form.tsx | security-trade | 人工 |
| 买卖 | 成本价(自动) | — | 只读预览 | — | 买=(额+费)/量；卖=(额-费)/量；6 位；≤0 不显示 | tabular-nums | security-trade-form.tsx | security-trade | 人工 |
| 买卖 | 备注 | note | Textarea | 可选 `.max(200)` | 超长→红字 | — | security-trade-form.tsx | security-trade | 单测+人工 |
| 买卖 | 提交 | — | Button | — | 录入/编辑同 schema，提交 `/security-trades`；long-form 须行为测试覆盖 | loading 禁用；文案「录入/保存」 | security-trade-form.tsx | security-trade | 人工 |

### 12.6 分红（B10）

| 模块 | 功能点 | 字段 | 控件 | 校验规则(Zod) | 边界/异常态 | 视觉&行为约束 | 来源 | 目标 | 验证 |
|---|---|---|---|---|---|---|---|---|---|
| 分红 | 标的 | securityId | SecuritySearchCombobox | `.min(1,'请选择标的')` | 空→红字 | 编辑回显「名称（代码）」 | dividend-fee-form.tsx | security-income | 单测+人工 |
| 分红 | 日期 | date | Input(date) | `.min(1).refine(≤今天,'日期不能为未来')` | 空/未来→红字 | — | dividend-fee-form.tsx | security-income | 单测+人工 |
| 分红 | 类型 | type | 录入固定现金分红 / 编辑 Select(CASH/红利再投) | `nativeEnum(DividendType)` 可选 | 录入态固定「现金分红（红利再投不录入）」；编辑可改 | 标签差异 | dividend-fee-form.tsx | security-income | 人工 |
| 分红 | 分红额(税前) | amount | Input(text,decimal) | `.refine(isMoneyString 2位).refine(>0)` | 空/≤0/超2位→红字 | 占位 0.00 | dividend-fee-form.tsx | security-income | 单测+人工 |
| 分红 | 所得税 | tax | Input(text) | 可选 `.refine(2位,≥0)` | 负/超2位→红字 | 标签「（可选）」 | dividend-fee-form.tsx | security-income | 单测+人工 |
| 分红 | 净额(自动) | — | 只读预览 | `.refine(净额≥0,'净额不能为负')` path tax | 税>税前→红框 | tabular-nums | dividend-fee-form.tsx | security-income | 人工 |
| 分红 | 备注 | note | Textarea | 可选 `.max(200)` | 超长→红字 | — | dividend-fee-form.tsx | security-income | 单测+人工 |
| 分红 | 提交 | — | Button | — | 创建/更新；**payload 必带 type**（防 forbidNonWhitelisted 400） | loading 禁用；口径提示卡「不计入现金流/XIRR」 | dividend-fee-form.tsx | security-income | 人工 |

### 12.7 管理：行情来源 / 接口 / 分类（B15）

| 模块 | 功能点 | 字段 | 控件 | 校验规则 | 边界/异常态 | 视觉&行为约束 | 来源 | 目标 | 验证 |
|---|---|---|---|---|---|---|---|---|---|
| 提供方 | 名称 | name | Input | 必填(trim)；**重名校验**(创建/编辑排除自身) | 空→toast「请填写名称」；重名→「已存在同名」 | `text-red-500` | quote-provider-dialog.tsx | admin | 单测+人工 |
| 提供方 | 接入方式 | accessMethod | Select | https / sdk | 切换显示 baseUrl 或 sdkName | — | quote-provider-dialog.tsx | admin | 人工 |
| 提供方 | API 基础地址 | baseUrl | Input | https 时必填 | 空→toast | — | quote-provider-dialog.tsx | admin | 人工 |
| 提供方 | SDK 名称 | sdkName | Input | sdk 时必填 | 空→toast | — | quote-provider-dialog.tsx | admin | 人工 |
| 提供方 | 描述 | description | Textarea | 可选 | — | — | quote-provider-dialog.tsx | admin | 人工 |
| 提供方 | 启用 | enabled | Switch | 默认 true | — | — | quote-provider-dialog.tsx | admin | 人工 |
| 接口 | 接口分类 | categoryId | Select(读分类,纯外键) | 必填 | 空→toast「请选择接口分类」 | 不可自定义 | quote-interface-dialog.tsx | admin | 人工 |
| 接口 | 名称 | name | Input | 必填 | 空→toast | — | quote-interface-dialog.tsx | admin | 人工 |
| 接口 | 调用路径 | endpoint | Input | 可选 | — | 占位/SDK 函数名 | quote-interface-dialog.tsx | admin | 人工 |
| 接口 | HTTP 方法 | httpMethod | Select | GET/POST/PUT/DELETE/PATCH/不设置 | — | — | quote-interface-dialog.tsx | admin | 人工 |
| 接口 | 资产类别 | assetClass | 多选按钮(8 类) | 可空 | — | 多选切换 | quote-interface-dialog.tsx | admin | 人工 |
| 接口 | 启用 | enabled | Switch | 默认 true | — | — | quote-interface-dialog.tsx | admin | 人工 |
| 接口 | 字段映射 | respCode/Price/Name/Exchange | Input | 可选(默认 code/price/name) | 数组行填下标 | 提示卡 | quote-interface-dialog.tsx | admin | 人工 |
| 接口 | 响应格式 | rpFormat | Select | json / text_split | text_split 显编码/分隔符/行正则 | 腾讯财经 gbk / `~` | quote-interface-dialog.tsx | admin | 人工 |
| 接口 | 代码参数名 | rpCodeParam | Input | 默认 code / 腾讯 q | — | 提示 | quote-interface-dialog.tsx | admin | 人工 |
| 接口 | 代码前缀补全 | rpCodePrefix | Select | 原样 / auto | auto 位数感知补 sh/sz/hk | 提示卡 | quote-interface-dialog.tsx | admin | 人工 |
| 接口 | 参数模板 | params | 键值对增删 | 空值忽略 | 增/删行 | — | quote-interface-dialog.tsx | admin | 人工 |
| 接口 | 超时/重试/频率 | timeout/retryCount/rateLimit | Input | 可选(数字/文本) | — | 频率如 100/min | quote-interface-dialog.tsx | admin | 人工 |
| 接口 | 提交 | — | Button | — | Tabs：基本信息/字段映射/响应解析/高级设置 | loading 禁用 | quote-interface-dialog.tsx | admin | 人工 |
| 分类 | 展示名 | label | Input | 必填 | 空→不提交 | — | interface-category-dialog.tsx | admin | 人工 |
| 分类 | 图标 | icon | Input | 可选(lucide 名) | — | 占位 List | interface-category-dialog.tsx | admin | 人工 |
| 分类 | 排序 | sortOrder | Input(number) | 默认 0 | — | — | interface-category-dialog.tsx | admin | 人工 |
| 分类 | 提交 | — | Button | — | **仅编辑**（系统分类不可增删） | loading 禁用 | interface-category-dialog.tsx | admin | 人工 |

| 模块 | 功能点 | 行为/验收 | 边界态 | 来源 | 目标 | 验证 |
|---|---|---|---|---|---|---|
| 提供方排序(B15) | **拖拽排序** | DndContext+SortableContext 对来源分组拖拽排序 | 仅 1 处用例；用 vue-draggable-plus 重写并单独验收 | quote-provider-section.tsx | admin | 人工+Playwright |
| 通知(B15) | 通知铃 | 展示/标记已读 | 未读角标 | notification-bell.tsx | admin | 人工 |
| 列表测试(B15) | 股票列表测试点 | 触发单点同步测试 | 成功/失败提示 | stock-list-test-section.tsx | admin | 人工 |

### 12.8 导入 / 导出（B13）

| 模块 | 功能点 | 字段 | 控件 | 校验规则 | 边界/异常态 | 视觉&行为约束 | 来源 | 目标 | 验证 |
|---|---|---|---|---|---|---|---|---|---|
| 导入 | 导入类型 | type | 按钮组 | SECS/CF/AS，默认 CASH_FLOWS | 切换重置 | — | import-dialog.tsx | data-transfer | 人工 |
| 导入 | 文件 | file | Input(file) | `.csv/.xlsx/.xls`，≤5MB，≤10000 行 | 非类型/超限→提示 | accept 限定 | import-dialog.tsx | data-transfer | 人工 |
| 导入 | 预览 | — | 表格 | 前 10 行 + 全量错误（**不落库**） | 错误行红框；validRows>0 才可提交 | amber 备份提示 | import-dialog.tsx | data-transfer | 人工 |
| 导入 | 确认导入 | — | Button | — | 提交 toast「新增N更新M重算X」 | 单次重算 | import-dialog.tsx | data-transfer | 人工 |
| 导出 | 数据类型 | types | 多选 checkbox(7 类) | 至少选 1 | 全不选→toast | — | export-panel.tsx | data-transfer | 人工 |
| 导出 | 格式 | format | Select | csv / xlsx，默认 csv | — | — | export-panel.tsx | data-transfer | 人工 |
| 导出 | 导出 | — | Button | — | **串行下载**(300ms 间隔防拦截)；文件名 `{组合名}-{类型}-{YYYYMMDD}.{ext}` | loading 禁用 | export-panel.tsx | data-transfer | 人工 |

### 12.9 非表单行为级（B4 / B5 / B11 / B12 / B16 / 持仓/价格/账户页）

| 模块 | 功能点 | 行为/验收 | 边界态 | 来源 | 目标 | 验证 |
|---|---|---|---|---|---|---|
| 概览(B4) | 统计卡 | 资产总额/收益等卡渲染 | 无组合→空态 | stat-card.tsx | overview | 人工 |
| 概览(B4) | NAV 趋势图 | nav-trend-chart 渲染 | 无数据→空态；option 整段平移 + vue-echarts autoresize | nav-trend-chart.tsx | overview | 人工+单测(option) |
| 概览(B4) | 区间选择 | date-range-quick-picker 选区间重查 | 非法区间→默认 | date-range-quick-picker.tsx | overview | 人工 |
| 持仓(B5) | 持仓表/增删改 | 列表+操作 | 无组合→空态 | holdings/* | holdings | 人工 |
| 持仓(B5) | 筛选 | holdings-toolbar 搜索/筛选 | 无结果→空态 | holdings-toolbar.tsx | holdings | 人工 |
| 持仓(B5) | CSV 导出 | 导出当前持仓 | 空数据→提示 | csv-download.ts | holdings | 人工 |
| 行情价格(B11) | 行情同步 | 触发 sync_portfolio_prices | 失败→toast；进度提示 | security-price/* | security-price | 人工 |
| 行情价格(B11) | 价格历史 | 列表展示 | 无历史→空态 | security-price/* | security-price | 人工 |
| 快照列表(B8) | 列表/创建/删除 | 操作 | 空→空态 | snapshot/* | snapshot | 人工 |
| (B12) XIRR | 计算+趋势图 | xirr-trend-chart | 数据不足→提示；option 平移 | xirr-trend-chart.tsx | analysis | 人工+单测 |
| (B12) NAV | 趋势图+维度切换 | dimension-switcher | 维度切换重算 | nav-analysis / dimension-switcher | analysis | 人工 |
| 设置(B16) | 偏好/区间/维度同步 | range-preference-sync | 刷新保持 | settings/* | settings | 人工 |
| 账户页(B14) | 账户信息展示 | 资料卡+入口(改邮箱/密码/资料) | — | account/* | account | 人工 |

### 12.10 工作量注记（待排期时填）

- **表单字段级条目**：本矩阵共覆盖 **~70 个字段行**（登录 3 / 注册 5 / 改邮箱 3 / 改密码 3 / 改资料 5 / 组合 3 / 出入金 5 / 现金余额 5 / 快照 7 / 买卖 14 / 分红 8 / 提供方 7 / 接口 12 / 分类 4 / 导入 3 / 导出 3）。
- **非表单行为级条目**：~25 行（布局/路由/概览/持仓/价格/快照/分析/设置/账户/拖拽/通知/测试）。
- **建议排期维度**：按 B0-B16 分批，每批给出「人天 / 负责人 / 并行边界」；共享内核（common+图表封装+基础 composables+常量）单列里程碑，先于 B3-B16。
- **测试回归**：约 15 个纯逻辑用例（url-query/utils/time/amount/query-params/cashflow）原样平移；约 34 个组件用例按行为重写；建议 Playwright 冒烟替代纯人工对照。
