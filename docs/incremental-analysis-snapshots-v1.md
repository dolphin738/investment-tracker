# 收益分析页 + 资产记录页 增量对齐设计 v1（前端为主 · 后端缺口标注/占位）

> 架构师：高见远（software-architect）
> 上游：`docs/PRD.md` v3.1.8（§7.3 / §7.5 / §6.5 / §6.7 / §5.4 / §5.6 / §3.2 / §8）+ 任务书（主理人已知差距线索）
> 参考模式：`docs/incremental-account-v2.md`（上一轮账户域对齐：前端对齐为主、后端缺字段标注/占位、Gap D 占位口径）
> 核查方式：逐文件实读 PRD 相关章节 + 前端 8 个文件 + 后端 snapshot/query/recalculation/calculation/valuation 模块，结论以源码为准
> 轮次约束：最小变更、不顺手重构无关代码、后端缺口只标注（极小且必需的在 Part F 单独列出供主理人决策）

---

## 0. 结论速览（对任务书差距线索的验证 / 补全 / 纠正）

| # | 任务书线索 | 验证结论 |
|---|---|---|
| ① | 差异提示条（SNAP-P0-07） | **缺失**；且差异值的现有来源 `useNavTotalAssetMap`（NAV×份额）**对手工日失真**：NAV 计算读当日快照行（含手工值），数学上 `cumulativeNav×shares = 当日快照值`，故手工行差异恒 ≈ 0。PRD 要求「该日系统自动计算值」= `computeDerived(date)`（实时算 `marketValue+cashBalance`，不受手工覆盖影响），后端**未暴露** → **后端缺口**（建议 `derivedTotalAsset`）。前端先以近似 + 注释实现，数值精确性待后端补字段。 |
| ② | 筛选行「日期范围 + 来源[✓自动 ✓手工] + [重置]」 | **缺失**。后端 list **支持 dateRange**（`SnapshotQueryDto.startDate/endDate`）✓；**不支持 source 筛选**（DTO 无该字段，全局 `ValidationPipe forbidNonWhitelisted: true` 会直接 400）→ 后端缺口（极小，候选修复，见 Part F）。「重置」= 清空筛选条件，纯前端。 |
| ③ | 页头「[导出 CSV]」 | **缺失**。全仓无 CSV 导出接口（settings 页 SET-P0-03 亦为 disabled 占位）→ **按上一轮 Gap D 口径：视觉占位 + 注释**，不做后端导出。 |
| ④ | 手工行差异详情「ⓘ 系统自动计算值 ¥281,000.00，差异 +9,000.00 (+3.20%) + 备注」 | **已有，列式呈现**（非展开行）：`snapshot-list.tsx`「系统自动值（差异）」列 + 备注列。数值来源为近似（见①），`+9,000.00 (+3.20%)` 形式为 `¥xxx（3.20%）` 缺「差异金额」部分 → 需补 `+9,000.00` 金额差异（前端可算，工具函数新增）。 |
| ⑤ | 删除/重置双入口 + 文案区分（§7.3 L1188-1190） | **前端已满足**：`snapshot-list.tsx` 已有 🗑 删除（自动行也可见）+ ↺ 重置（仅手工行可见），确认弹窗文案已区分（删除=「事件日自动重新生成…否则移除」；重置=「手工记录将被系统自动计算值取代」）。**但后端两处语义有 bug**（见 Part B ④）：`SnapshotService.resetToDerived` 保留手工值只改 source 标记（未调 `computeDerived`）；`SnapshotService.deleteRecord` 事件日回填 `totalAsset=0` 占位且无后续覆盖 → 极小候选修复（Part F）。 |
| ⑥ | 新建/编辑弹窗（覆盖提示 / 日期不可未来 / 总资产必填 / 持仓现金选填 / 备注 / [保存并重算] + toast） | **基本符合**：`snapshot-form.tsx` 日期 `max=today`、总资产必填>0、持仓/现金选填、系统自动值覆盖提示 ✅。差异：按钮文案为「录入/保存」而非「保存并重算」；toast 为通用「快照已保存」而非 PRD 的「已记录 …（手工，已取代自动值）+ 已重算自该日起 N 天…」；备注为「可选」而 PRD 为「强提示填写」；编辑手工行时系统值提示失真（同①）。 |
| ⑦ | 页头「[组合: 我的组合▼]」 | **顶栏全局已提供**（`app-layout.tsx` L58 `PortfolioSelector`）→ **页内不重复加**，PRD 草图为示意。两页一致处理。 |
| — | §7.5 收益分析页「← 返回」「[组合: ▼]」 | 组合选择同上（全局已有）。「← 返回」当前缺失，侧栏导航已提供同等能力 → **可选增强**（`navigate(-1)` 或跳概览），建议按全局一致性不加，待主理人拍板。 |
| — | 「较年初」口径（§7.5 草图 + ANL-P0-04） | 当前实现 = `validPoints.find(date.startsWith(当前年份))` 回退首点 —— **有缺陷**：① 用系统时钟年份而非数据年份；② 在**当前查询范围**内查找，范围不含年初时基准错（回退到范围首点）；③ 与「当前累计 XIRR」（全局最新）口径不一致。后端无「年初基准」字段 → **前端可算**（独立日粒度查询当年首个非空 XIRR），无需后端。 |

