# Vue 3 迁移完成度审计报告

> 审计日期：2026-08-17
> 审计对象：`web/`（React 18 源） vs `web-vue/`（Vue 3 目标）
> 方法：逐目录实地扫描 + 行数/文件统计 + 类型检查日志（vue-tsc-full{1,2,3}.log）+ 测试日志（vitest-run.log）+ React 残留/未完成标记精确复核。

---

## 1. 总体结论（量化）

| 维度 | 结论 |
|---|---|
| **实现覆盖度（结构化）** | **≈ 96.9%** —— 全部 16 业务模块、12 页面/路由、19 UI 组件 + 6 图表、23 API、3 状态、路由守卫、共享内核（含 FOUC）均已落地且体量充足 |
| **质量门禁就绪度** | **未达成** —— `vue-tsc` 仍报 **12 处错误**（构建被阻断）；测试**未全绿**（最近一次子集运行 3 失败/9 通过）；`pnpm build` 因类型检查失败而无法通过 |
| **综合迁移完成度** | **≈ 85%** —— 剩余约 15% 全部为「缺陷修复 + 测试补全 + 少量后端缺口」，无新增功能待建 |

> 一句话：**这不是脚手架，而是一份已近乎写完、正在做收尾硬化（typecheck/test 清零）的 Vue 3 移植。** 代码层面迁移已基本完成，卡在质量门禁（构建红、测试部分红）。

---

## 2. 结构化覆盖率评分卡

| 维度 | 权重 | 状态 | 证据 |
|---|---|---|---|
| 业务模块 | 25% | ✅ 100% | `web-vue/src/modules/` 下 16 个模块全部含真实 `.vue`（query 为纯工具模块，无 `.vue` 属正常） |
| 页面/路由 | 12% | ✅ 100% | 路由 12 条 + 404 + `/transactions→/cashflows` 重定向 + 认证守卫；**12 个被引用的页面组件全部存在** |
| UI 组件 | 12% | ✅ 100% | `components/ui/` 19 个（shadcn-vue + reka-ui，含 barrel `index.ts`）；`components/charts/` 6 个（BaseChart + NavTrend/Xirr/Yearly/MonthlyHeatmap + chart-grid.ts） |
| API 层 | 10% | ✅ 100% | `api/` 23 文件与 React 版逐字节复用（框架无关，仅 re-export 路径不变） |
| 状态管理 | 8% | ✅ 100% | 3 个 Pinia store（auth/portfolio/preference）直映 zustand 三库 |
| 图表 | 6% | ✅ 100%（代码）⚠️（类型） | echarts option 逻辑完整平移；但 3 处文件有类型错误（见 §4） |
| 构建/工具链 | 10% | ✅ 100% | `vite 5 + vue-tsc + @vitejs/plugin-vue + tailwind 3 + pnpm generate:api`，完全对齐 §11 推荐栈 |
| 共享内核 | 7% | ✅ 100% | `common/`（EmptyState/PageHeader/UserAvatar/ThemeManager/LoadingSpinner/skeletons）、`layout/`（AppLayout+Sidebar）、`index.html` 防闪内联脚本（此前评审担心的 FOUC 缺口**已修复**） |
| 测试迁移 | 10% | ⚠️ 69% | `web-vue` 34 个测试文件 vs React 49 个（纯逻辑用例 url-query/utils/money/tz/api-client 已移植） |

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

## 4. 质量门禁状态（真实缺陷）

### 4.1 类型检查：❌ 失败（12 处错误，正在收敛 18→14→12）
集中在两类：
- **Echarts option 类型**（3 文件）：`XirrTrendChart.vue`、`TotalAssetTrendChart.vue`、`components/charts/yearly-bar-chart.ts`
  - 症状：`type: 'category'` 被推断为 `string` 不能赋给 `XAXisOption`；`tooltip.formatter` 回调参数类型不匹配。
  - 修复：对 option 对象加 `as const` 或整体 `EChartsOption` 标注 / 用 `echarts` 提供的 `ComposeOption` 类型助手。
- **SnapshotForm.vue**（多处）：
  - `toTypedSchema` 应为 `zodToTypedSchema`（导出名不符，编译已提示）；
  - 多个字段值 `unknown` 未收窄导致赋值报错。

