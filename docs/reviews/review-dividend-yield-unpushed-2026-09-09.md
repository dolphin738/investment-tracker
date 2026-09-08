# 代码审查报告 · 股息率排名页改版（未推送序列）（2026-09-09）

> 审查标准：对齐 `docs/代码审查标准与流程.md`（10 章）。本报告按 §7 模板产出，证据链全部带 `file:line`。
> 角色：QA（CodeReviewExpert）。范围：当前 `cnb/main..HEAD` 中 8 笔功能性提交（排除 `chore(index)` 索引快照与标准文档自身）。

---

## TL;DR

- **范围**：股息率排名页「股息价格推算」重构链（`588de97`→`d7c38c8`），7 个文件 +586/−189。
- **结论**：发现 **P1×2、M×3、L×3**；**不符合 §9「零 P0/P1 未决」合入门槛**，建议 owner 打回，先修 P1 再合入。
- **最严重项**：`588de97` 重写 `SecurityDetailPanel.vue` 时**回归了已合入的 P1 配色修复**（`hsl(var(--primary))` 硬编码回潮），并导致 c5b0a9e 抽出的 `buildDividendYieldCurveOption` 纯函数 + 其单测**沦为死代码 / 假绿测试**。
- **后端 `q` 过滤稳健**；**前端新增 347 行推算器 + 232 行榜单页零测试**（违反 §5「改源码未覆盖风险路径」）。
- **需求一致性 ✓**：文档 §1/§9/§10.1/§10.2 均已对齐当前实现，无 `/search` 端点残留。

---

## 审查范围与提交清单

| 提交 | 类型 | 主题 |
|---|---|---|
| `588de97` | feat | 反推价格迁出曲线面板，独立为排名页 Tab 并按模板丰富（新增 `ImpliedPriceCalculator.vue` 347 行） |
| `5b7b4a5` | refactor | 榜单 Tab 恢复改版前界面布局 |
| `a59bc34` | refactor | 「反推价格」改名「股息价格推算」 |
| `5ca9314` | feat | 股息价格推算改搜索式选股（同持仓页） |
| `ffeb3e4` | fix | 股息价格推算恢复原功能设计，仅选股交互改搜索式 |
| `4e06b4d` | feat | 榜单接口支持 q 关键字过滤（router.py +11） |
| `d876a15` | feat | 榜单筛选条新增搜索股票筛选器（前端防抖 250ms） |
| `d7c38c8` | docs | 同步排名页改版至管理方案 §1/§9/§10 |

**改动文件（stat）**：`backend/.../router.py`(+11)、`docs/股息率排名管理方案.md`(+40)、`web/.../api/dividend-yield.api.ts`(+2)、`web/.../components/ImpliedPriceCalculator.vue`(**+347 新增**)、`web/.../components/SecurityDetailPanel.vue`(−142 改写)、`web/.../composables/use-dividend-yield.ts`(+1)、`web/.../pages/RankingPage.vue`(**+232 改写**)。

> 注：diff 中**无任何测试文件**——这是 §5 清单红灯项。

---

## 维度核查（§3 七维度）

| 维度    | 结论        | 关键证据                                                                                                 |
| ----- | --------- | ---------------------------------------------------------------------------------------------------- |
| 正确性   | ⚠️ 回归     | 曲线图配色回退为硬编码 `hsl(var(--primary))`，zrender 静默失败→回退默认蓝、不随主题                                            |
| 需求一致性 | ✅         | 文档 §10.2:980 已记「候选=榜单前 200」；§9:903 implied-price 端点对齐；无 `/search` 残留                                 |
| 架构边界  | ✅         | 计算逻辑全在 `services/dividend_yield.py`，router 仅编排；ImpliedPriceCalculator 复用 `useRank`/`useImpliedPrice` |
| 测试    | ❌ 缺失      | ImpliedPriceCalculator(347) + RankingPage(Tab/搜索/推算交互) 零测试                                           |
| 安全    | ✅         | `/rankings` 仅 `get_current_user`；`q` 有 `max_length=50`；implied-price 读 own 快照                        |
| 可维护性  | ⚠️ 死代码+重复 | `buildDividendYieldCurveOption` 无生产调用方；ImpliedPriceCalculator 复制 SecuritySearchCombobox UI 外壳        |
| 性能    | ✅         | 前端 250ms 防抖（RankingPage:78-83）；候选本地过滤 200 条 O(n) 无压力                                                 |

---

## 缺陷清单（§4 分级）

### 🔴 P1（功能/视觉缺陷，违反 §0.3 零回归原则）