---

## Part A · 两页差距清单（PRD 需求/草图 ↔ 现状 → 缺口判定）

### A1. 资产记录页 `/snapshots`（PRD §7.3 + §6.5 SNAP- + §5.4）

| # | PRD 项（位置/ID） | PRD 要求 | 现状（文件:行） | 缺口判定 |
|---|---|---|---|---|
| S1 | §7.3 页头 | 标题「历史总资产记录」+ 说明「🤖 默认由系统每日自动记录；✋ 可手工补录…ⓘ 每天只保留一条记录」+ [导出 CSV] + [+ 新建记录] | `snapshots.tsx:57-68`：标题「资产记录」+ 说明文字 ✅ + 按钮「录入资产记录」（无导出） | **部分**：标题/按钮文案与草图略有差异（建议对齐「历史总资产记录」「+ 新建记录」）；[导出 CSV] 缺失 → **占位**（Gap D 口径） |
| S2 | §7.3 顶部提示条 / SNAP-P0-07 ⑥ | 「⚠️ 当前有 N 条手工记录，其中 M 条与自动值差异 > 1% [仅看手工]」常驻，点击筛选 | `snapshot-list.tsx` / `snapshots.tsx` 均无 | **缺失** → 新增；N/M 依赖「该日系统自动计算值」（近似实现 + 后端缺口，见 Part B ②） |
| S3 | §7.3 筛选行 / SNAP-P0-04b 验收 2 | 日期 `[from]~[to]` + 来源 `[✓自动 ✓手工]` + [重置] | `snapshot-list.tsx` 无筛选 UI；`SnapshotQuery` 类型已有 `startDate/endDate/source`（`api/types.ts:398-404`）但列表未传；后端 DTO 无 `source` | **缺失** → 新增 UI；dateRange 后端已有 ✅；source 后端缺口（极小候选修复，Part F） |
| S4 | §7.3 表格列 / SNAP-P0-04b 验收 1 | 日期/总资产/持仓/现金/来源(`🤖自动`/`✋手工`)/操作；手工行视觉高亮 | `snapshot-list.tsx:129-236`：6 列 ✅ + 额外「系统自动值（差异）」列 + 备注列；手工行 Badge 高亮 ✅ | **已满足**（列式差异呈现与草图「展开行」不同，功能等价，最小变更保持现状） |
| S5 | §7.3 手工行差异详情 / SNAP-P0-02 / SNAP-P0-04b ⑥ | 「系统自动计算值 ¥281,000.00，差异 +9,000.00 (+3.20%)」（实时 computeDerived） | `snapshot-list.tsx:174-197`：`系统 ¥x（3.20%）` —— 无差异金额；来源为 `useNavTotalAssetMap` 近似 | **部分**：形态已有；数值口径待修（近似 + 缺金额差异）。PRD 要求 `derivedTotalAsset` → **后端缺口** |
| S6 | §7.3 L1188-1190 / SNAP-P0-06 ⑤⑥ / SNAP-P0-07 ② | 🗑 删除与 ↺ 重置双入口并存、文案区分；删除自动记录提示「事件日会重新生成」；重置仅手工记录可见 | `snapshot-list.tsx:202-228` 双入口 ✅；删除确认 `:269-297` 已区分事件日/非事件日 ✅；重置确认 `:300-328` ✅ | **前端已满足**；后端 reset/delete 语义有 bug（Part B ④，候选修复） |
| S7 | §7.3 新建/编辑弹窗 / SNAP-P0-06 ① | 日期*(不可未来，已有自动记录日提示覆盖)/总资产*(≥0)/持仓(选填)/现金(选填)/备注(强提示)/⚠️ 该日系统自动计算值/「保存并重算」/详细 toast | `snapshot-form.tsx`：字段齐全、`max=today` ✅、覆盖提示 ✅；按钮「录入/保存」（非「保存并重算」）；备注「可选」；toast 通用（`use-snapshots.ts:49` 等） | **部分**：文案/提示级别需对齐（按钮、备注提示、toast、日期已有自动记录提示） |
| S8 | §7.3 底部图例 | ⓘ「沿用」/「按成本」/每天唯一一条/✎🗑↺ 图例说明 | `snapshots.tsx:72-75` 有来源说明，无完整图例 | **部分**：可补图例（低成本）；估值标记列（SNAP-P0-04b 验收 1 列了，草图未列）可选 |
| S9 | SNAP-P0-04b 前值填充 | 无记录的自然日按前值填充补齐（曲线口径） | 后端 `findAll` 仅返回实际存在行，未补齐连续日期；列表页仅展示实存记录 | **后端缺口（数据形态）**：本轮不实现，列表仍展示实存记录，口径注释说明 |
| S10 | SNAP-P0-06 验收 5 | 删除：物理删除；事件日派生层立即回填自动记录 | 后端 `SnapshotService.deleteRecord:254-310` 回填 `totalAsset=0` 占位（无后续覆盖） | **后端 bug（候选极小修复，Part F）**：应委托 `AssetValuationService.deleteRecord`（内部 `persistDerived` 正确回填） |

