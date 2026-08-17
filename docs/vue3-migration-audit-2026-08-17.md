# Vue 3 迁移完成度审计报告

> 审计日期：2026-08-17
> 审计对象：`web/`（React 18 源） vs `web-vue/`（Vue 3 目标）
> 方法：逐目录实地扫描 + 行数/文件统计 + 类型检查日志（vue-tsc-full{1,2,3}.log）+ 测试日志（vitest-run.log）+ React 残留/未完成标记精确复核。
> **二次实测（2026-08-17 21:30）**：前述日志为早期快照，已过时。重新直接运行质量门禁得到相反结论——`vue-tsc` **0 错误**、`vitest run` **34 文件 / 263 例全绿**、`vite build` **成功**。本节结论据此下调风险、上调完成度。

---

## 1. 总体结论（量化）

| 维度 | 结论 |
|---|---|
| **实现覆盖度（结构化）** | **≈ 96.9%** —— 全部 16 业务模块、12 页面/路由、19 UI 组件 + 6 图表、23 API、3 状态、路由守卫、共享内核（含 FOUC）均已落地且体量充足 |
| **质量门禁就绪度** | **✅ 已达成** —— 二次实测 `vue-tsc --noEmit` **0 错误**；`vitest run` **34 文件 / 263 例全绿**；`pnpm build`（vue-tsc + vite build）**成功生成 dist**（仅 AdminPage 882KB chunk 体积告警，非阻断） |
| **综合迁移完成度** | **≈ 92%** —— 代码迁移 100% 落地且可构建可运行，质量门禁全绿；剩余约 8% 为「回归覆盖补强 + 验收未启动 + 1 处后端依赖缺口 + 构建体积优化」 |

> 一句话：**这不是脚手架，而是一份已写完、质量门禁全绿、可直接构建部署的 Vue 3 移植。** 早期日志显示的「类型/测试红」已成历史，二次实测确认构建与测试均通过。

---

## 2. 结构化覆盖率评分卡

| 维度 | 权重 | 状态 | 证据 |
|---|---|---|---|
| 业务模块 | 25% | ✅ 100% | `web-vue/src/modules/` 下 16 个模块全部含真实 `.vue`（query 为纯工具模块，无 `.vue` 属正常） |
| 页面/路由 | 12% | ✅ 100% | 路由 12 条 + 404 + `/transactions→/cashflows` 重定向 + 认证守卫；**12 个被引用的页面组件全部存在** |
| UI 组件 | 12% | ✅ 100% | `components/ui/` 19 个（shadcn-vue + reka-ui，含 barrel `index.ts`）；`components/charts/` 6 个（BaseChart + NavTrend/Xirr/Yearly/MonthlyHeatmap + chart-grid.ts） |
| API 层 | 10% | ✅ 100% | `api/` 23 文件与 React 版逐字节复用（框架无关，仅 re-export 路径不变） |
| 状态管理 | 8% | ✅ 100% | 3 个 Pinia store（auth/portfolio/preference）直映 zustand 三库 |
| 图表 | 6% | ✅ 100% | echarts option 逻辑完整平移；早期 3 处类型错误已清零（二次实测 `vue-tsc` 0 错误） |
| 构建/工具链 | 10% | ✅ 100% | `vite 5 + vue-tsc + @vitejs/plugin-vue + tailwind 3 + pnpm generate:api`，完全对齐 §11 推荐栈 |
| 共享内核 | 7% | ✅ 100% | `common/`（EmptyState/PageHeader/UserAvatar/ThemeManager/LoadingSpinner/skeletons）、`layout/`（AppLayout+Sidebar）、`index.html` 防闪内联脚本（此前评审担心的 FOUC 缺口**已修复**） |
| 测试迁移 | 10% | ⚠️ 69%（文件）/ ✅ 100%（通过） | `web-vue` 34 个测试文件 vs React 49 个；**已有 263 例全部通过**，核心表单/页面行为已覆盖。剩余 ~15 个 React 测试文件未移植（多为组件级用例，部分可能冗余） |

