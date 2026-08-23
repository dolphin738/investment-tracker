# 投资回报追踪器 · 前端 UI 设计评审与优化方案（合并版）

> 评审对象：`web/`（Vue 3 + shadcn-vue/reka-ui + Tailwind 3 + ECharts + vue-sonner）
> 评审方法：codebase-memory-mcp 代码图谱（4990 节点 / 17288 边）+ 关键页面与组件逐行审阅
> 评审视角：设计系统一致性 · 视觉层级 · 可访问性(WCAG AA) · 响应式 · 图表主题化 · 组件复用 · 逐页功能块布局
> 评审日期：2026-08-23
>
> 本文为两份评审的合并版：全局设计系统问题（P0–P3）+ 逐页面布局与统一规范。结构：现状 → 问题清单 → 优化方案 → 逐页落地 → 统一规范 → 路线图。

---

## 0. 评审范围与依据

| 审阅对象 | 关键发现落点 |
|---|---|
| `web/src/index.css` | 设计 token 地基（shadcn HSL 变量 + A股涨跌配色） |
| `web/tailwind.config.ts` | Tailwind 3 锁定、color 映射、fontFamily |
| `web/src/App.vue` · `router/index.ts` | 应用外壳、路由与守卫（13 个主页面 + 登录/注册 + 404） |
| `web/src/components/layout/AppLayout.vue` | 顶栏 + 侧边导航 + 响应式 |
| `web/src/components/charts/BaseChart.vue` 及 5 个图表 | 图表封装与主题 |
| `web/src/components/charts/yearly-bar-chart.ts` | 图表颜色硬编码证据 |
| `web/src/modules/overview/pages/DashboardPage.vue` | 概览页（指标卡 / 四宫格） |
| `web/src/modules/holdings/pages/HoldingsPage.vue` | 持仓页（聚合卡 / 11 列表格） |
| `web/src/modules/overview/components/StatCard.vue` | 指标卡片组件 |
| 13 个主页面（Dashboard / Holdings / Transactions / Snapshots / XIRR / NAV / Settings / Account / Admin / LogCenter / Schedule / Login / Register） | 逐页面功能块、文字层级、节奏、信息密度 |

---

## 1. 现状：已经做对的部分（应保留，不要动）

1. **设计 token 地基扎实** — `index.css` 用 shadcn HSL 变量体系，`light/dark` 双主题，并**专门定义了 A股涨跌配色**（`--color-up`/`--color-down` 及 `*-soft` 浅底变体），语义正确（红涨绿跌，对齐 PRD §9.5）。
2. **组件库已成形** — `components/ui/` 下 shadcn-vue 原语（button / card / dialog / table / tabs / select / dropdown / alert / progress / switch / skeleton / textarea / input / label / badge / alert-dialog）齐全，统一基底。
3. **可访问性意识到位** — 图标按钮带 `aria-label`、`:focus-visible` 环、数字用 `tabular-nums`、间距与断点响应式。
4. **数字格式化统一** — `formatCurrency` / `formatPercent` 受偏好驱动（千分位 / 缩写 / 小数位），全站一致。
5. **状态处理成熟** — 每页都有 `Skeleton` / `EmptyState` / 错误重试；图表 tooltip 走 DOM 层 CSS 变量，跟随主题。
6. **数据新鲜度 UX 亮点** — `FreshnessBanner` / `PriceFreshnessBadge` 把"行情是否过期"显式呈现，是金融产品的差异化好设计，建议保留并强化。
7. **URL 状态持久化** — 筛选 / 维度写 URL，可分享可回退。

---

## 2. 问题清单（按严重度）

### 🔴 P0 — 影响主题一致性的硬伤

