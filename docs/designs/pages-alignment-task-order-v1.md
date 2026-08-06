# 8 页对齐 · 执行任务书（T01 修复 + T02–T06 四段连打 + Excel 扩展）

> 版本：v1 · 2026-08-06 · 主理人齐活林（Qi）汇编
> 依据：`docs/designs/incremental-pages-alignment-v1.md`（架构师增量设计，T01–T05）+ `docs/designs/pages-prd-alignment.md`（§7 决策 Q-1甲~Q-7甲）+ QA 第 1 轮验证报告（BUG-1/2/3）+ 用户拍板（四段连打、T05 加 Excel、O-9 纳入）
> 状态：**待派发**（工程师/QA 受 429 频率限制，预计 2026-08-06 10:06:35 UTC+8 重置后开跑）

---

## 0. 执行模式（用户拍板，硬约束）

1. **一次派发、逐段 commit**：同一 turn 内按 段0→段1→段2→段3→段4→段5 连续推进；**每段自验（tsc + 对应测试）通过后独立 `git commit`**（单行 `-m`，勿用 heredoc——沙箱内静默失败）；全部完成后执行全局一致性审查（IS_PASS: YES/NO），然后**一次性交 QA 全量验证**（QA 只做 1 轮全量 + 定点返工，不进第 3 轮）。
2. 前置：**段 0（T01 修复）必须先落地并 commit**，它是段 1–5 的地基。
3. 工作区现状：T01 原始实现（未 commit）+ 本次修复，**全部改动**在 段0–段5 内分层 commit；每段 commit 后 `git status` 应干净（除下一段文件外）。
4. 提交规范：commit message 前缀 `feat(web|backend|shared):`，单行 ≤72 字符；段 0 用 `fix(web):`。
5. **不 push**：所有 commit 完成后交 QA 验证，QA 通过后由主理人统一双推 origin + cnb（沙箱内用 Bash 直推，勿用 push-all.ps1）。

---

## 段 0 · T01 修复（P0 · 必须先完成）

QA 第 1 轮路由 **Engineer**。修复以下 3 项 + 顺手清理：

### BUG-1（P0）`pageSize=1000` 触发 400 → 快照页派生列静默空白
- **位置**：`packages/web/src/hooks/use-query-data.ts:87` → `listSnapshots(portfolioId, { pageSize: 1000 })`
- **根因**：后端 `SnapshotQueryDto.pageSize` 有 `@Max(200)`，`main.ts` 全局 `ValidationPipe({whitelist, forbidNonWhitelisted})` → 该请求恒 400 → `navMap` 恒 undefined → 快照页「系统自动计算值」「差异%」两列全空白（页面不崩，静默失效）。
- **修法（QA 建议，采纳）**：
  1. 快照 **list 页**：直接读列表行内 `s.derivedTotalAsset`（T01 已回填，**零额外请求**），不再依赖 `useNavTotalAssetMap` 拉全量。
  2. 快照 **form 页**（录入表单的覆盖提示）：改用 `listSnapshots(pid, { startDate: date, endDate: date, pageSize: 1 })` 精确查单日。
  3. `useNavTotalAssetMap` 若仅剩 form 页用，改造为精确单日查询；若已无消费方，删除（连同其测试）。
- **验收**：快照页两列有值；录入表单覆盖提示正常；无任何请求带 `pageSize>200`。

### BUG-2（P1，随 BUG-1 解决）只取第 1 页丢老数据
- 即使改 200，快照日 >200 天的组合会丢老数据（旧实现 `getNavSeries('2000-01-01')` 是全量，属功能回退）。按 BUG-1 修法（list 读行内 / form 查单日）后本项自动消除。

