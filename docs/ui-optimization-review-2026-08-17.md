# Web 前端全方位优化审查报告（2026-08-17）

> 范围：`web/src` 全部展示层代码（布局 / 文案 / 样式）+ 逻辑层抽查。
> 原则：**严格保持所有现有功能不变**。审查仅产出建议与书面改动方案；任何改动须经你确认后执行。
> 方法：先经 MCP 代码图谱定位结构，再并行子代理初审，最后逐条人工核验（子代理结论与代码不符处已更正）。

---

## 0. 结论摘要

- **未发现确凿 BUG**：被自动审查标为“潜在 BUG”的若干项（如 `formatCurrency` 未防 NaN、`auth-guard` 死循环、主题 token 缺失）经人工核验均为**误报**，现有代码已正确处理。见 §3 更正说明。
- **主要问题是展示层的一致性与体验问题**：错误提示色硬编码、系统名/术语不统一、无组合空态文案三套说法、页面标题实现方式两套并存、超宽屏下内容拉伸。
- 全部发现均为**展示层改动**（HTML / TSX 模板 / 文案 / CSS），**不涉及 hooks、API、store、后端逻辑**；故均可按你已授权范围直接优化，但为稳妥仍列出方案，供你勾选后执行。

---

## 1. 发现清单（按严重度分级，均已人工核验）

### 高：一致性与可维护性

