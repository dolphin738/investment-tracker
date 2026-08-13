> 本文档作为架构决策记录（ADR）。2026-08-13 经用户要求"先写成 ADR 锁定"创建；同日修订：方案 X 补充并锁定"**完全移除全局单一活跃源（含 `is_active`/`is_default` 开关），提供方仅保留 `enabled`（启动/停用）唯一开关**"。3 个运维细节仍列为待确认项（默认建议，实现前定稿，不视为已锁定决策）。

# 金融数据接口采用"分类级接口优先级链 + 顺序 Fallback + 连续失败告警"（ADR-002）

> 架构师：dolphin738 ｜ 上游输入：多提供方证券行情数据提供方（系统管理页）+ 实时行情消费端（方向 2）｜ 状态：核心决策已收口，待实现
> 变更性质：**行情接口解析模型演进**（全局单一活跃源 → 分类级接口优先级链；全局开关完全移除），触及 `QuoteInterface` / `SecuritiesDataProvider` 数据模型与 `MarketDataSyncService` 消费端，不改动估值/NAV 计算口径
> 全部结论均基于本次实际代码核实（`backend/app/models/*`、`services/quote_provider.py`），非记忆推断

---

## 0. 决策现状核实（先于记录）

| 项 | 位置（实际代码） | 状态 |
|----|------------------|------|
| 提供方模型 | `backend/app/models/quote_provider.py`：`is_default` / `is_active` / `enabled` | ✅ 全局 provider 级开关（决策后：**仅保留 `enabled`**，另两列完全移除） |
| 接口模型 | `backend/app/models/quote_interface.py`：`provider_id`(CASCADE) / `category_id`(SET NULL, index) / `enabled` / `timeout` / `retry_count` / `params` | ✅ 已具备 fallback 所需超时字段 |
| 分类模型 | `backend/app/models/interface_category.py`：`label` / `icon` / `sort_order` | ✅ `sort_order` 仅分类间展示序，非分类内接口优先级 |
| 当前解析链 | `backend/app/services/quote_provider.py:get_active_provider`：`is_active → is_default → None` | ⚠️ provider 维度、全局只选一个提供方 |
| 缺口 G1 | `backend/app/models/security.py`：无 `category_id` | ❌ 证券↔接口分类映射缺失 |
| 缺口 G2 | `QuoteInterface`：无 `resp_code_field` / `resp_price_field` | ❌ 响应字段映射缺失 |

**结论**：分类（`category_id`）是跨提供方的共享键，前端"汇总总览"本就按分类聚合所有提供方接口——新需求"按分类汇总"天然成立。但 `QuoteInterface` 无优先级字段、`Security` 无分类映射、无响应字段映射，且当前解析模型是"全局单一活跃源"，与新需求（接口级、跨 provider、按分类优先级链）直接冲突，需演进。

---

## 1. 背景与问题

需求：按分类汇总所有提供方接口 → 同分类接口按位置从上到下优先级递减；查询从最高优先级开始，有响应即停、无响应顺次下探；最高优先级连续多次无响应触发提醒；列表支持拖拽上下调序改变优先级。

现状矛盾点：
- 现有 `get_active_provider` 是 **provider 维度、全局只选一个提供方**，然后只用它的接口。这与"按分类、跨所有提供方、接口级优先级链"语义不符。
- `QuoteInterface` 没有表达优先级的字段，跨提供方同分类接口无法排序。

---

## 2. 决策内容

| 项 | 决策 | 理由 |
|----|------|------|
| 优先级模型 | **方案 X：分类级接口优先级链**（见 §2.1） | 最贴合"按分类汇总所有提供方接口"语义 |
| 全局活跃源定位 | **完全移除**：`is_active`/`is_default` 开关及 `get_active_provider` 解析链一并删除，不保留旗标 | 提供方仅保留 `enabled`（启动/停用）唯一开关，杜绝双模型并存 |
| 优先级落点 | `QuoteInterface.priority`（int，按 `category_id` 排序） | 单一字段同时驱动展示序与 fallback 序 |
| 健康状态 | `QuoteInterface.consecutive_failures` + `alerted`（DB 持久化） | 多实例安全、重启不丢 |
| 调序交互 | 前端同分类 dnd → `PATCH /quote-interfaces/reorder` | 展示序与优先级同源，避免两套顺序 |