**P0-1　图表主题未 token 化，暗色模式会"发飘"**
- 证据：`yearly-bar-chart.ts:38-43` 硬编码 `GRID_COLOR='#ccc'`、`AXIS_COLOR='#666'`、`MUTED_COLOR='#94a3b8'`，注释明写"class 未生效，实渲染为 #ccc"。月度热力图、XIRR / 净值 / 总资产三个 `.vue` 图表各自重复硬编码，全站 **4+ 处**互相飘移。
- 影响：① 暗色模式下网格线 / 轴标签过亮或反差失调；② 改主题色要改多处；③ 与 `index.css` 的 token 体系割裂。
- 根因：ECharts canvas 不解析 CSS 变量，开发者就地硬编码了"迁移时实际渲染色"，未建立 **JS ↔ CSS 变量桥**。

**P0-2　三种"指标卡片"视觉语言分裂**
- 证据：
  - 概览页用 `StatCard`（text-2xl 数值 + 小标题 + 趋势箭头，见 `StatCard.vue`）；
  - 持仓页汇总用裸 `<Card><CardContent class="py-3">` 内联块（text-xs 标签 + text-lg 数值，`HoldingsPage.vue:343-395`）；
  - 概览"组合表现对比"又是一种行式列表。
- 三者间距、字号、标签层级都不一致，用户在同一产品里认知三套"卡片 = 一个数字"的范式。

### 🟠 P1 — 视觉层级与节奏

- **P1-1 章节间距不统一**：概览 `space-y-8`、持仓 `space-y-6`、各页不一致 → 无"页面分区节奏"规范。
- **P1-2 数字排版无"数据类型级"规范**：hero 数值 text-2xl、汇总 text-lg、单元格 text-sm，缺可复用的 `.num-*` 工具类（字号 / 字重 / tabular-nums / 颜色语义一次定义）。
- **P1-3 品牌识别薄弱**：`primary` token 是近黑中性色（`222.2 47.4% 11.2%`），全站无 logo / 品牌色点缀，涨跌红绿之外缺少"品牌强调色"；顶栏仅 `{{ APP_NAME }}` 文字。
- **P1-4 聚合卡响应式断点尴尬**：持仓汇总 `grid-cols-2 lg:grid-cols-5`，在 md(768–1024) 仍是 2 列 → 5 项排成 2+2+1，末位孤立。
- **P1-5 页头（PageHeader）未全站统一**（跨页面最高杠杆痛点）：

  | 页面 | 页头写法 | 问题 |
  |---|---|---|
  | Dashboard / Holdings / Transactions / Snapshots / XIRR / NAV | 裸 `<div><h1 class="text-2xl">…<p class="text-sm text-muted-foreground">说明</p></div>` | 结构与说明文字长短不一，右侧操作区有的有有的无 |
  | Settings / Account | `<PageHeader title description>` 组件 | 较规范 |
  | Admin / Schedule / Login / Register | 裸 `<h1>` 或 `<h1>{{ APP_NAME }}</h1>`，无 description | **缺页面说明**，且 Login/Register 把品牌名当成了标题 |

- **P1-6 数值字号 / 标签层级在「同一语义」下漂移**（跨页面痛点）：

  | 位置 | 数值字号 | 标签写法 |
  |---|---|---|
  | XIRR 累计 / 较年初 | `text-3xl` | `CardDescription`(text-sm muted) |
  | NAV 4 卡摘要 | `text-2xl` | `CardDescription`(text-sm muted) |
  | Transactions 当前余额 | `text-xl` | `text-xs muted` |
  | Holdings 聚合卡 | `text-lg` | `text-xs muted` |
  | Dashboard StatCard | `text-2xl` | `text-sm` + 趋势箭头 |

  同是"一个关键数字 + 一个标签"，字号横跨 `lg/xl/2xl/3xl` 四档、标签写法三种。

- **P1-7 区块标题与数值混用 `CardTitle`**（跨页面痛点）：列表型卡片 `CardTitle class="text-base"`（区块标题），但指标卡把 `CardTitle` 直接放上 `text-3xl` 数值——`CardTitle` 既是"区块标题"又是"数值"，语义错位，也导致读屏把数值读作标题。

### 🟡 P2 — 响应式与数据密度