| # | 位置 | 现状 | 问题 | 建议 |
|---|------|------|------|------|
| H1 | 全站约 30+ 处，如 [login-form.tsx](file:///d:/sync/obsidian_wiki/w_wiki/04_Projects/AI%20Coding/investment_return_tracker/web/src/features/auth/login-form.tsx#L122-L136)、[register-form.tsx](file:///d:/sync/obsidian_wiki/w_wiki/04_Projects/AI%20Coding/investment_return_tracker/web/src/features/auth/register-form.tsx#L77-L102)、各类 dialog / form | 表单校验错误提示全部硬编码 `text-red-500` | 绕过设计 token `--destructive`；暗色主题下 red-500 对比度不足、不随主题变化；theme 切换后错误色不联动 | 统一改为 `text-destructive`（shadcn token，index.css 已定义 `--destructive`） |
| H2 | [app-layout.tsx](file:///d:/sync/obsidian_wiki/w_wiki/04_Projects/AI%20Coding/investment_return_tracker/web/src/components/layout/app-layout.tsx#L87) vs [index.html](file:///d:/sync/obsidian_wiki/w_wiki/04_Projects/AI%20Coding/investment_return_tracker/web/index.html#L8) vs 登录页 | 顶栏「投资收益统计」、页面 title「投资收益统计系统」、登录/注册标题「投资收益统计系统 - 登录」 | 同一系统名三处不一致 | 统一为「投资收益统计系统」，顶栏同步；抽一个 `APP_NAME` 常量 |

### 中：术语与文案统一

| # | 位置 | 现状 | 问题 | 建议 |
|---|------|------|------|------|
| M1 | 侧边栏「资产记录」vs [snapshots.tsx](file:///d:/sync/obsidian_wiki/w_wiki/04_Projects/AI%20Coding/investment_return_tracker/web/src/pages/snapshots.tsx#L74)「历史总资产记录」vs `snapshot-list` / `snapshot-form` / [constants.ts](file:///d:/sync/obsidian_wiki/w_wiki/04_Projects/AI%20Coding/investment_return_tracker/web/src/lib/constants.ts#L74)「资产快照」 | 同一业务对象三种叫法：资产记录 / 历史总资产记录 / 资产快照 | 用户混淆；侧边栏入口与页面内部不同名 | 统一主术语（建议「资产快照」或「资产记录」择一），全站同步 |
| M2 | 侧边栏「出入金」、页签「出入金流水」、`cashflow-list`「出入金流水」、[constants.ts](file:///d:/sync/obsidian_wiki/w_wiki/04_Projects/AI%20Coding/investment_return_tracker/web/src/lib/constants.ts#L71)「出入金流水」、`transactions` 页「出入金管理」 | 「出入金 / 现金流 / 交易记录」混用 | 业务术语未统一 | 确认主术语（建议「出入金」系列），排除「现金流」/「交易记录」 |
| M3 | 无组合空态：[dashboard.tsx](file:///d:/sync/obsidian_wiki/w_wiki/04_Projects/AI%20Coding/investment_return_tracker/web/src/pages/dashboard.tsx#L418-L424)「欢迎，先创建您的第一个投资组合」vs [transactions.tsx](file:///d:/sync/obsidian_wiki/w_wiki/04_Projects/AI%20Coding/investment_return_tracker/web/src/pages/transactions.tsx#L243-L250)「暂无投资组合…」vs snapshots「请先选择一个投资组合」 | 同一场景三套文案 | 文案不统一、引导力度不一 | 统一为带行动指引的空态组件（复用 EmptyState） |
| M4 | 标题实现：[dashboard.tsx](file:///d:/sync/obsidian_wiki/w_wiki/04_Projects/AI%20Coding/investment_return_tracker/web/src/pages/dashboard.tsx#L490-L520) 用 `PageHeader` 组件 vs transactions / snapshots / settings 手写 `<h1 className="text-2xl font-bold tracking-tight">` | 两套页面标题实现 | 视觉与维护不统一 | 全站统一用 `PageHeader` 组件 |

### 低：布局与细节

| #   | 位置                                                                                                                                                                                                              | 现状                                       | 问题                                       | 建议                                                               |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------- | ---------------------------------------- | ---------------------------------------------------------------- |
| L1  | [app-layout.tsx](file:///d:/sync/obsidian_wiki/w_wiki/04_Projects/AI%20Coding/investment_return_tracker/web/src/components/layout/app-layout.tsx#L170) `<main className="flex-1 overflow-x-hidden p-4 md:p-6">` | 内容区无最大宽度约束                               | ≥1600px 宽屏下内容被拉满，指标卡过宽、行宽过大影响阅读          | 内容区加 `mx-auto w-full max-w-[1400px]`（对齐 tailwind `container` 配置） |
| L2  | [dashboard.tsx](file:///d:/sync/obsidian_wiki/w_wiki/04_Projects/AI%20Coding/investment_return_tracker/web/src/pages/dashboard.tsx#L118) `METRIC_GRID_CLASS`                                                    | `md:grid-cols-4` 但无 max-w                | 超宽屏下 4 列卡片每张极宽                           | 结合 L1 的容器限宽即可缓解                                                  |
| L3  | [dashboard.tsx](file:///d:/sync/obsidian_wiki/w_wiki/04_Projects/AI%20Coding/investment_return_tracker/web/src/pages/dashboard.tsx#L646-L652)                                                                   | 「查看全部」硬编码 `to="/cashflows"`              | 未用 `ROUTE_PATH.TRANSACTIONS` 常量          | 改用路由常量                                                           |
| L4  | [stat-card.tsx](file:///d:/sync/obsidian_wiki/w_wiki/04_Projects/AI%20Coding/investment_return_tracker/web/src/components/charts/stat-card.tsx#L52-L53)                                                         | 数值 `text-2xl font-bold`，无 `tabular-nums` | 数字宽度随字符变化、加载后跳动；大额可能溢出（团队已知，已用移动端单列规避）   | 加 `tabular-nums`，金额列考虑 `break-all`/`text-balance`                |
| L5  | [app-layout.tsx](file:///d:/sync/obsidian_wiki/w_wiki/04_Projects/AI%20Coding/investment_return_tracker/web/src/components/layout/app-layout.tsx#L38-L58) `BaselineClock`                                       | 每秒 `setState`                            | 低频重渲仅影响该 span，可接受；但每秒 interval 在后台标签页仍运行 | 可考虑降频到 1s 仅当可见时，或保持现状（低优先）                                       |
| L6  | [not-found.tsx](file:///d:/sync/obsidian_wiki/w_wiki/04_Projects/AI%20Coding/investment_return_tracker/web/src/pages/not-found.tsx)                                                                             | 404 页独立于 AppLayout，无侧边栏                  | 孤立页无可达导航（仅「返回首页」）                        | 可加「返回首页 / 回到持仓」双入口（可选）                                           |
| L7  | [snapshots.tsx](file:///d:/sync/obsidian_wiki/w_wiki/04_Projects/AI%20Coding/investment_return_tracker/web/src/pages/snapshots.tsx#L75-L79)                                                                     | 页面副文案含 emoji（🤖 / ✋ / ⓘ）                 | 与编码规范「禁止 emoji」冲突（虽在 UI 文案）              | 改用文字徽标或图标组件，去掉 emoji 字符                                          |

---

## 2. 非展示层改动方案（本次**不动**，仅书面列出，供你评估）

以下为需谨慎确认的**非展示层**建议（hooks / 逻辑 / 配置），默认不执行：

| # | 位置 | 建议 | 风险 |
|---|------|------|------|
| N1 | [use-query-data.ts](file:///d:/sync/obsidian_wiki/w_wiki/04_Projects/AI%20Coding/investment_return_tracker/web/src/hooks/use-query-data.ts) 等 hooks | queryKey 补齐缺失依赖项（自动审查疑点，人工核验未复现错误） | 改动 queryKey 会触发缓存失效，需回归测试 |
| N2 | QueryClient `refetchOnWindowFocus: false`（[App.tsx](file:///d:/sync/obsidian_wiki/w_wiki/04_Projects/AI%20Coding/investment_return_tracker/web/src/App.tsx#L59-L67)） | 是否开启窗口聚焦自动刷新以提升数据新鲜度 | 可能频繁请求，需结合 staleTime 权衡 |
| N3 | 打包性能 | ECharts 全量引入（`echarts` + `echarts-for-react`），可评估按需引入 | 收益依赖实际包体积，需基线测量 |

以上三项**不在本次优化范围**，如需要我再单独出方案。

---

## 3. 自动审查误报更正（重要：避免误改）

以下子代理/自动审查结论与代码不符，**已人工核验为正常，请勿按此修改**：

- `formatCurrency`/`formatPercent`/`formatDecimal`：已对 `NaN`/`Infinity`/`null`/空串做兜底（[utils.ts](file:///d:/sync/obsidian_wiki/w_wiki/04_Projects/AI%20Coding/investment_return_tracker/web/src/lib/utils.ts#L72-L136)），非缺陷。
- `auth-guard`：登录意图记录 + 重定向逻辑正确，无死循环（[auth-guard.tsx](file:///d:/sync/obsidian_wiki/w_wiki/04_Projects/AI%20Coding/investment_return_tracker/web/src/components/auth-guard.tsx)）。
- 设计 token：`--background/foreground/primary/destructive…` 明暗两套齐全（[index.css](file:///d:/sync/obsidian_wiki/w_wiki/04_Projects/AI%20Coding/investment_return_tracker/web/src/index.css#L11-L83)），且 A 股「正红负绿」`--color-up/--color-down` 已定义，无需补。
- `theme-manager` / index.html 内联脚本：主题预置与 `prefers-color-scheme` 监听逻辑正确，无闪烁问题。

---

## 4. 建议执行顺序

1. **H1**（错误色 token 化）——收益最高、改动机械。
2. **H2 + M1 + M2 + M3**（系统名 / 业务术语 / 空态文案统一）——涉及文案字典化。
3. **M4 + L1 + L2**（标题组件统一 + 内容区限宽）——视觉收敛。
4. **L3/L4/L6/L7** 细节打磨。

如需按此执行，请回复确认（可指定只做其中几项）；我会逐项实施并保证功能不变。

---

*演示页面：见同目录 `ui-optimization-preview-2026-08-17.html`（优化前 vs 优化后对比效果）。*