### A2. 收益分析页 `/analysis/xirr`（PRD §7.5 + §6.7 ANL- + §5.6 + DASH- 复用）

| # | PRD 项（位置/ID） | PRD 要求 | 现状（文件:行） | 缺口判定 |
|---|---|---|---|---|
| X1 | §7.5 页头 | 「← 返回」「收益分析 (XIRR)」「[组合: ▼]」 | `xirr-analysis.tsx:88-94`：仅标题；无返回按钮；无页内组合选择（顶栏全局已有） | **部分**：组合选择全局满足不重复加 ✅；返回按钮可选（侧栏已能导航），待拍板 |
| X2 | §7.5 维度行 / DASH-P0-02 | 维度[日][周][月][年] + 范围（快捷项：近3月/近1年/今年/全部）；默认「月+近1年」可被偏好覆盖；维度与范围写入 URL query | `xirr-analysis.tsx:49-54`（DimensionSwitcher）+ `dimension-switcher.tsx`：Tab ✅ + 起止日期输入 ✅ + 聚合方式 ✅；**无快捷范围下拉**；**无 URL query 同步**；默认维度读偏好 ✅（`getPreference('defaultGranularity')`），默认范围固定近 1 年 | **部分**：快捷范围下拉 + URL query 同步缺失（DASH-P0-02 验收 2/4 未落地） |
| X3 | §7.5 摘要卡 / ANL-P0-04 | 当前累计 XIRR + 较年初变化 pp | `xirr-analysis.tsx:98-124` 两卡 ✅；`较年初` 计算 `:73-80` | **部分（有缺陷）**：较年初基准口径错误（见 §0 末行），前端修复 |
| X4 | §7.5 XIRR 趋势折线 / DASH-P0-04 | Y 轴百分比、0% 基准虚线、null 断线不画 0 | `xirr-trend-chart.tsx`：Y 轴 % ✅、`connectNulls=false` ✅（页面传参）、tooltip「数据不足」✅；0% 虚线仅依赖默认网格线 | **已满足**（0% 虚线为 ECharts 网格近似，可接受） |
| X5 | §7.5 年度 XIRR 柱状 / DASH-P1-05 | 正红负绿；当年柱高亮 | `yearly-bar-chart.tsx`：正红负绿 ✅（`POSITIVE_COLOR`/`NEGATIVE_COLOR`）；**无当年柱高亮** | **部分**：当年柱高亮缺失（低成本增强） |
| X6 | §7.5 明细表 / ANL-P0-04 | 日期/XIRR/环比变化 | `xirr-analysis.tsx:142-185` ✅（`formatChange` 出 pp） | **已满足** |
| X7 | §6.7 ANL-P0-01/02/03 | 多维度查询接口（后端✅）；基础可视化（✅）；周期聚合规则（last/avg + 偏好联动） | 后端 `query.service.ts` 四维度聚合 ✅；前端聚合切换 ✅；**默认聚合硬编码 LAST**（未读偏好 `aggregation`） | **部分**：ANL-P0-03「聚合默认读偏好」未接（小改） |
| X8 | ANL-P0-04 组合切换联动 | 切换组合后页面数据联动 | `xirr-analysis.tsx:44` 读 `currentPortfolioId`，切换自动 re-query ✅ | **已满足** |
| X9 | §7.5 口径提醒 | XIRR 序列来自 daily_xirr（累计口径），本页不直接计算 | 前端仅可视化，数据来自 `useXirrSeries` → `GET /xirr` ✅ | **已满足** |

