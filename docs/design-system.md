# 设计系统规范（design-system）

> 本文是前端 UI 的**单一事实源**参考，沉淀自 `ui-design-review.md` 的批量落地（批次 1–8）。
> 范围：`web/`（Vue 3 + shadcn-vue/reka-ui + Tailwind 3 + ECharts）。
> 作用：组件用法矩阵、间距/字号标尺、暗色模式契约、图表主题桥约定、表格响应式规范。
> 约定：本文描述的是**已实现并落地**的规范，新增组件/用法须对齐此处，避免漂移。

---

## 1. 设计 token

### 1.1 颜色地基（`src/index.css`）

| Token | 用途 | 明暗 |
|---|---|---|
| `--background` / `--foreground` | 页面底 / 主文字 | 双主题 |
| `--card` / `--card-foreground` | 卡片底 / 卡内文字 | 双主题 |
| `--muted` / `--muted-foreground` | 次级底 / 次级文字（说明、占位） | 双主题 |
| `--border` / `--input` / `--ring` | 边框 / 输入边框 / 焦点环 | 双主题 |
| `--primary` / `--primary-foreground` | 主色（近黑中性，按钮/强调） | 双主题 |
| `--secondary` / `--accent` | 次级底 / 悬浮底 | 双主题 |
| `--destructive` / `--destructive-foreground` | 危险操作（删除） | 双主题 |
| `--popover` / `--popover-foreground` | 浮层底 | 双主题 |
| `--color-up` / `--color-down` | **A 股涨跌配色：红涨 / 绿跌**（PRD §9.5） | 双主题 |
| `--color-up-soft` / `--color-down-soft` | 涨跌浅底变体 | 双主题 |
| `--chart-line` | 图表主视觉线（品牌 mark 渐变复用） | 双主题 |
| `--space-section` | **分区间距标尺** = `1.5rem`（`space-y-6`） | 明暗同值 |

- 颜色全部用 HSL 分量变量，使用处 `hsl(var(--xxx))`。
- 明暗切换由 `<html>.dark` class 驱动（`ThemeManager.vue` 用 `classList.toggle`）。
- **涨跌双通道**：色 + 符号（`+`/`-`）同时呈现，禁止仅靠颜色编码（P3-2）。

### 1.2 图表语义 token（JS↔CSS 桥）

图表颜色**不硬编码 hex**，运行时从 CSS 变量读取（见 §4）：

| 桥字段 | 来源 CSS 变量 |
|---|---|
| `grid` / `axis` | `--border` / `--muted-foreground` |
| `up` / `down` | `--color-up` / `--color-down` |
| `line` | `--chart-line` |

---

## 2. 组件用法矩阵

### 2.1 页面结构

| 组件 | 签名 | 用途 | 禁止 |
|---|---|---|---|
| `PageHeader` | `{ title, description?, actions? }` | 全站 13 页页头 | 裸 `<h1>` 写页头；description 写成长段 |
| `MetricCard` | `{ label, value, trend?, description?, valueClassName? }` | "一个关键数字 + 标签"聚合卡 | 用裸 `<Card>` 内联块拼数字卡（P0-2） |
| `ErrorState` | `{ title, description?, #action }` | 统一错误态（`role="alert"`） | 每页手写错误卡片（P2-2） |
| `EmptyState` | `{ title, description?, #icon, #action }` | 空态引导 | — |
| `HelpTip` | `{ text?, #content }` | 默认收起图标气泡，收长说明 | 散落 `<p class="text-xs">` 长说明（P1-3） |

### 2.2 文字层级标尺（强制）

| 层级 | 类 / 组件 | 字号 |
|---|---|---|
| 页面 H1 | `PageHeader` 内 `h1` | `text-2xl font-bold tracking-tight` |
| 区块标题 | `CardTitle`（仅区块） | `text-base font-semibold` |
| 数值 hero（页面级 1–2 大数，如 XIRR） | `MetricCard` hero 风格 | `text-3xl` |
| 数值 metric（并列多卡） | `MetricCard` / `StatCard` | `text-2xl` |
| 数值 cell（表格单元格） | `tabular-nums font-mono` | `text-sm` |
| 说明三级 | — | 页头描述 `text-sm` / 卡描述 `text-sm` / 行内提示 `text-xs`（统一 `muted-foreground`） |

> ⚠️ `CardTitle` **仅做区块标题**，不要把 `text-3xl` 数值直接放进 `CardTitle`（P1-7：读屏会把数值读作标题）。