**P1-1 — 曲线图配色硬编码回归**
- 位置：`web/src/modules/dividend-yield/components/SecurityDetailPanel.vue:44`（内联 `color: ['hsl(var(--primary))']`）
- 证据：cnb/main 基线该文件 line 25/27/38/61 已含 `buildDividendYieldCurveOption` + `useChartTheme()`（c5b0a9e 修复）；`git merge-base --is-ancestor c5b0a9e cnb/main` 确认已合入；`588de97` 把曲线图改写回内联 option 时**丢弃了主题桥**。
- 影响：`lib/chart-theme.ts:4-9` 已记载 ECharts canvas 不解析 CSS 变量，zrender 对 `hsl(var(--primary))` 静默失败返回 null → 折线回退 ECharts 默认蓝 `#5470c6`，**不随明暗主题切换**（暗色下对比度异常）。
- 建议：恢复 `useChartTheme()` + `buildDividendYieldCurveOption`（见 P1-2）。

**P1-2 — 死代码：`buildDividendYieldCurveOption` 纯函数 + 单测变假绿**
- 位置：`web/src/components/charts/dividend-yield-curve-chart.ts:25`（定义）；`web/src/components/charts/__tests__/dividend-yield-curve-chart.test.ts`（仅测试引用）
- 证据：Grep 全仓，`buildDividendYieldCurveOption` 的**唯一引用方是测试文件**，零 `.vue` 生产调用方（SecurityDetailPanel 已回归内联）。
- 影响：c5b0a9e（P1/P2/P3）投入的纯函数 + 6 条单测现在**无人使用**——CI 绿但测的是死代码（假绿），且 knip 未报（因测试文件 import 了它）。违反 §3 可维护性 + §0.3。
- 建议：SecurityDetailPanel 恢复调用该纯函数（顺带修 P1-1）；若坚持内联，则应删除纯函数与单测（不得留死代码）。

### 🟡 M（中危，应修）

**M-1 — 重复造轮子：ImpliedPriceCalculator 复制 SecuritySearchCombobox UI 外壳 ~100 行**
- 位置：`ImpliedPriceCalculator.vue:152-174`（手写搜索框）+ `:140-144`(blur 150ms) + `:134-138`(mousedown 防抢)
- 证据：`components/common/SecuritySearchCombobox.vue:1-110` 是全站复用成熟组件（§7④/§10），两者搜索交互（Search 图标+Input+清除叉+下拉+150ms blur+`data-*-candidate` mousedown 防抢）**高度雷同**。
- 差异（合理不复用数据源）：SecuritySearchCombobox 远程搜 `/api/admin/securities/masters`（全市场主数据），ImpliedPriceCalculator 本地过滤榜单前 200 快照（`useRank` 拉取，非 admin 接口）。语义不同，未直接 `<SecuritySearchCombobox>` 合理。
- 影响：UI 交互骨架重复 ~100 行，后续键盘交互/无障碍修复需改两处。属 §3「可避免的重复」。
- 建议：抽通用 `SearchCombobox` 外壳（受控输入+下拉渲染+清除+键盘骨架，数据源经 slot/prop 注入），两处复用。

**M-2 — 测试缺失：ImpliedPriceCalculator(347) + RankingPage(Tab/搜索/推算) 零测试**
- 证据：diff 无测试文件；`web/src/modules/dividend-yield/__tests__/` 仅有 ranking-page/top-page（旧版，未覆盖推算 Tab 与搜索交互）。
- 影响：违反 §5「改了源码却未覆盖风险路径」；候选过滤、选中态、ratio 换算、快速参考折算等纯逻辑无契约测试。
- 建议：补 `ImpliedPriceCalculator` 单测（选中→numerator 带出、ratio 边界 0/100/NaN、quickRefs 折算）+ RankingPage 交互测试（Tab 切换、q 防抖驱动查询）。

**M-3 — UX 状态不一致：选中后再次输入 `selected` 残留**
- 位置：`ImpliedPriceCalculator.vue:161-162`（`:model-value="searching ? searchQuery : selectedLabel"`，`@update:model-value` 仅写 `searchQuery`）
- 证据：选中股票后（`selected` 非空），用户再次键入 → `searching=true`、Input 显示 `searchQuery`，但 `selected` 未清空；结果卡仍显示旧股，直至 `handlePick` 才更新。复制了 SecuritySearchCombobox:123-124 既有模式，但选股场景下残留更明显。
- 影响：视觉/状态歧义（输入新词时下方面板还显示旧股隐含价）。
- 建议：输入即 `selected.value = null`（或视觉明确区分「搜索态/已选态」）。

### 🟢 L（低危/建议）