---

## Part B · 数据可用性核查结论（逐项：已有 / 前端可算 / 后端缺口）

| # | 能力 | 现状核查 | 判定 | 建议（若后端缺口） |
|---|---|---|---|---|
| B1 | **来源筛选（source: AUTO/MANUAL）** | 前端 `SnapshotQuery.source?` 已声明（`api/types.ts:403`）但从未发送；后端 `SnapshotQueryDto`（`upsert-snapshot.dto.ts:69-93`）**无 source 字段**；全局 `ValidationPipe({ forbidNonWhitelisted: true })`（`main.ts:41-48`）→ 发送即 400 | **后端缺口**（极小） | `SnapshotQueryDto` += `@IsOptional() @IsEnum(SnapshotSource) source?: SnapshotSource`；`snapshot.service.ts findAll` where += `...(query.source ? { source: query.source } : {})`（约 5 行）。**候选修复见 Part F-F2** |
| B2 | **日期范围（dateRange）** | 后端 `startDate/endDate` ✅（`upsert-snapshot.dto.ts:69-78` + `snapshot.service.ts:104-114`） | **已有** | — |
| B3 | **该日系统自动计算值（computeDerived）** | 后端 `AssetValuationService.computeDerived`（`asset-valuation.service.ts:63-100`）**已存在**（纯计算，PRD SNAP-P0-01 验收 5 已满足），但 **list API 不返回**；前端用 `useNavTotalAssetMap`（NAV×份额，`use-query-data.ts:72-96`）近似 —— 对手工日失真（≈手工值）、对无快照日缺失 | **后端缺口** | `SnapshotResponse`（`snapshot.service.ts:26-39`）+= `derivedTotalAsset: string \| null`（仅 MANUAL 行返回 `computeDerived().totalAsset`，DERIVED 行 null；性能不足时按 SNAP-P0-04b ⑥ 允许展开行/hover 按需计算）。**本轮前端用近似 + 注释，不阻塞** |
| B4 | **差异计算（该日自动值 − 手工值）** | 前端 `snapshot-list.tsx:145-150` 已算 `diffRate`（基于近似值）；缺「差异金额」展示 | **前端可算**（金额差异 = 手工 − 近似系统值）；精确性受 B3 制约 | 前端 `utils.ts` 新增 `formatAmountChange(current, base)` → `+9,000.00 (+3.20%)` |
| B5 | **导出 CSV** | 全仓无任何导出接口/工具（settings SET-P0-03 为 disabled 占位，`settings.tsx:738-809`） | **后端缺口（整项未实现）** | 按上一轮 Gap D：**本轮不做**，页头 [导出 CSV] disabled 占位 + 注释 |
| B6 | **较年初基准（yearStartXirr）** | 后端无专门字段；`daily_xirr` 可按日粒度 + 任意范围查询（`query.service.ts:189-223`）→ 前端可自行取当年首个非空值 | **前端可算**（无需后端） | 前端新增独立日粒度查询（当年 1/1 起），取首个非空 XIRR 作基准；如需后端权威化，可后续在 summary 加 `yearStartXirr`（不在本轮） |
| B7 | **删除语义（事件日回填自动值）** | `SnapshotService.deleteRecord`（`snapshot.service.ts:254-310`）删除后事件日插入 `totalAsset=0` 占位 DERIVED，`recalculateNavRange` 只重算 NAV/XIRR **不覆盖快照行** → 0 值残留 | **后端 bug（极小且当前页必需）** | 委托 `AssetValuationService.deleteRecord`（内部 `isEventDate` + `persistDerived` 正确回填，`asset-valuation.service.ts:206-227`）。**候选修复见 Part F-F3** |
| B8 | **重置语义（恢复系统值）** | `SnapshotService.resetToDerived`（`snapshot.service.ts:319-362`）upsert 时 `totalAsset: existing?.totalAsset ?? 0` —— **保留手工值只改 source 标记**，未调 `computeDerived` | **后端 bug（极小且当前页必需）** | 委托 `AssetValuationService.resetToDerived`（正确实现已存在，`asset-valuation.service.ts:239-271`）。**候选修复见 Part F-F4** |
| B9 | **XIRR 序列维度 + 范围** | 后端 `GET /xirr` 支持 granularity(day/week/month/year) + startDate/endDate + aggregation ✅（`query.dto.ts:21-39`）；前端 `DimensionSwitcher` 已接 ✅ | **已有** | — |