> 影响：`package.json` 的 `build`/`lint` 脚本首步即 `vue-tsc --noEmit`，故**当前 `pnpm build` 无法成功**，应用虽代码完整却不可构建。

### 4.2 测试：⚠️ 未全绿
最近一次 `vitest-run.log`（3 个测试文件子集）显示 **3 失败 / 9 通过（12 例）**，失败集中在：
- `portfolio-dialog.test.ts`：提交成功后 `createPortfolio` 未被调用（表单提交接线/emit 逻辑回归）；
- `register-form.test.ts`：校验文案断言（`名称最多 50 字` 等）不匹配（可能是文案或 zod 消息迁移差异）；
- `snapshot-form.test.ts`：字段类型/提交用例失败。
完整 34 文件套件尚未跑通全绿。

### 4.3 构建：❌ 受阻
由 4.1 直接导致；vite 产物无法生成。

---

## 5. 遗留问题 / 未迁移模块

**已确认无「整模块未迁移」** —— 16 个业务模块均有实质实现。仅以下局部缺口：

| 项 | 类型 | 说明 | 严重度 |
|---|---|---|---|
| 后端导出接口未实现 | 功能缺口（非 Vue 失败） | `SnapshotsPage` 的 **Gap D**：导出按钮作占位禁用（SET-P0-03 同口径，后端端点未就绪） | 中（前端已正确降级） |
| `holdings/trade-security-filter.ts` 过时注释 | 文档噪音 | 注释称「security-trade 模块尚未迁移（后续批次）」，但 `SecurityTradeForm.vue`（651 行）**实际已迁移** | 低（误导向，无害） |
| React 残留 import | **无** | 6 处「命中」全部位于注释（如"zustand→pinia 逐行等价"），**零真实 React 运行时依赖** | — |
| 未完成标记 | 误报为主 | 9 处「命中」多为「骨架屏/skeleton」组件名与「版面骨架」布局注释，均为真实组件 | — |
| 测试 15 文件未移植 | 覆盖缺口 | 49→34，剩余多为组件级用例 | 低–中（回归保障不足） |

---

## 6. 与评审方案（§11/§12）的偏差

- 评审担心的 **FOUC 防闪、ThemeManager、共享内核** —— **实际已落地**，比方案预期更完整。
- 评审建议的 **vue-draggable-plus** —— 已采用（`package.json` 含 `vue-draggable-plus@^0.5.0`），admin 拖拽排序已实现（`reorder.test.ts` 存在）。
- 评审建议的 **pnpm / Tailwind 3 锁定 / vue-tsc 验收** —— 已全部落实（与方案 §10 已确认决策一致）。
- 评审担忧的 **B3-B16 全并行冲突** —— 实际执行未严格按批次，而是以 `modules/*` 为单元整体推进，反而规避了方案担心的共享模块冲突。

---

## 7. 下一步建议（量化剩余工作量）

| 动作 | 工作量估算 | 优先级 |
|---|---|---|
| 修复 12 处 `vue-tsc` 错误（echarts 类型标注 + SnapshotForm `zodToTypedSchema`/字段收窄） | 0.5–1 人天 | P0（解锁构建） |
| 跑通全量 34 测试文件并清零失败用例（portfolio/register/snapshot 表单接线与文案） | 1–1.5 人天 | P0 |
| 移植剩余 ~15 个 React 测试文件（补齐回归覆盖） | 1–2 人天 | P1 |
| 清理 `trade-security-filter.ts` 过时注释 + 复核 Gap D 后端进度 | 0.25 人天 | P2 |
| 双栈并排 + Playwright 冒烟（按 §12 功能矩阵验收） | 1–2 人天 | P1 |
| **合计收尾** | **约 4.75–7.75 人天** | 进入可交付前最后硬化阶段 |

---

## 8. 结论重申

- **代码/结构迁移实现度 ≈ 96.9%**：所有模块、页面、组件、API、状态、路由、主题、构建链均已落地，体量对等 React，无真实 React 残留。
- **质量门禁未达成**：构建红（12 类型错误）、测试部分红，导致当前不可交付。
- **综合迁移完成度 ≈ 85%**，剩余约 15% 为缺陷修复与测试补全，无新增功能待建。建议优先清零类型错误与失败测试（约 1.5–2.5 人天）以解锁构建，随后补齐测试与功能矩阵验收。