**L-1 — 无障碍：候选下拉无键盘导航 + 无 ARIA 角色**
- 位置：`ImpliedPriceCalculator.vue:178-213`（`<button>` 候选，纯鼠标 `@click`）
- 证据：无 `role="listbox"`/`option`/`aria-activedescendant`，无 ↑↓/Enter/Esc。全站既有债（SecuritySearchCombobox 同）。
- 建议：统一补键盘交互（可并入 M-1 的通用 Combobox）。

**L-2 — 错误态缺失：候选加载失败误显「无匹配结果」**
- 位置：`ImpliedPriceCalculator.vue:183-193`（仅 `isLoading` 分支，无 `isError`）
- 证据：`useRank` 出错时 `candidates=[]`，下拉走 `v-else-if="filteredCandidates.length===0"` 显示「无匹配结果」，误导（实为加载失败）。
- 建议：加 `candidatesQuery.isError` 分支。

**L-3 — 候选上限（200）前端无提示**
- 位置：`ImpliedPriceCalculator.vue:7-8,29`（候选=榜单前 200）
- 证据：文档 §10.2:980 已记该限制（非静默），但前端候选区无「仅搜前 200 高股息」提示；用户搜排名 200 外股票无结果易困惑。
- 建议：候选区加一行说明文字。

### 🔧 债务（历史债，登记 cleanup REP，不阻塞本次）
- 全站搜索框无键盘导航（SecuritySearchCombobox + ImpliedPriceCalculator 同）——建议 cleanup REP 统一抽通用 Combobox 收口（覆盖 M-1/L-1）。

---

## 澄清表（可疑点 → 结论）

| 可疑点 | 结论 | 证据 |
|---|---|---|
| ImpliedPriceCalculator 选股是否调已回退的 `/search` 端点（404 崩溃）？ | **否**。候选用 `useRank` 拉榜单前 200 + 本地过滤，不依赖 `/search` | `ImpliedPriceCalculator.vue:32-57`；router.py 无 `/search`（IC-1 回退 8e0f63e 已移除） |
| P1 配色是否真回归？ | **是**。cnb/main 基线含修复，588de97 改回内联 | cnb/main `SecurityDetailPanel.vue:25/27/38/61` vs 当前 `:44` |
| 文档是否对齐当前实现？ | **是**。§1/§9/§10.1/§10.2 均反映榜单 Tab / ImpliedPriceCalculator / 候选前 200；无 `/search` 残留 | 文档 grep：:47/:903/:940/:944/:980 |
| 后端 `q` 过滤是否静默丢数据？ | **否**。ilike 模糊 + 按需 join + total 一致 | router.py:132/143/179-187/189 |
| hooks 签名是否回归？ | **否**。`useRank`(5参)/`useImpliedPrice`(3参) 均对齐调用方 | `use-dividend-yield.ts:48/97` |

---

## 验证（信任但核实）

- ✅ 后端 `q` 过滤：`max_length=50`、空串转 None、ilike 模糊、exchange/q 触发 join、paged 返回过滤后 total——无静默丢数据。
- ✅ hooks 签名：RankingPage `useRank(allPage,allPageSize,allSort,true,rankFilters)` 与 ImpliedPriceCalculator `useRank(candidatePage,200,candidateSort,true)` 均对齐 `use-dividend-yield.ts:48`；`useImpliedPrice(masterId,validRatio,enabled)` 对齐 `:97`。
- ⚠️ **未实际跑测试**：diff 无测试文件，故「测试覆盖」维度直接判 M-2 缺失（无法核实是否真覆盖）。
- ⚠️ 前端 `vue-tsc`/`eslint` 未本地重跑（本轮仅静态取证）；类型推断层面 ImpliedPriceCalculator 调用方对齐，预计可过，但**P1-2 死代码未被 knip 拦截**提示静态门对「测试引用的死函数」有盲区。

---

## 决议（§9 通过门槛）

- **P1-1 + P1-2 未决 → 不符合零 P1 合入门槛**。建议 owner **打回**，先恢复 `SecurityDetailPanel` 的 `useChartTheme` + `buildDividendYieldCurveOption` 调用（一行 import + 一行调用即可修两项），再合入。
- M-1/M-2/M-3 排期修（M-2 测试可与 P1 同批补，成本最低）。
- L-1/L-2/L-3 建议随 M-1 通用 Combobox 收口，不阻塞。
- 债务🔧 登记 cleanup REP（全站搜索框键盘交互统一）。

> QA 签署：CodeReviewExpert ｜ 2026-09-09 ｜ 待 owner 裁定 P1 打回。