---

## Part C · 文件清单（仅前端改动/新增；后端缺口见 Part B / Part F，本轮不实现）

| 文件 | 端 | 改动点 |
|---|---|---|
| `packages/web/src/api/types.ts` | 前端 | `SnapshotQuery` 补 `source` 使用注释（后端未支持前禁止发送，避免 400）；`SnapshotResponse` 预留 `derivedTotalAsset?: string \| null` 类型注释（待后端） |
| `packages/web/src/lib/utils.ts` | 前端 | 新增 `formatAmountChange(current, base)` → `+9,000.00 (+3.20%)`（金额差异 + 差异%）；供差异列/提示条/表单提示复用 |
| `packages/web/src/hooks/use-query-data.ts` | 前端 | 新增 `useYearStartXirr(portfolioId)`（日粒度查询当年 1/1 起 XIRR 序列，取首个非空）或复用 `useXirrSeries`；给 `useNavTotalAssetMap` 补「近似口径」注释 |
| `packages/web/src/hooks/use-snapshots.ts` | 前端 | toast 文案对齐 PRD（「已记录 {date} 总资产 ¥x（手工，已取代自动值）＋已重算自该日起 N 天的净值与 XIRR」）；`useSnapshots` 透传 `source`/日期筛选（source 仅在 Part F-F2 获批后发送，否则客户端过滤） |
| `packages/web/src/features/snapshot/snapshot-list.tsx` | 前端 | 新增筛选行（日期起止 + 来源 checkbox + [重置]）；顶部差异提示条（N 手工 / M 差异>1% / [仅看手工]）；差异列补金额差异（`formatAmountChange`）；差异值来源加「近似口径」注释；重置确认弹窗补「将恢复为系统自动计算值 ¥x」 |
| `packages/web/src/features/snapshot/snapshot-form.tsx` | 前端 | 按钮文案「保存并重算」；备注「强提示填写」+ 提示文案；日期字段补「该日已有自动记录，将被覆盖」提示（有记录时）；覆盖提示文案对齐草图；系统值提示加近似注释 |
| `packages/web/src/pages/snapshots.tsx` | 前端 | 页头对齐（标题「历史总资产记录」、说明、[导出 CSV] disabled 占位、[+ 新建记录]）；底部图例（沿用/按成本/唯一一条/✎🗑↺）；管理模式提示保留 |
| `packages/web/src/pages/xirr-analysis.tsx` | 前端 | 较年初修复（改用 `useYearStartXirr`，独立于查询范围；无当年数据回退上年末）；可选：页头返回按钮；可选：URL query 同步（granularity/start/end） |
| `packages/web/src/features/query/dimension-switcher.tsx` | 前端 | 可选：快捷范围下拉（近3月/近1年/今年/全部，对齐 dashboard `DATE_RANGE_OPTIONS`） |
| `packages/web/src/components/charts/yearly-bar-chart.tsx` | 前端 | 可选：`highlightCurrentYear?: boolean` prop，当年柱描边/加深高亮（DASH-P1-05 验收 2） |

> 不改动：`app-layout.tsx` / `portfolio-selector.tsx`（组合选择全局已有，页内不重复加）；后端模块本轮零改动（除 Part F 候选修复待主理人决策）。

---

## Part D · 任务列表（按实现顺序，≤5 任务，依赖最小化）