- **P2-1 持仓 11 列表格移动端仅靠 `overflow-x-auto` 横滑**：金融数据密集，手机上横滑 11 列体验差。缺 <640px 的"卡片化"降级或首列冻结。
- **P2-2 错误态每页手写**：`DashboardPage` / `HoldingsPage` 各自拼错误卡片，结构不一，应统一为 `<ErrorState>`。

### 🟢 P3 — 可访问性与打磨

- **P3-1 图表缺文本替代**：ECharts canvas 对读屏不可见，无 `aria-label` / 数据表兜底。
- **P3-2 涨跌色编码双通道**：多数已配 `+ / -` 号（好），需写入规范保持"符号 + 色"双通道不退化。
- **P3-3 缺单一设计 token 参考源 / 组件用法文档**：组件多但无"何时用哪种 card / 间距标尺"的规范，易漂移。

---

## 3. 优化方案（设计系统级）

### 3.1 设计 token 体系增强（单一事实源）

在 `index.css` 现有 HSL token 基础上：

- **新增图表专用 JS 桥** `src/lib/chart-theme.ts`，暴露 `getChartTheme()`，运行时从 `getComputedStyle(documentElement)` 读取 `--border / --muted-foreground / --color-up / --color-down` 并转逗号 HSL；**废除所有硬编码 hex**，各图表 option 统一 import，暗色模式自动跟随。
- **新增图表语义 token**：`--chart-grid` / `--chart-axis` / `--chart-muted`（分别在 `:root` / `.dark` 定义），CSS 里也映射，做到"改一处全站变"。
- **数字排版工具类**：在 `index.css` `@layer utilities` 增 `.num-hero` / `.num-metric` / `.num-cell`（统一字号 + font-bold + tabular-nums）。
- **品牌强调**：引入 `--brand` 主色（建议一抹克制的蓝 / 青，非涨跌色），用于 logo、关键 CTA 描边、当前年柱高亮等。

### 3.2 组件收敛（消除 P0-2）

- 抽 `MetricCard` 统一"标题 + 数值 + 辅助 + 趋势"四要素，提供 `density="compact|default"` 两档：
  - 概览 8 卡用 `default`；持仓汇总 5 卡用 `compact`（尺寸对齐 StatCard 但更紧）。
- `ErrorState` 统一错误卡片（图标 + 文案 + 重试），替换三处手写。
- 保持 `StatCard` 作为 `MetricCard` 的语义别名（或两页统一迁到 `MetricCard`）。

### 3.3 视觉层级与节奏规范

- 页面分区间距标尺：section 用统一的 `--space-section`(2rem / `space-y-6`)；卡片内 padding 统一 `p-4` / `p-5`。
- 响应式聚合卡断点修正：`grid-cols-2 sm:grid-cols-3 lg:grid-cols-5`（避免孤立末位，治 P1-4）。
- 顶栏加品牌 mark（小方块 / 渐变圆 + APP_NAME），强化产品识别。
- **`CardTitle` 仅做区块标题**（`text-base font-semibold`），数值独立元素（治 P1-7）。

### 3.4 响应式数据表降级（P2-1）

- <640px：持仓表切"卡片行"模板（每行标的 = 一张卡，关键列竖排），或 `sticky left-0` 冻结"标的"列 + 横向滑动。提供 `useResponsiveTable` 断点 hook。

### 3.5 可访问性加固（P3）

- 图表组件包 `<figure>` + `aria-label` + `role="img"`，并用 `sr-only` 数据摘要（如"2026 年 XIRR +12.3%"）。
- 涨跌保持"符号 + 色"双通道（已遵守，写入规范）。

### 3.6 设计系统文档（P3-3）

- 新增 `docs/design-system.md`：token 表、组件用法矩阵、间距 / 字号标尺、暗色模式契约、图表主题桥约定。

---

## 4. 逐页面功能块与文字布局优化