### BUG-3（P1，主理人已裁决：补齐）A3 单条端点未实现
- 增量设计 §3.2 **A3 `GET /api/portfolios/:pid/snapshots/:date`** 与 §3.1 classDiagram 的 `SnapshotService.findOne` **未实现**（controller 无 `@Get(':date')`，service 无 `findOne`）。
- **裁决：补 A3**（设计文档写了就是契约一部分；form 页查单日正好可用）。实现复用现有 `attachDerivedTotalAsset`（几行），DTO 校验 `date` 为 `YYYY-MM-DD`。注意路由顺序：`@Get(':date')` 不能吞掉 `@Get()` 列表路由（Nest 按声明顺序匹配，列表路由在前）。
- **验收**：`GET /snapshots/2026-01-01` 返回单条（含 `derivedTotalAsset`）；404 语义与其它单条端点一致。

### 顺手清理（QA 遗留项）
- `packages/web/src/features/snapshots/snapshot-list.tsx:133` 与 `snapshot-form.tsx:106` 的陈旧注释（仍写「近似 NAV×份额，待后端」）→ 改为与现状（`derivedTotalAsset`）一致。

**段 0 自验**：backend jest（含 snapshot/overview 相关 suite）全绿、web vitest 全绿、`pnpm -r tsc --noEmit` 0 error、Prisma 零变更。commit。

---

## 段 1 · T02 持仓页 P0 三项（AL-026/027/028，依赖 T01）

以增量设计 §5 T02 为准，摘要如下（详见原文档）：

**源文件**：
- `packages/web/src/features/holdings/holdings-query-params.ts` [新]
- `packages/web/src/features/holdings/holdings-toolbar.tsx` [新]
- `packages/web/src/pages/HoldingsPage.tsx` [改]
- `packages/web/src/hooks/use-holdings.ts` [改]

**验收**（逐条）：
1. **日期选择器（HOLD-B-P0-11）**：默认今日 `todayInAppTzIso()`；**删除页内私有 `todayIso()`（HoldingsPage.tsx:75，本地时区 bug，QA 已点名）**；可选范围 `[首个交易日, 今日]`，越界不可选；切换后请求 `?date=`，表格 + 5 张聚合卡同步刷新。
2. **已清仓（HOLD-B-P0-04）**：默认隐藏 `qty=0`；开关打开后 `?includeClosed=true`，已清仓行灰色「已清仓」标签、排在正常持仓后。
3. **类型多选（HOLD-B-P0-11）**：Popover + Checkbox（股票/ETF/基金/债券/其他），全不选=全部；`?types=STOCK,ETF`；按钮徽标显示已选数。
4. **URL 持久化**：`?date=&closed=1&types=STOCK,ETF&sec=xxx` 刷新还原；复制链接视图一致；默认值不出现在 URL。
5. **聚合卡以后端 `aggregate` 为准**，前端不重算总市值/总盈亏。
6. **「显示已清仓」初值**取自 `UserPreference.showLiquidated`；**URL 参数优先级高于 preference**。
7. 组合切换无请求竞态（`keepPreviousData` + loading 骨架）。
8. **日期下限取数（O-4，默认方案甲）**：前端 `useTransactions(pageSize:1, sortOrder:'asc')` 取首个交易日，零后端改动。

**段 1 自验**：web tsc + vitest（含 holdings 相关 suite）全绿。commit。

---

## 段 2 · T03 概览页 URL 持久化 + 新鲜度提示条（AL-014/015，依赖 T01）

以增量设计 §5 T03 为准：

**源文件**：
- `packages/web/src/features/overview/overview-query-params.ts` [新]
- `packages/web/src/features/overview/freshness-banner.tsx` [新]
- `packages/web/src/pages/dashboard.tsx` [改]

**验收**（逐条）：
1. `granularity` / `range` / `from` / `to` 从 `useState` 迁至 URL query（key 见增量设计 §3.3）；刷新/前进后退/分享链接还原。
2. `DimensionSwitcher` **组件本体零改动**，仅替换 `value`/`onChange` 数据源。
3. **新鲜度条（DASH-P1-03）**：`freshness.isStale === true` 时顶部渲染 warning banner，文案列出全部 `reasons`（如「行情已 4 天未更新」）；提供 `[去更新行情]`（跳持仓页）`[去更新现金余额]`（跳 `/cashflows`）`[本次会话不再提示]`（**sessionStorage，O-7 默认**）。
4. `isStale === false` **完全不渲染**（不占位、无布局跳动）。
5. **移除** `dashboard.tsx:361` 基于 `ov.latestDate` 的旧口径 `isStale(...)` 文案，统一走后端 `freshness`。
6. **freshness 字段翻必填（QA 遗留项收口，选方案①）**：更新 2 个 dashboard 既有测试的 mock 补 `freshness`，web 端 `OverviewResponse.freshness` 由 `?` 改必填（与设计 classDiagram 一致）。**不得保持"可选但组件不判空"的中间态。**
7. 设置页改 `staleDays` → 概览页 invalidate 后 banner 即时变化。