| Task | 名称 | 源文件 | 依赖 | 优先级 | PRD ID |
|---|---|---|---|---|---|
| **T01** | 基础收口：类型 + 工具函数 + 查询 hooks | `api/types.ts`、`lib/utils.ts`、`hooks/use-query-data.ts`、`hooks/use-snapshots.ts` | — | P0 | SNAP-P0-02 / §7.3 / ANL-P0-04 |
| **T02** | 资产记录页·列表层：筛选行 + 差异提示条 + 差异金额列 | `features/snapshot/snapshot-list.tsx`、`pages/snapshots.tsx`、`api/types.ts` | T01 | P0 | SNAP-P0-04b / SNAP-P0-07 / §7.3 |
| **T03** | 资产记录页·表单与操作：保存并重算 + 文案 + 重置确认补自动值 | `features/snapshot/snapshot-form.tsx`、`pages/snapshots.tsx`、`hooks/use-snapshots.ts` | T01 | P0 | SNAP-P0-06 / §7.3 L1188-1190 |
| **T04** | 收益分析页：较年初修复 + 可选增强（快捷范围 / 当年柱高亮 / URL 同步） | `pages/xirr-analysis.tsx`、`features/query/dimension-switcher.tsx`、`components/charts/yearly-bar-chart.tsx` | T01 | P0（较年初）/ P1（可选） | ANL-P0-04 / DASH-P0-02 / DASH-P1-05 |
| **T05** | 联调验收 + 文档收口 | `docs/incremental-analysis-snapshots-v1.md`（复核）、回归清单（快照 CRUD / 差异 / 维度切换 / 组合联动） | T02, T03, T04 | P1 | 全局一致性 |

**执行建议**：T01 → T02/T03/T04 可并行（T02 与 T03 都碰 `pages/snapshots.tsx`，建议串行或约定 T02 只动列表/页头、T03 只动弹窗与 hooks）；T05 收口。若 Part F 后端候选修复（F2-F4）获批，应先行落地后端再进 T02/T03，前端 source 传参改为服务端筛选。

---

## Part E · 共享知识（跨文件口径约定）

1. **「该日系统自动计算值」口径**：PRD 定义为 `computeDerived(date) = marketValue(date) + cashBalance(date)`（`asset-valuation.service.ts:63-100`），**不受手工覆盖影响**。前端当前 `useNavTotalAssetMap`（NAV×份额）为**近似值**：手工日失真（≈手工值）、无快照日缺失。所有引用处（差异列 / 差异提示条 / 表单覆盖提示 / 重置确认）一律加注释 `// 近似：NAV×份额；待后端 derivedTotalAsset`，数值精确性以后端补字段为准。
2. **差异格式**：`formatAmountChange(current, base)` → `+9,000.00 (+3.20%)`；负数为 `-1,000.00 (-0.35%)`；任一为 null → `-`。差异率阈值 `> 1%` 用 `Math.abs(diffRate) > 0.01`。
3. **来源筛选**：前端 `SnapshotQuery.source` **禁止发送**（后端 DTO 无字段 + `forbidNonWhitelisted` → 400）。T02 默认客户端过滤（仅当前页，注释说明）；Part F-F2 获批后改为服务端传参。
4. **删除 vs 重置文案区分（§7.3 L1188-1190 硬约束）**：🗑 删除 =「删除这条记录（系统会重新生成自动值）」；↺ 重置 =「撤销我的手工修改，恢复系统计算值」；重置仅 `source='MANUAL'` 行可见。本轮前端保持现状文案，仅补重置确认弹窗中的「将恢复为系统自动计算值 ¥x」。
5. **导出 CSV 占位**：`[导出 CSV]` disabled + title「v1 暂未开放（SET-P0-03）」+ 代码注释，与 settings 页 Gap D 口径一致，不新增后端接口。
6. **较年初**：基准 = 当年第一个计算日的累计 XIRR（日粒度序列首个非空，从当年 1/1 起查）；无当年数据 → 回退上年最后一个非空 XIRR；仍无 → `-`。与「当前累计 XIRR」（全局最新）独立取数，不受页面维度/范围影响。
7. **金额/百分比跨网约定**：沿用账户域口径 —— 金额 string 2 位小数、XIRR 比率 ×100 显示、`formatPercent` 负责 ×100；「无数据」用 null 渲染 `-`，禁止渲染 0。
8. **toast 文案（SNAP-P0-06 验收 3）**：保存后「已记录 {date} 总资产 ¥{x}（手工，已取代自动值）」+「已重算自该日起 N 天的净值与 XIRR」（N 暂以后端 recalc 返回为准，缺失时仅展示前半句，注释说明）。