### 2.1 优先级模型：采用方案 X（关键决策，已锁定）

**完全移除"全局单一活跃源"模型**（含 `is_active` / `is_default` 开关），改为按 `category_id` 解析接口优先级链：

> 查询某分类行情时，拉取该 `category_id` 下所有 `enabled=true` 的接口，按 `priority` 升序即优先级，从最高（最小 priority 值）开始顺序调用，有响应即停止。

- `SecuritiesDataProvider` 仅保留 `enabled`（启动/停用）**唯一开关**；`is_active` / `is_default` 两列、`get_active_provider` 解析链、`set_default` / `set_active` service 方法、router `set-default` / `set-active` 端点及前端「默认/当前」徽标、开关、编辑表单字段**全部移除**（不留兼容旗标）。
- 影响：方向 2 的调用方不再经 `get_active_provider`，直接改为 `MarketDataSyncService.fallback_fetch(category_id, ...)`；并需先解决缺口 G1（证券↔分类映射），否则无法确定"某证券走哪个分类的链"。

### 2.2 数据模型变更（迁移 `alembic upgrade head`）

`QuoteInterface` 新增三列，`SecuritiesDataProvider` 移除两列：

| 表 | 变更 | 类型/默认 | 用途 |
|----|------|-----------|------|
| `quote_provider_interfaces` | +`priority` | Integer, nullable | 分类内排序，越小优先级越高；重排事务内批量重排 `UPDATE ... SET priority = CASE id WHEN ... END` |
| `quote_provider_interfaces` | +`consecutive_failures` | Integer, 默认 0 | 连续无响应计数，原子自增 |
| `quote_provider_interfaces` | +`alerted` | Boolean, 默认 false | 告警去重抢占标志 |
| `securities_data_providers` | **-`is_active` / -`is_default`**（DROP COLUMN） | — | 全局活跃源开关移除，仅保留 `enabled` |

约束：`(category_id, priority)` 建议唯一（或全局唯一+排序）；重排时若 DB 不支持批量 CASE 改值，用中间临时值法避免唯一冲突。

### 2.3 顺序 Fallback 查询语义

- 入口：`fallback_fetch(category_id, codes=...)`，按 priority 升序逐条调用。
- 每跳使用接口已有 `timeout`（缺省给全局默认，建议 ≤5s），并设**单链总超时预算封顶**（建议 ≤8s，避免最坏延迟 = Σtimeout 随链长线性爆炸）。
- **"有响应即停止"是顺序语义**：不改为并行 race（会浪费上游配额、触发限频）。仅当明确要降延迟时再评估并行 + 取首成功。
- 全链失败：沿用上一条 `SecurityPrice` / `avg_cost`，**不阻塞重算**（与方向 2 回退一致）。
- 并发：同 `category_id` 加 `asyncio.Lock`（多实例则分布式锁）序列化；可加 `last_good_interface_id` 缓存跳过已知死节点（带 TTL 防陈旧）。

### 2.4 连续失败计数与告警

- 失败（无响应，定义见 §3）：`UPDATE ... SET consecutive_failures = consecutive_failures + 1 WHERE id=?`（DB 原子自增，多实例安全）。
- 成功（有响应）：`consecutive_failures = 0`。
- 达阈值（`N`，默认建议 3）且 `alerted=false`：`UPDATE ... SET alerted=true ... RETURNING` **抢占**，保证多实例下仅一个实例发告警；人工恢复或成功一次后 `alerted` 复位。
- 提醒落点见 §3（待确认）。

### 2.5 拖拽调序与优先级联动

- 前端 dnd（dnd-kit / @hello-pangea/dnd）产生同分类内新顺序数组 `[id1,id2,...]` → `PATCH /api/admin/quote-interfaces/reorder` 传 `{category_id, ordered_ids}` → 后端事务内重排 `priority`。
- **拖拽仅限同分类内上下移动，不改 `category`**（否则会把接口挪到别的分类、改变所属链）。
- 双 admin 并发拖拽：低频场景用 last-write-wins + 前端实时刷新即可，无需乐观锁。
- 展示序与 fallback 优先级是**同一字段 `priority`**，杜绝两套顺序不一致。

---

## 3. 待确认项（实现前定稿，非锁定决策，附默认建议）