**段 2 自验**：web tsc + vitest（dashboard/overview 相关 suite，含 mock 更新后的 2 个既有测试）全绿。commit。

---

## 段 3 · T04 现金余额变更历史展开器（AL-046，依赖 T01）

以增量设计 §5 T04 为准：

**源文件**：
- `packages/web/src/features/cashflow/cash-balance-history.tsx` [新]
- `packages/web/src/features/cashflow/query-params.ts` [改]（复用 `lib/url-query` 原语去重，外部行为不变）
- `packages/web/src/pages/transactions.tsx` [改]（移除 line 471「本轮不做」注释）

**验收**（逐条）：
1. **CASH-P1-01**：现金余额维护区「查看变更历史 ▾」，展开后按 `asOf` 倒序（生效日 / 金额 / 备注 / 更新时间），分页 pageSize 20。
2. 每行可**编辑**（改金额/备注）与**删除**；编辑走 upsert、删除走 remove，均由后端触发 `recalculateNavRange(pid, asOf)`。
3. 成功 toast 展示「已重算 YYYY-MM-DD 起 N 天」；后端未返回天数时降级「已重算（自 YYYY-MM-DD 起）」，不报错。
4. 成功后 `invalidateQueries` 覆盖 `['cash-balances'] ['overview'] ['nav'] ['snapshots'] ['holdings']`。
5. **不新增审计表、不改 Prisma**：变更历史 = 多行 `asOf` 列表（复用 `useCashBalances`）。
6. 折叠状态默认收起、不写 URL（纯 UI 局部状态）。

**段 3 自验**：web tsc + vitest（cashflow 相关 suite）全绿。commit。

---

## 段 4 · T05 CSV + **Excel** 导入/导出（AL-042/079/080 + 用户新增 Excel 支持，依赖 T01）

以增量设计 §5 T05 为准，**叠加用户新决策：CSV 之外增加 Excel（.xlsx/.xls）支持**。主理人定案如下：

### 4.1 技术定案（Excel 扩展，主理人裁决）
- **新增依赖**：后端 `xlsx@^0.18.5`（SheetJS Community Edition，Apache-2.0，npm 官方版本）；前端**不装** xlsx（解析统一在后端）。
- **导入**：multipart 文件字段同时接受 `.csv` / `.xlsx` / `.xls`（MIME + 后缀双校验）；后端按扩展名分流解析（CSV→papaparse；XLSX→xlsx），**归一化为同一行结构**，走同一 preview/commit 管线。XLSX 解析时第一行英文表头、跳过以 `#` 开头的数据行（与 CSV 约定一致）；单元格日期若为 Excel 序列号需转为 `YYYY-MM-DD`。
- **导出**：`GET /data-transfer/export?type=xxx&format=csv|xlsx`，`format` 缺省 `csv`；`xlsx` 时同样英文表头 + 第二行 `#` 注释行（sheet 单元格文本），Decimal 一律 string 原样写入（不做数值化，防精度丢失）；文件名 `{组合名}-{类型}-{YYYYMMDD}.{ext}`。
- **错误码**：文件类型/大小/行数校验对两种格式统一（`INVALID_FILE_TYPE` / `FILE_TOO_LARGE` / `TOO_MANY_ROWS`）。
- **前端**：导出面板加格式选择（CSV / Excel）；导入对话框 `accept=".csv,.xlsx,.xls"`；预览与错误导出逻辑不变。