**实现覆盖度 = 0.25+0.12+0.12+0.10+0.08+0.06+0.10+0.07+0.10×0.69 = 0.969 → 96.9%**

---

## 3. 规模对比（真实数据）

| 指标 | web (React) | web-vue (Vue3) | 说明 |
|---|---|---|---|
| 非测试源文件 | 151 | 247 | Vue 单文件组件 + barrel 拆分，文件更多属正常 |
| 总行数 | 26,291 | 26,301 | 体量对等，非空壳 |
| 业务模块行数 | features 10,611 | modules 17,290 | Vue SFC 含模板更冗长；且含页面/组件/组合式全量 |
| 页面 `.vue/.tsx` | 12 | 12（路由引用） | + 各模块 `pages/` 子目录 |
| UI 组件 | 19 + 6 图表 | 19 + 6 图表 | 一一对应 |
| 状态 | 3 zustand | 3 pinia | 直映 |
| hooks→composables | 22 扁平 hooks | 4 扁平 + 各模块 `composables/` | **重组而非丢失**：逻辑下沉到模块作用域（如 `modules/holdings/composables/use-holdings.ts`、`modules/auth/composables/use-auth.ts`） |
| 测试文件 | 49 | 34 | 约 69% 已移植 |

---

## 4. 质量门禁状态（二次实测，已全绿）

> 本节结论与首次审计的 §4（基于早期 `vue-tsc-full*.log` / `vitest-run.log` 快照）**相反**：早期日志已过时，2026-08-17 21:30 重新直接运行门禁确认全部通过。

### 4.1 类型检查：✅ 通过（0 错误）
- 命令：`vue-tsc --noEmit -p tsconfig.app.json`
- 结果：**EXIT=0，0 处 `error TS`**。早期报告的 echarts option 类型（XirrTrendChart/TotalAssetTrendChart/yearly-bar-chart）与 SnapshotForm（`zodToTypedSchema`/字段收窄）错误**均已修复**。

### 4.2 测试：✅ 全绿
- 命令：`vitest run`
- 结果：**34 个测试文件 / 263 个用例全部通过（0 失败）**，耗时约 49s。覆盖核心表单（login/register/cashflow/security-trade/dividend/snapshot/account/profile/email/password）、页面（dashboard/holdings/settings/admin/xirr/snapshot/nav/cash-balance/data-transfer）、图表（chart-grid/chart-options）、工具（url-query/utils/money/tz/api-client/query-params）、拖拽（reorder）等。

### 4.3 构建：✅ 通过
- 命令：`vite build`（在 `vue-tsc` 通过后）
- 结果：**`✓ built in 21.96s`，EXIT=0**，dist 产物正常生成。唯一提示为 AdminPage chunk 882KB（>500KB 阈值）的体积告警，属优化项非阻断。

> 结论：`pnpm build` 当前可成功执行，**应用已可构建部署**。首次审计"构建红、测试部分红"的判定因依赖过期日志而偏高估风险。

---

## 5. 遗留问题 / 未迁移模块

**已确认无「整模块未迁移」** —— 16 个业务模块均有实质实现。早期报告的类型/测试缺陷**均已解决**；仅以下局部缺口：