### 2.3 间距标尺（强制）

| 场景 | 规范 |
|---|---|
| 页面分区 | `space-y-6`（= `--space-section` 1.5rem），统一节奏（P1-1） |
| 卡片内 padding | `p-4` / `p-5` |
| 行内字段 | `space-y-2` |
| 聚合卡网格 | `grid-cols-2 sm:grid-cols-3 lg:grid-cols-5`（治 md 段 2+2+1 末位孤立，P1-4） |

---

## 3. 品牌识别

- 顶栏（`AppLayout.vue`）含品牌 mark：渐变方块（`from-chart-line to-primary`）+ 中心圆点，**复用现有 token，不引新品牌色**，自动跟随明暗。
- 登录/注册页：`APP_NAME` 降级为 logo 区小字，`<h1>` 为动作标题（"登录"/"注册"），建立"品牌 → 动作"层级（批次 7，已落地）。

---

## 4. 图表主题桥约定（P0-1）

- 所有图表经 `BaseChart.vue` 渲染（vue-echarts 封装，按需注册 line/bar/heatmap/scatter）。
- 颜色由 `src/lib/chart-theme.ts` 的 `getChartTheme()` 在运行时从 `getComputedStyle(documentElement)` 读取 CSS 变量，**废除一切硬编码 hex**。
- 响应式主题：`useChartTheme()` 用 `MutationObserver` 监听 `.dark` class，主题切换时重算 option，暗色模式自动跟随。
- 业务图表组件（XirrTrendChart / NavTrendChart / YearlyBarChart / MonthlyHeatmap）在 `setup` 顶层调用 `useChartTheme()` 建立响应式依赖，把 `theme` 传入纯函数（`*-chart.ts`）。

### 4.1 图表无障碍（P3-1，已落地）

`BaseChart` 外层包 `<figure role="img" :aria-label>` + `<figcaption class="sr-only">` 数据摘要：

- 每个业务图表组件计算 `chartSummary`（首末点 / 最新值 / 最佳最差月等），传 `:summary`。
- `aria-label` 取图表 `title`。
- 禁止依赖 canvas 视觉传达关键信息——读屏用户靠 `sr-only` 摘要获取数值结论。

---

## 5. 表格响应式规范（P2-1）

- **内联 `<Table>` 的密集表**（持仓 11 列 / NAV 每日明细 6 列 / 日志中心列表）：容器 `overflow-x-auto`，**首列 `sticky left-0 z-10 bg-background` 冻结**，移动端横滑不丢失锚点（批次 6，已落地）。
- 冻结列须带 `bg-background`，否则横滑时透出后方内容。
- 子组件列表（SnapshotList / CashflowList / CashBalanceHistory / SecurityTradeList / DividendList）首列已落地 `sticky left-0 z-10 bg-background` 冻结（日期/生效日/标的锚点列），移动降级以首列冻结为准，不重写为卡片以避免破坏排序/编辑交互。
- 表格数字列统一 `tabular-nums font-mono`；涨跌列用 `text-up`/`text-down` 双通道。

---

## 6. 落地状态

| 批次 | 内容 | 状态 |
|---|---|---|
| 1 | 图表主题桥 `chart-theme.ts` + 废除硬编码 hex | ✅ |
| 2 | `PageHeader` 全站化 + 文字/间距标尺 | ✅ |
| 3 | `MetricCard` 收敛 + `ErrorState` 统一 | ✅ |
| 4 | `HelpTip` 收长说明 | ✅ |
| 5 | 品牌 mark + `--space-section` 标尺 | ✅ |
| 6 | 表格首列冻结（Holdings/NAV/LogCenter + 5 子组件列表） | ✅ |
| 7 | Login/Register 标题纠正（品牌→动作） | ✅（并入批次 2） |
| 8 | 图表 a11y + 本文档 | ✅ |

---

## 7. 反漂移清单（新增 UI 须自查）

1. 新颜色是否走了 token？图表是否 import `useChartTheme()`？
2. 新数字卡是否用 `MetricCard`？有没有把数值塞进 `CardTitle`？
3. 新页头是否用 `PageHeader`？description 是否 ≤ 1 句？
4. 长说明是否收进 `HelpTip`？
5. 密集表格首列是否 `sticky left-0 bg-background`？
6. 图表是否传 `aria-label` + `summary`？
7. 间距是否用 `--space-section` / `space-y-6`？