### 4.2 增量设计 §5 T05 原文（CSV 部分，全部保留）
**源文件（后端）**：
- `packages/backend/src/modules/data-transfer/data-transfer.{module,controller,service}.ts` [新]
- `packages/backend/src/modules/data-transfer/csv/{csv-serializer,csv-parser,export-schemas,import-schemas}.ts` [新]
- `packages/backend/src/modules/data-transfer/dto/{export-query,import-commit}.dto.ts` [新]
- `packages/backend/src/app.module.ts` [改]

**源文件（前端）**：
- `packages/web/src/api/data-transfer.api.ts` [新]
- `packages/web/src/hooks/use-data-transfer.ts` [新]
- `packages/web/src/features/data-transfer/{export-panel,import-dialog,csv-download}.{tsx,ts}` [新]
- `packages/web/src/pages/settings.tsx` [改]

**验收**（逐条，CSV 部分 + Excel 叠加）：
1. **SET-P0-03 导出**：7 类（`securities/securityTrades/cashFlows/cashBalances/securityPrices/assetSnapshots/navSeries`）均可导出；文件名 `{组合名}-{类型}-{YYYYMMDD}.csv`（或 `.xlsx`）；CSV 以 **UTF-8 BOM** 开头（Excel 双击中文不乱码）；Decimal 以 **string 原样输出**，不科学计数、不丢精度。
2. **SET-P0-04 模板**：3 类导入类型均可下载模板（表头 + 1 行示例），CSV/XLSX 双格式。
3. **FLOW-P1-01 预览**：上传后展示前 10 行有效数据 + 全量行级错误（行号/字段/原因），错误可导出 CSV；预览**绝不写库**。
4. **FLOW-P1-01 提交**：单 Prisma 事务；事务后**全流程仅 1 次** `recalculateNavRange(pid, minDate)`（**必须有单测断言调用次数 === 1**）；返回 `{inserted, updated, skipped, failed[], recalculated{fromDate,toDate,recalculatedDays}}`。
5. **冲突策略（O-3 默认）**：`securityTrades`/`cashFlows` 纯 insert 不去重（同日多笔合法）；预览对「疑似重复行」给 warning（不阻断）；`assetSnapshots` 按 `(portfolioId, date)` upsert 且 `source` 强制 `MANUAL`。**导入前 UI 提示用户先导出备份**（O-8）。
6. 上传限制：`.csv/.xlsx/.xls`（MIME + 后缀双校验）、≤5MB、行数 ≤10000；超限返回明确错误码而非 500。
7. 导入成功后 `invalidateQueries` 覆盖 `['holdings'] ['overview'] ['nav'] ['transactions'] ['snapshots'] ['cash-balances']`。
8. 跨组合安全：export/import 校验 `portfolioId` 归属；CSV/XLSX 中其它 `portfolioId` 列一律忽略（以路径参数为准）。
9. **不引入 zip**：多类型导出前端串行触发多个下载。

**段 4 自验**：backend jest（data-transfer 全套单测，含 recalc 调用次数 === 1 断言、N+1 无）、web vitest、双端 tsc 全绿；**手工验证一次**：用 Node 脚本/或真实请求走通「XLSX 导入→预览→commit」冒烟。commit。

---

## 段 5 · T06 O-9 边界确认（AL-082/083，用户已拍板纳入）

两项均为**代码级确认 + 状态回填**，非新功能。主理人已初步侦察（结论如下），工程师需正式复核并给证据：

### AL-082（P0，FLOW-P0-01②）确认 cashflow-form 已剥离证券明细字段
- **主理人侦察**：`packages/web/src/pages/transactions.tsx`（出入金页真实落点，AL-084 裁定）grep `securityId|quantity|price|fee` 仅命中 1 处提示文案「存取与证券买卖不会自动调整此值」，**无证券明细表单字段** → 基本已满足。
- **工程师任务**：正式复核 transactions.tsx（及 cashflow-form 相关组件）无 `securityId/quantity/price/fee` 录入控件；若有残留则剥离；把 `docs/designs/pages-prd-alignment.md` AL-082 行状态由「❓ 需确认」改为「✅ 已完成」并附证据（文件:行号）。