---

## Part F · 待明确事项 / 风险登记（需主理人/用户拍板）

| # | 事项 | 现状结论 | 建议 | 需谁确认 |
|---|---|---|---|---|
| F1 | **导出 CSV 是否按占位处理** | 全仓无导出能力，settings 页同款 disabled 占位 | 按 Gap D 占位（本轮） | 主理人（默认占位） |
| F2 | **后端极小修复①：来源筛选**（约 5 行） | `SnapshotQueryDto` + `findAll` where 加 source 即可；不改 schema、无迁移 | **建议批准**：差异提示条 [仅看手工] 与筛选行依赖它；不批准则前端客户端过滤（仅当前页） | 主理人 |
| F3 | **后端极小修复②：删除回填**（约 3 行） | `SnapshotService.deleteRecord` 委托 `AssetValuationService.deleteRecord`（正确实现已存在） | **建议批准**：当前删除手工记录后事件日会残留 totalAsset=0（数据错误） | 主理人 |
| F4 | **后端极小修复③：重置语义**（约 3 行） | `SnapshotService.resetToDerived` 委托 `AssetValuationService.resetToDerived`（正确实现已存在） | **建议批准**：当前「重置」只改标记不恢复系统值，功能实际失效 | 主理人 |
| F5 | **该日系统自动计算值（derivedTotalAsset）** | 需 list 接口返回 computeDerived（批量性能未评估） | **本轮前端近似 + 注释**；精确化列为独立后端任务（非极小） | 主理人排期 |
| F6 | **差异提示条样式/近似口径** | SNAP-P0-07 ⑥ 顶部常驻条 | 用近似值实现 + 注释；若用户要求精确，须先做 F5 | 主理人/用户 |
| F7 | **收益分析页「← 返回」按钮** | 侧栏已提供导航 | 不加（保持全局一致性）；若坚持草图，加 `navigate(-1)` 轻量实现 | 主理人/用户 |
| F8 | **快捷范围下拉 + URL query 同步** | DASH-P0-02 验收 2/4 未落地（dashboard 也未做 URL 同步） | 本轮可选（P1）；若做，dashboard 与净值分析页应一并受益（DimensionSwitcher 增强） | 主理人排期 |
| F9 | **当年柱高亮** | DASH-P1-05 验收 2 | 低成本增强，T04 可选纳入 | 主理人 |
| F10 | **估值标记列 / 完整图例** | SNAP-P0-04b 验收 1 列了估值标记，§7.3 草图未列 | 本轮补底部图例（低成本）；估值标记列可选 P2 | 主理人/用户 |
| F11 | **「较年初」基准语义** | PRD 只定义 yearNav 基准（base_cumulative_nav），未精确定义 XIRR 较年初 | 按「当年首个计算日 XIRR」实现（Part E-6）；若产品想要「上年末 XIRR」，改一行取数 | 主理人/用户 |

---

## Part G · 任务验收清单（T05 用，逐条可勾）

1. 资产记录页：页头含「历史总资产记录」+ [导出 CSV]（disabled 占位）+ [＋ 新建记录]。
2. 资产记录页：顶部差异提示条显示「当前有 N 条手工记录，其中 M 条与自动值差异 > 1%」+ [仅看手工] 点击过滤（近似口径，注释说明）。
3. 筛选行：日期起止筛选生效（服务端）；来源 checkbox + [重置] 生效（客户端过滤，注释说明）。
4. 手工行差异列显示「系统 ¥x（+9,000.00 (+3.20%)）」；重置确认弹窗显示将恢复的自动值。
5. 新建/编辑弹窗：按钮「保存并重算」；日期不可未来；总资产必填；备注强提示；覆盖提示显示系统值；toast 为 PRD 详细文案。
6. 收益分析页：当前累计 XIRR + 较年初（独立于维度/范围，口径见 Part E-6）显示正确；XIRR 趋势 null 断线；年度柱状正红负绿；明细表含环比变化。
7. 组合切换（顶栏）后两页数据联动刷新。
8. 回归：`/snapshots?manage=1` 管理模式提示保留；删除/重置双入口文案区分（§7.3 L1188-1190）；无数据/加载失败四态不白屏。
9. 全仓无新增后端改动（除非 Part F 候选获批）；`api/types.ts` 无类型说谎（发送即 400 的字段不得出现在实际请求里）。