### 4.1 Dashboard（概览）
- **现状**：8 个指标卡 + 四宫格（最近交易 / 净值 / 组合表现对比 / 资产分布），指标卡用 `StatCard`（text-2xl），但"组合表现对比"是另一种行式列表 → 与持仓页裸卡构成 P0-2 三态分裂。
- **优化**：
  - 8 卡统一收敛为 `MetricCard default`；"组合表现对比"若也是指标性质，迁 `MetricCard`，否则明确降为 `text-sm` 次级列表（不要介于两者之间）。
  - 页头接入 `PageHeader`；四宫格区加 `<section>` 小标题（如"近期动态"），建立分区节奏。

### 4.2 Holdings（持仓）
- **现状**：顶部聚合卡 `grid-cols-2 lg:grid-cols-5`；下方 11 列表格（仅 `overflow-x-auto`）；汇总用裸 `<Card><CardContent class="py-3">` 内联块（text-xs 标签 + text-lg 数值）。
- **优化**：
  - 聚合卡断点改为 `grid-cols-2 sm:grid-cols-3 lg:grid-cols-5`，消除 md 段"2+2+1"末位孤立（P1-4）。
  - 11 列表格：`<640px` 切"卡片行"模板或 `sticky left-0` 冻结"标的"列 + 横滑（P2-1）。
  - 汇总卡改用 `MetricCard compact`（与 StatCard 同尺寸但更紧），消除裸卡分裂。

### 4.3 Transactions（出入金）
- **现状**：筛选卡（标题"筛选" + 长描述说明作用范围）→ Tabs(流水/余额)。余额页签内：当前余额展示行 `bg-muted/40 p-4` + 两条 `Info` 提示 `<ul>`。
- **优化**：
  - **控制区 vs 结果区层级**：筛选卡与下方列表卡视觉权重相近，用户难区分"我在设条件"和"这是结果"。建议筛选区用更轻的容器（`bg-muted/30` 浅底无重 border，或仅在 `focus` 态高亮），与结果卡拉开层级。
  - 筛选卡描述文字偏长 → 收进 `HelpTip` 图标气泡，默认不占正文行。
  - 当前余额展示行可对齐 `MetricCard` 风格（数值 `text-xl` → 归入 `.num-metric` 标尺）。

### 4.4 Snapshots（资产记录）
- **现状**：页头两段 `<p>` 说明（默认自动记录 / 每天只保留一条）；底部 6 行 `<p>` 图例平铺（沿用/按成本/每天唯一/编辑/删除/撤销）。
- **优化**：
  - 底部图例 6 行纯文字占据大量纵向空间且信息密度低 → 收进 `<details>` 折叠（默认收起，标题"图例说明"）或 `HelpTip` 气泡；只保留最关键的 1 句在页头 description。
  - 页头两段说明合并为 1 句或更短，多余细节进 HelpTip。
  - 接入 `PageHeader`，与全站对齐。

### 4.5 XIRR 分析
- **现状**：维度切换器（`flex flex-wrap items-end gap-4` 包裹，有注释解释对齐问题）→ 两卡 `text-3xl` → 折线图 → 年度柱图 → 明细表（3 列）。
- **优化**：
  - 两卡 `text-3xl` 属"页面级 hero 指标"，合理；但与 NAV 4 卡 `text-2xl` 需在文档中标尺：**hero 级（1–2 个大数）用 3xl，并列多卡用 2xl**，避免未来漂移。
  - 维度切换器旁缺"当前范围"文字回显（仅控件），建议在切换器右侧补一行 `text-xs` 当前起止日期，降低认知成本。

### 4.6 NAV 分析
- **现状**：维度 + 指标 RadioGroup → 4 卡 `text-2xl` → 双线图 → 月度热力图 → 明细表（6 列）。
- **优化**：
  - **冗余文字**：CardDescription 已写"每日收益 =（当日累计净值 - 前日累计净值）x 前日份额；收益百分比 = 每日收益 / 前一日总资产；正红负绿"，底部 `<p class="mt-3 text-xs">` **又把整句公式重复一遍** → 删去脚注，保留 CardDescription 一处即可。
  - 4 卡数值统一标尺（`.num-metric` 2xl），标签 `text-xs`。
  - 明细表 6 列移动端加首列冻结。