### AL-083（P0，HOLD-B-P0-10 / Q-1甲）确认分红/费用后端模块已随阶段 C 落地
- **主理人侦察**：`packages/backend/src/modules/dividend/`、`modules/fee/`、`modules/cashflow/` 均存在；fee.controller.ts 注释「阶段 C · Q-1 A 恢复」；shared `types/dividend.ts`（CASH/STOCK_DIVIDEND）存在 → **后端已落地**。
- **工程师任务**：确认分红/费用**前后端链路**可用（后端 controller/service + 前端 api 调用 + 【E】区 UI 入口）；给出证据（文件列表 + 路由清单）；若前端【E】区入口缺失则补齐最小接入；把 `docs/designs/pages-prd-alignment.md` AL-083 行状态改为「✅ 已完成」。

**段 5 自验**：无新增测试需求（如补了代码则补测）；文档回填后 `git status` 干净。commit（`docs:` 前缀）。

---

## 收尾 · 全局一致性审查 + 全量回归（IS_PASS）

全部段完成后执行：
1. 全局一致性审查（跨文件约定：日期时区/精度/URL key 命名/invalidate 矩阵/信封格式），**IS_PASS: YES/NO**；NO 则修复后重审（最多 2 轮）。
2. 全量回归：backend jest 全量 + web vitest 全量 + `pnpm -r tsc --noEmit` + lint 全绿；Prisma 目录零变更。
3. 汇总：每段 commit hash + 改动文件清单 + 对增量设计的**偏离点清单**（含 Excel 扩展的落点说明）。
4. **不 push**（主理人统一双推）。

---

## 共享知识速查（完整版见增量设计 §7）

- **日期时区**：后端 `todayInAppTz()` / 前端 `todayInAppTzIso()`（lib/constants.ts）；**禁止**页面自建 `todayIso()`（T02 删除）；外部日期一律 `YYYY-MM-DD`。
- **精度**：Decimal 全程 **string** 传输，前端不得 `Number()` 参与金额运算；CSV/XLSX 导入用字符串正则校验小数位，超精度报错不静默截断。
- **重算级联（铁律）**：任何写历史日期的路径在事务后调 `recalculateNavRange(pid, minAffectedDate)`；**CSV 导入全流程只调 1 次**；toast 透出 `{fromDate,toDate,recalculatedDays}`，缺省降级不报错。
- **API 约定**：base `/api`，统一信封 `{code,data,message}`（code===0 成功）；**文件下载接口不套信封**，直接 `text/csv` + `Content-Disposition`，前端 `responseType:'blob'`；`ValidationPipe` whitelist+forbidNonWhitelisted → **新 query 参数必须同步扩 DTO**，否则 400。
- **URL Query 命名**：小写 key；布尔 `1/0`；多值逗号分隔；等于默认值从 URL 移除；非法值静默降级。
- **CSV 约定**：UTF-8 + **BOM**；英文表头 + 第二行 `#` 注释行（导入跳过 `#` 行）；`\r\n`；含逗号/引号/换行值双引号包裹转义 `""`；空值空串。**XLSX 同构**：第一行英文表头 + 跳过 `#` 注释行 + Excel 序列号日期转 `YYYY-MM-DD`。
- **错误码**：`INVALID_FILE_TYPE / FILE_TOO_LARGE / TOO_MANY_ROWS / MISSING_REQUIRED_COLUMN / INVALID_DATE_FORMAT / INVALID_DECIMAL_PRECISION / INVALID_ENUM_VALUE / SECURITY_NOT_FOUND / DUPLICATE_SNAPSHOT_DATE`。
- **invalidate 矩阵**：见增量设计 §7.9（导入 commit / 现金余额编辑删除 / 行情更新 / staleDays 变更）。

## 待明确（实现中若遇新分歧，先按默认推进并记录，交主理人裁决，勿擅自扩大范围）
- Excel 导出列结构与 CSV 完全一致（不含额外 sheet 汇总）。
- `navSeries` 导出列 = `date/cumulativeNav/yearlyNav/shares/totalAsset/xirr`（O-1 默认）。