| 项 | 类型 | 说明 | 严重度 | 状态 |
|---|---|---|---|---|
| `vue-tsc` 12 处类型错误 | 缺陷（已修复） | echarts option 类型 + SnapshotForm `zodToTypedSchema`/字段收窄 | — | ✅ 二次实测 0 错误 |
| 测试 3 失败用例 | 缺陷（已修复） | portfolio 提交接线 / register 文案 / snapshot 表单 | — | ✅ 二次实测 263 例全绿 |
| 后端导出接口未实现 | 功能缺口（非 Vue 失败） | `SnapshotsPage` 的 **Gap D**：导出按钮作占位禁用（SET-P0-03 同口径，后端端点未就绪） | 中（前端已正确降级） | ⏸ 待后端，前端已降级 |
| `holdings/trade-security-filter.ts` 过时注释 | 文档噪音 | 注释曾称「security-trade 模块尚未迁移」，但 `SecurityTradeForm.vue`（651 行）**实际已迁移** | 低 | ✅ 本次已修正注释 |
| React 残留 import | **无** | 6 处「命中」全部位于注释（如"zustand→pinia 逐行等价"），**零真实 React 运行时依赖** | — | ✅ 确认干净 |
| 未完成标记 | 噪音 | 9 处「命中」多为「骨架屏/skeleton」组件名与「版面骨架」布局注释，均为真实组件 | — | ✅ 误报 |
| 测试 ~15 文件未移植 | 覆盖缺口 | 49→34，剩余多为组件级用例（部分可能与已通过 263 例重复） | 低–中 | ⏳ 待补强 |
| AdminPage chunk 882KB | 构建体积 | vite build 告警（>500KB 阈值），非阻断 | 低 | ⏳ 可后续 `manualChunks` 优化 |

---

## 6. 与评审方案（§11/§12）的偏差

- 评审担心的 **FOUC 防闪、ThemeManager、共享内核** —— **实际已落地**，比方案预期更完整。
- 评审建议的 **vue-draggable-plus** —— 已采用（`package.json` 含 `vue-draggable-plus@^0.5.0`），admin 拖拽排序已实现（`reorder.test.ts` 存在）。
- 评审建议的 **pnpm / Tailwind 3 锁定 / vue-tsc 验收** —— 已全部落实（与方案 §10 已确认决策一致）。
- 评审担忧的 **B3-B16 全并行冲突** —— 实际执行未严格按批次，而是以 `modules/*` 为单元整体推进，反而规避了方案担心的共享模块冲突。

---

## 7. 下一步建议（量化剩余工作量）

> 早期报告中的 **P0 解锁构建项（类型错误 + 失败测试）已实际完成**，不再计入。剩余收尾以下列为主：

| 动作 | 工作量估算 | 优先级 | 状态 |
|---|---|---|---|
| 修复 12 处 `vue-tsc` 错误 | 0.5–1 人天 | P0（解锁构建） | ✅ 已完成（实测 0 错误） |
| 跑通全量测试并清零失败 | 1–1.5 人天 | P0 | ✅ 已完成（263 例全绿） |
| 移植剩余 ~15 个 React 测试文件（补齐回归覆盖） | 1–2 人天 | P1 | ⏳ 待办 |
| 双栈并排 + Playwright 冒烟（按 §12 功能矩阵验收） | 1–2 人天 | P1 | ⏳ 待办 |
| 清理 `trade-security-filter.ts` 过时注释 | 0.25 人天 | P2 | ✅ 本次已修正 |
| AdminPage chunk 体积优化（`manualChunks`） | 0.5 人天 | P3 | ⏳ 可选 |
| **合计剩余收尾** | **约 2.5–4.5 人天** | 仅剩验证增强与可选优化，无阻塞交付项 | |

---

## 8. 结论重申

- **代码/结构迁移实现度 ≈ 96.9%**：所有模块、页面、组件、API、状态、路由、主题、构建链均已落地，体量对等 React，无真实 React 残留。
- **质量门禁已达成**：二次实测 `vue-tsc` 0 错误、`vitest` 263 例全绿、`vite build` 成功——**应用已可构建部署**。早期"构建红、测试部分红"源于过期日志快照，非当前真实状态。
- **综合迁移完成度 ≈ 92%**：代码迁移 100% 落地且门禁全绿；剩余约 8% 为回归覆盖补强（~15 测试文件）、功能矩阵 Playwright 验收（未启动）、1 处后端依赖缺口（Snapshots 导出，前端已降级）、构建体积优化（可选）。建议下一步进入验收阶段（双栈并排 + 功能矩阵勾验），而非继续"修补缺陷"。
