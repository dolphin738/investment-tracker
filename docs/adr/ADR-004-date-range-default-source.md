> 本文档已落地·只读，作为架构决策记录（ADR），不再更新

# 架构决策记录：日期范围默认值单一真相源与优先级链（URL > 偏好 > 系统默认）（ADR-004 · I-04 / SET-P0-02）

> 架构师：高见远（Gao）
> 上游输入：增量 PRD I-04（默认日期范围全局化）+ QA 报告（commit `79f5d12` / `7f84906`，两轮 1080/1080 全绿）
> 关联裁决：§11 Q-5 / Q-6；关联契约 §4.2.16 / §10.1.6 / §10.1.8 / §16.7 / §16.9；关联代码 `dimension-switcher.tsx` `QUICK_RANGE_OPTIONS` / `use-default-date-range.ts` / `HoldingsPage.tsx`
> 状态：已落地（v2.8 并入主文档 `ARCHITECTURE.md`）

---

## 1. 背景与问题

全站 8 处范围型位置（概览趋势栏 / XIRR / NAV / 出入金 / 资产记录 / 现金余额历史 / 持仓统一筛选器 / I-06 新增位置）需要统一的「快捷范围」定义与一致的「默认范围」初始化逻辑。两个痛点：

1. **范围选项散落**：设置页曾自定义 `DATE_RANGE_OPTIONS`，与概览页 `QUICK_RANGE_OPTIONS` 可能漂移（取值域/文案不一致）。
2. **默认值初始化歧义**：默认范围应听谁的？URL 参数、用户偏好、还是系统固定值？若三者优先级不清，会出现「用户改了又被弹回」「换设备不一致」「URL 不落参」等问题。

第 1 轮回归中即暴露：**偏好对齐 effect 因缺少用户交互守卫，导致用户手动改 range 被弹回偏好默认值、URL 不写入 `range`**（源码 Bug，commit `7f84906` 修复）。本 ADR 将正确做法沉淀为架构红线。

## 2. 决策内容

### 2.1 快捷范围单一真相源

`QUICK_RANGE_OPTIONS`（`features/query/dimension-switcher.tsx`，7 项 `1w/1m/3m/6m/1y/ytd/all`）为**全站唯一**快捷范围定义。设置页删除本地 `DATE_RANGE_OPTIONS`，改 import 复用；新增范围型位置一律复用；`resolveQuickRange` 为唯一口径实现。grep 佐证全站无第二份范围数组。

### 2.2 默认值优先级链（URL > 偏好 > 系统默认）

```
effectiveDefault = URL 携带 range（或 from/to）        → 以 URL 为准（useUrlState 天然满足）
               否则 → UserPreference.defaultDateRange  → 偏好异步到达后对齐一次
               偏好为空/首次登录                        → '1y'（系统默认，非法/空值回落）
```

新增 `features/query/use-default-date-range.ts` 返回有效偏好默认（`'1w'|'1m'|'3m'|'6m'|'1y'|'ytd'|'all'`，非法/空回落 `'1y'`），各页将其作为 `useUrlState` 默认值。

### 2.3 ⚠️ 反模式警示：偏好对齐 effect 必须带用户交互守卫

偏好是**异步加载**的；首帧 schema 默认值已固化（系统默认 `'1y'`）。偏好到达后若在 effect 中无条件对齐，会覆盖用户**已经做的手动操作**。

**正确做法（HoldingsPage.tsx，commit `7f84906`）**：

- 声明 `rangeInteractedRef` / `closedInteractedRef`（用户交互守卫）。
- 统一筛选器变更**统一走** `handleFilterChange(patch)`：凡含 `range`/`from`/`to` 或 `closed` 即置对应 ref = `true`。
- 偏好对齐 effect 加守卫判断：
  ```ts
  if (hasRangeParam || rangeInteractedRef.current) return;   // URL 已带参 或 用户已主动操作 → 不覆盖
  // 仅当「偏好异步到达 + URL 无对应参数 + 用户尚未主动操作」时执行一次对齐
  setHoldingsQuery((prev) => ({ ...prev, range: defaultRange }));
  ```
- 顺带修复同型隐患 `closed`（显示已清仓）的潜在弹回。

**错误做法（第 1 轮 Bug）**：对齐 effect 依赖 `holdingsQuery.range` 且 `hasRangeParam` 用 `[]` 挂载固化 → 每次用户改 range 都触发对齐重置，将状态弹回偏好默认、URL 不落 `range`。

## 3. 决策依据

- **单一真相源**消除选项漂移，降低跨页不一致风险（I-04 验收「全站无第二份范围数组」）。
- **优先级链**符合直觉：URL 分享优先 > 个性化偏好 > 系统兜底；且偏好异步场景必须用守卫避免覆盖手动操作。
- **`defaultDateRange` 保持 `String` + 服务端 `@IsIn` 7 项白名单（裁决 Q-5）**，零迁移，与既有「String 字段承载前端选项」模式一致。
- **as-of 与日期范围口径独立（裁决 Q-6）**：as-of 仅驱动持仓板块精确回溯，日期范围仅驱动买卖明细/分红费用，二者不互相换算，本 ADR 仅约束「日期范围」默认值。

## 4. 后果

### 4.1 正向

- 8 处范围型位置默认行为一致，改偏好一处全局生效（I-04 验收全绿）。
- URL 分享可覆盖偏好（团队/多设备一致），偏好空回落系统默认，无白屏/抖动。
- 反模式警示写入 §10.1.8 / §16.9，后续新增范围型位置直接复用，规避回归。

### 4.2 负向 / 代价

- 偏好异步到达的「一次性对齐」需谨慎实现（守卫缺失即 Bug），已通过 `rangeInteractedRef`/`closedInteractedRef` 模式固化。
- 各页需显式接入 `use-default-date-range`（一次性改造成本，已在 I-04 任务中完成）。

## 5. 参考

- 主文档 §4.2.16（偏好 `defaultDateRange` 7 项白名单）、§10.1.6（URL key 规范）、§10.1.8(a)（全局化 + 反模式警示）、§16.7（URL 命名）、§16.9（偏好对齐 effect 模式 + 用户交互守卫）、§11 Q-5 / Q-6。
- QA 报告 §4（第 1 轮 Bug 与 `7f84906` 修复）、B.3（I-04 验收全绿）、B.4（I-05 含 range 联动）。
- 增量设计 `docs/archive/ARCHITECTURE-incremental-2026-08-07.md` §4.3 / §4.4 / §9.1 Q-5/Q-6。