### 4.7 Settings（设置）
- **现状**：4 张大卡（账户 / 偏好 / 数据管理 / 危险区）。偏好卡内 13+ 字段，横向网格 `sm:grid-cols-2 xl:grid-cols-4`；"货币/语言"为 `disabled Select + 两行说明"；危险区用 `border-destructive` 区分（good）。
- **优化**：
  - 偏好字段多、长表单滚动成本高 → 用**分组小节**（基础 / 显示 / 高级）或 Tabs 分页；高级项（周起始、过期阈值、软提示）可默认折叠。
  - 禁用项（货币/语言"待后端集成"）当前是完整 Select + 说明两行，占空间且无交互 → 降级为 1 行 muted 文本提示："货币：人民币（CNY，暂不可改）"，删除 disabled 控件。
  - 危险区已用 `border-destructive/40` 与 `bg-destructive/5` 视觉隔离（good，保留）。

### 4.8 Account（账户）
- **现状**：`xl:grid-cols-12` 分配 3/5/4/12（个人信息 / 资产全景 / 数据统计 / 我的组合 / 自动同步），可写卡（我的组合、自动同步）独占整行置于只读卡之后（架构清晰，good）。
- **优化**：
  - 只读三卡与可写两卡混排，建议加两个 `section` 小标题分组（"概览" / "管理"），强化"只读聚合 vs 可操作"的认知边界。
  - 接入 `PageHeader`（已用，但 description 偏长，可精简）。

### 4.9 Admin（金融数据接口）
- **现状**：裸 `<h1>` 无 description；Tabs 切三子模块（接口来源 / 分类 / 股票测试）；"新增数据来源"按钮条件渲染于 quote-provider 页签。
- **优化**：
  - 补 `PageHeader` 描述（"仅管理员可见 · 配置行情数据接口"），与全站对齐。
  - Tab 内容区（QuoteProviderSection 等）建议统一包一层 `Card`，与页头/`TabsList` 形成"标题—控制—内容"三层结构。

### 4.10 LogCenter（日志中心）
- **现状**：`space-y-6` 外层；筛选区 `grid-cols-1 md:grid-cols-2 lg:grid-cols-3`（响应式合理）；详情弹窗 `max-w-3xl` 内 `grid-cols-2` 字段。
- **优化**：
  - 日志表格列多 → 首列冻结 + 移动横滑；日志级别（info/warn/error）加色标 chip 增强可读性（不靠纯文字）。
  - 筛选区字段 6+ 个，`space-y-2` 垂直密度 OK，但 lg:grid-cols-3 下每块说明文字易被挤压 → 字段说明统一 `text-xs`，过长的进 HelpTip。

### 4.11 Schedule（定时任务）
- **现状**：裸 `<h1>` 无描述；外层 Tabs（列表/历史）；编辑弹窗内再嵌 Tabs（basic/rules）。
- **优化**：
  - 补 `PageHeader` 描述。
  - 编辑弹窗嵌套 Tabs 可接受，但 `rules` 下 `map_of` 用 `grid-cols-3` 平铺子字段，字段多时纵向过长 → 考虑 `space-y-3` 分组或滚动区固定高度。
  - 表单字段统一 `space-y-2` + `Label text-xs`（当前基础一致，保持）。

### 4.12 / 4.13 Login / Register
- **现状**：全屏居中 `max-w-md`，`<h1 class="text-center text-2xl">{{ APP_NAME }}</h1>`——**把品牌名当成了页面标题**。
- **优化（文字层级硬伤）**：
  - h1 应改为动作标题 **"登录" / "注册"**；`APP_NAME` 上移为 logo/品牌区（小字或图标 + 产品名作为副标题），建立"品牌 → 动作"的正确层级。
  - 表单字段垂直 `space-y-4`（auth 标准密度），Label `text-sm`、输入框 `h-9`；错误提示 `text-xs text-destructive` 紧跟字段下方。

---

## 5. 统一规范（落地为组件 / 工具类）

1. **`PageHeader` 全站化**：13 页接入，签名 `{ title, description?, actions? }`；h1 统一 `text-2xl font-bold tracking-tight`，description `text-sm text-muted-foreground`。
2. **文字层级标尺**（写进 `design-system.md`）：
   - 页面 H1：`text-2xl font-bold tracking-tight`
   - 区块标题：`text-base font-semibold`（仅 `CardTitle` / `<h2>`）
   - 数值：`.num-hero` 3xl（页面级 1–2 个大数）/ `.num-metric` 2xl（并列多卡）/ `.num-cell` sm `tabular-nums font-mono`
   - 说明三级：页头描述 `text-sm`、卡描述 `text-sm`、行内提示 `text-xs`（统一 muted）
3. **间距标尺**：页面分区统一 `--space-section`(1.5rem，`space-y-6`)；卡片内 padding `p-4`/`p-5`；行内 `space-y-2`。
4. **信息提示组件 `HelpTip`**：替代散落的 `<p class="text-xs">` 长说明（Snapshots 图例、Transactions 筛选说明、Settings 字段说明）→ 默认收起/图标触发，降低正文噪声。
5. **表格移动降级 `useResponsiveTable`**：首列 `sticky left-0` 冻结 + `<640px` 卡片化（Holdings 优先），统一替换各页手写 `overflow-x-auto`。
6. **`ErrorState` 统一**：替换各页手写错误卡。

---

## 6. 落地优先级路线图（合并版）

| 批次 | 内容 | 覆盖页面 | 收益 | 风险 |
|---|---|---|---|---|
| **1** | P0-1 图表主题桥 `chart-theme.ts` + 废除硬编码 hex（4 处 option 文件统一 import） | 全部图表页 | 暗色模式图表一致性立竿见影 | 低 |
| **2** | `PageHeader` 全站化 + 文字层级 / 间距标尺工具类 + `CardTitle` 规范（治 P1-5/P1-6/P1-7） | 全部 13 页 | 消除页头与数值层级漂移，一致性立竿见影 | 低 |
| **3** | P0-2 `MetricCard` 收敛 + P2-2 `ErrorState` 统一 | Dashboard/Holdings/Transactions/XIRR/NAV | 消除卡片与状态组件分裂 | 低 |
| **4** | `HelpTip` 替代长说明文字（治 P1-3 品牌 / 长说明噪声） | Snapshots/Transactions/Settings/LogCenter | 降低正文噪声、信息密度优化 | 中 |
| **5** | P1 数字工具类 / 间距标尺 / 聚合卡断点 / 品牌 mark | 全部 | 视觉层级与品牌识别成型 | 中 |
| **6** | P2-1 `useResponsiveTable` 移动降级 + 首列冻结 | Holdings/NAV/Transactions/Snapshots/LogCenter/Schedule | 移动端表格可用 | 中 |
| **7** | Login/Register 标题纠正（品牌→动作） | Login/Register | 修文字层级硬伤 | 低 |
| **8** | P3 图表 a11y + `design-system.md` | 全部 | 移动端体验与无障碍达标 | 中 |

**结论（最大杠杆）**：布局与一致性层面的最大杠杆是 **批次 2（统一页头 + 文字/间距标尺）** 和 **批次 4（长说明文字收进 HelpTip）**——它们跨所有页面、单点改动即全局受益，且不涉及业务逻辑。建议从**批次 1（图表主题桥）**或**批次 2（PageHeader 全站化）**起步。

---

## 7. 总体结论

地基（token 体系 + 组件库 + 状态处理 + 涨跌语义）已经专业，核心短板集中在 **"图表主题未对接 token 体系"**、**"同类卡片 / 状态组件发散"** 与 **"页头 / 文字层级 / 间距未统一规范"**。优化以"建立 JS↔CSS 主题桥 + 组件收敛 + 统一页头与标尺 + 响应式 / 无障碍加固"为主，**不涉及业务重写，性价比高**。建议从批次 1 或批次 2 的单点改动切入，即可消除全站最显眼的暗色模式不一致与页头漂移问题。