| # | 项 | 默认建议（待用户最终确认） |
|---|----|----------------------------|
| Q1 | "无响应"精确边界 | 超时 / 连接错误 / HTTP 5xx / 鉴权失败 = 无响应（向下）；HTTP 200 但业务返回空 = 有响应（停止，数据空另行处理） |
| Q2 | 告警落点 | MVP：管理面站内信 + 前端红点；后续可加邮件。落点需明确以免影响"抢占去重"实现 |
| Q3 | 实时秒回策略 | 实时展示用 `last_good` 缓存秒回 + 后台异步 fallback 刷新；同步"刷新行情"按钮走完整链（避免点开组合卡 Σtimeout） |
| Q4 | 失败阈值 N | 默认 3 次连续无响应触发告警（可在接口/全局配置） |

> 以上 4 项为运维细节，不推翻 §2 的核心架构决策；实现前由用户确认后写入本 ADR 或独立配置。

---

## 4. 后果与回退

| 维度 | 影响 | 处理 |
|------|------|------|
| 现有 `get_active_provider` / `is_active` / `is_default` | **完全移除**（函数、两列、`set_default`/`set_active`、`set-default`/`set-active` 端点、前端徽标/开关/表单字段），不留兼容旗标 | 消费方迁移到 `fallback_fetch(category_id)`；提供方启停统一走 `enabled` |
| 数据模型 | `QuoteInterface` 加 3 列 + `SecuritiesDataProvider` 删 2 列 + 迁移 | `alembic upgrade head` 同步开发/测试库 |
| 延迟 | 顺序 fallback 最坏延迟 = Σtimeout | 单链总预算封顶 + 实时场景 last-good 秒回 |
| 多实例 | 计数/告警/调序需 DB 原子保证 | 全部走 DB 列 + 事务，不用内存计数 |
| 复杂度 | 同分类接口多来自同一 provider 时"跨 provider 优先级"价值有限 | 仍实现（需求明确要求跨 provider 汇总），实现成本低 |
| 回退 | 如需回退到全局活跃源模型 | 从 git 历史恢复 `is_active`/`is_default` 两列与 `get_active_provider`（`DROP COLUMN` 后需重建列，配置数据可能丢失，接受该风险以换取单一开关模型） |

---

## 5. 落地范围（分阶段，建议顺序）

1. 数据模型：`QuoteInterface` 加 `priority` / `consecutive_failures` / `alerted`，`SecuritiesDataProvider` 删 `is_active` / `is_default` + Alembic 迁移；同步移除 service `set_default`/`set_active`/`get_active_provider`、router `set-default`/`set-active` 端点与 schema 字段、前端「默认/当前」徽标/开关/表单字段。
2. `MarketDataSyncService.fallback_fetch(category_id)`：顺序链 + HTTPS 路径（先用 mock/respx 跑通）；复用方向 2 的 `upsert SecurityPrice` + `recalculateRange`。
3. `PATCH /quote-interfaces/reorder` 端点 + 前端同分类 dnd 调序。
4. 告警落地（按 §3 Q2 落点）+ 抢占去重。
5. SDK 路径（akshare 依赖）+ 可选定时任务（收盘后刷新）。
6. pytest 全绿后提交（沿用 `senior-dev`，不 push）。

> 依赖前置：方向 2 的缺口 G1（证券↔分类映射）、G2（响应字段映射）须与本 ADR 一并规划，否则"拉回的价"无法落到正确证券。

---

## 6. 参考

- `backend/app/models/quote_provider.py` — 提供方模型（决策后仅保留 `enabled`；`is_active`/`is_default` 将移除）
- `backend/app/models/quote_interface.py` — 接口模型（缺 priority / resp 字段，需扩展）
- `backend/app/models/interface_category.py` — 分类模型（sort_order 仅分类间序）
- `backend/app/models/security.py` — 证券模型（缺 category_id，G1 缺口）
- `backend/app/services/quote_provider.py:get_active_provider` — 当前解析链（决策后移除，消费方改直连 `fallback_fetch`）
- 方向 2 设计（实时行情消费端：`get_active_provider` → `fallback_fetch` + upsert SecurityPrice + recalculateRange）
- `docs/quote-provider-setup-examples.md` — 小熊同学 / AKShare 填写示例（响应结构差异佐证 G2 需接口级字段映射）
- 本地留痕（非仓库）：`.workbuddy/memory/2026-08-13.md`「金融数据接口优先级链可行性评估」段
