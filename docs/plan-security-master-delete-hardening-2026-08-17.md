# 证券主数据删除策略对比：如何「删主数据不丢持仓」

> 适用范围：`securities`（系统级主数据目录表）的删除，如何保证用户的组合持仓
> （`portfolio_securities` 及其 trades/prices/dividends）**永不因删主数据而被级联清除**。
> 本文为方案对比（评审用），落地需你确认选项后再动代码。

---

## 0. 现状与残余风险

当前唯一保护机制 = **应用层孤儿守卫**（`backend/app/modules/admin/router.py`
`delete_security_masters`，717–788 行）：

- 删除前查 `PortfolioSecurity.master_id` 引用集合，被引用的主数据转入 `skipped`
  （reason：*已被组合持仓引用，删除将级联清除用户数据，已跳过*），**只物理删除孤儿**。
- FK 定义：`portfolio_securities.master_id → securities.id ON DELETE CASCADE`
  （`backend/app/models/security.py` 88–92）。CASCADE 仅在「被引用行被删」时才级联清子行。

**残余风险（为什么还要出方案）**：孤儿守卫是**唯一**防线，且只在
`DELETE /securities/masters` 这一个入口生效。任何绕过它的路径——裸 SQL、未来新端点、
迁移脚本、管理台误操作——一旦 `DELETE FROM securities WHERE id=<被引用>` 命中，
CASCADE 会**物理删除用户的组合持仓/交易/价格/分红**（trades/prices/dividends 都挂在
`portfolio_securities.id` 下，随祖父级联归零）。**数据库层没有任何兜底**。

**确定性 id 的定位（贯穿本轮纠正）**：`uuid5(asset_class, code)`，迁移
`q9a8b7c6d5e4_deterministic_security_master_id.py` 落地。它解决的是**身份稳定**，
不是**数据存活**：保证删除后再同步会得到同一 id，使 `master_id` 引用可重建——但前提是
**持仓行在删除时刻没有被 CASCADE 清掉**。故确定性 id 不能替代孤儿守卫，只能让
「守卫生效后残留的孤儿主数据」重同步时身份一致。两者正交。

---

## 1. 三方案对比矩阵

| 维度 | 现状（仅孤儿守卫） | A. 软删除 | B. 持仓改自然键挂接 | C. FK 改 RESTRICT |
|---|---|---|---|---|
| DB 级兜底 | ❌ 无 | ✅ 物理行永不删，CASCADE 永不触发 | ✅ 无 FK，删主数据不触及持仓 | ✅ 删被引用行直接报错回滚 |
| 改动面 | — | 中：加列 + 全读路径加 `is_deleted` 过滤 + 部分唯一索引 + upsert 改清除标记 | 大：改 `portfolio_securities` 模型/迁移/所有 JOIN/序列化 | 小：1 处 FK `ondelete` + 1 迁移 |
| 对确定性 id | 依赖其稳定身份 | 兼容（重同步按自然键命中即清除 `is_deleted` 复活） | 部分冗余（自然键即链接键，id 退化） | 完全兼容、无影响 |
| 持仓显示 name/exchange | ✅ JOIN 主数据 | ✅ 同现状 | ⚠️ 主数据删后 JOIN 得 NULL，需反规范化快照或保留主数据 | ✅ 同现状（被引用根本删不掉） |
| 可逆/可恢复 | ❌（仅守卫拦下的被跳过，真删不可恢复） | ✅ 标记可还原 | ❌ 同 CASCADE（无 FK 但主数据物理删仍丢 name） | ✅ 删不动=永不丢 |
| 与现有孤儿守卫关系 | 即守卫本身 | 可并存（守卫管 UX 跳过，软删做底层保险）；也可独自成立 | 守卫退化为「按自然键查引用」 | 守卫管 UX 跳过，RESTRICT 做 DB 硬兜底（纵深防御） |
| 实施风险 | — | 中：漏改任一读路径会泄漏已删行 | 高：触碰刚稳定的拆表模型 | 低：纯约束变更 |

---

## 2. 方案详述

### A. 软删除（`is_deleted` / `deleted_at` 标记）

- **做法**：`securities` 加 `is_deleted`(bool, default false) + `deleted_at`(timestamptz)。
  `delete_security_masters` 改为 UPDATE 标记而非 DELETE。列表/统计/同步去重/估值等所有读
  `securities` 处加 `WHERE is_deleted IS NOT TRUE`。
- **唯一约束**：`uq_securities_asset_code`（`security.py` 43 行，作用于 `(asset_class, code)`）
  须改为**部分唯一索引** `WHERE is_deleted IS NOT TRUE`，否则软删后重同步插同 `(asset_class, code)`
  会撞唯一约束。
- **同步 upsert**（`market_data_sync._upsert_masters`，948–1007 行）：当前按 `(asset_class, code)`
  查到即 UPDATE 属主字段——软删后仍能查到该行，只需在命中分支额外 `existing.is_deleted = False`
  （及清 `deleted_at`）即「复活」，无需重插。
- **优点**：物理行不删 → CASCADE 彻底失效，持仓**永远安全**；删除可逆、可审计、可「回收站」UX。
- **缺点**：每个读 `securities` 的路径都要记得过滤（漏一处就泄漏已删行）；唯一约束改部分索引；
  软删行长期堆积（可定时物理清理）。
- **对确定性 id/同步**：完全兼容，且因重同步按自然键命中已删行并清除标记，恢复体验最自然。

### B. 持仓改按自然键 `(asset_class, code)` 挂接

- **做法**：`portfolio_securities` 去掉 `master_id` FK，改为持有 `(asset_class, code)`；需读
  name/exchange 时 JOIN `securities ON (asset_class, code)`。删主数据行不再有 FK 牵连，持仓毫发无伤。
- **优点**：主数据真正「可弃」，删它不影响持仓；重同步重建主数据后持仓自动按自然键重新 JOIN 上。
- **缺点**：
  - **显示塌方**：主数据被删后，持仓的 name/exchange JOIN 得 NULL，列表/估值显示丢失证券名——
    除非在 `portfolio_securities` 反规范化存 name 快照（又一轮改模型+迁移+同步写入）。
  - **与确定性 id 部分冗余**：自然键本就是 `master_id_for` 的输入，去掉 surrogate FK 后 id
    退化成可选冗余字段。
  - **改动最大**：刚落地的 ADR-003 拆表模型（`security.py` 88–112）要重做 JOIN 与序列化，
    所有 `master` 反向引用、`serialize_security_master` 全要改。
- **结论**：在已具备确定性 id 的前提下，B 是**过度设计**——它想解决的「删主数据不丢持仓」，
  C 用一行约束就做到了，且不影响显示。

### C. FK 改 `RESTRICT`（纵深防御）

- **做法**：`security.py` 90 行 `ondelete="CASCADE"` → `ondelete="RESTRICT"`（等价 NO ACTION），
  并写 Alembic 迁移 `ALTER TABLE portfolio_securities DROP CONSTRAINT …; ADD CONSTRAINT …
  ON DELETE RESTRICT`。
- **效果**：任何路径（含裸 SQL）试图删除**被引用**的主数据行，PG 直接抛 `IntegrityError` 并回滚
  事务——持仓物理删绝不可能发生。
- **与现有守卫的关系**：守卫负责「UX 层跳过被引用项（进 skipped）」；RESTRICT 负责「DB 层硬兜底，
  万一守卫被绕过也删不动」。两者纵深防御，互不冲突。
- **优点**：改动极小（1 处模型 + 1 迁移）；零读路径改动；完全兼容确定性 id 与同步 upsert；
  被引用主数据「删不掉」= 用户数据永不丢，且天然可逆。
- **缺点**：是「硬失败」而非「软跳过」——但若守卫正常工作，用户根本不会触碰到 RESTRICT
  （守卫先拦）；只有守卫失效时 RESTRICT 才发声（这正是我们要的兜底）。不提供「已删可恢复」
  的回收站能力（非本项目当前诉求）。

---

## 3. 推荐

**首选 C（FK 改 RESTRICT）作为本次必做**：它是现行孤儿守卫的 DB 级兜底，改动最小、风险最低、
收益最高，彻底堵死「绕过入口删主数据 → 级联清持仓」的残余风险。

**A（软删除）作为可选增强**：若后续要做「删除可恢复 / 回收站 UX / 审计」，再上 A。A 本身已能让
CASCADE 彻底失效，比 C 更强但成本更高，非当前阻塞项。

**B 不推荐**：在确定性 id 已就位的前提下属于过度设计，且会引发显示塌方（name 丢失）或被迫反规范化，
得不偿失。

> **关键认知（贯穿本轮纠正）**：确定性 id 解决「身份稳定」，孤儿守卫 / C / 软删解决
> 「数据存活」。三者正交、不可互相替代。当前「确定性 id + 孤儿守卫」已覆盖正常入口；
> C 是把「守卫」这条唯一防线从「应用层」补到「数据库层」。

---

## 4. 若选 C 的落地草案（待确认后实施）

1. `backend/app/models/security.py` 90 行：`ondelete="CASCADE"` → `ondelete="RESTRICT"`。
2. 新建 Alembic 迁移（幂等 / 漂移容忍，参照 `o3d4e5f6a7b8_reform_2_categories` 范式）：
   - 动态读 FK 约束名后 `ALTER TABLE portfolio_securities DROP CONSTRAINT <name>`；
   - `ALTER TABLE portfolio_securities ADD CONSTRAINT portfolio_securities_master_id_fkey
     FOREIGN KEY (master_id) REFERENCES securities(id) ON DELETE RESTRICT`；
   - 全程 `IF EXISTS` 守卫，对齐「上游迁移之后」的真实结构，避免与全新迁移路径 schema 漂移。
3. 测试：`backend/tests/test_stock_master_and_resolve.py` 增补——
   - 构造「被持仓引用的主数据」，断言 `delete_security_masters` 仍走 `skipped`；
   - 新增直接 `DELETE` 该主数据的负向用例，断言抛 `IntegrityError`（RESTRICT 生效）。
4. 文档：`docs/PRD.md` / `ARCHITECTURE` 同步「删除保护 = 孤儿守卫（应用）+ RESTRICT（数据库）纵深防御」。
5. 沙箱 git 限制：落盘后由你本地提交（backend 一 commit，作者 `senior-dev`，不 push）。

---

## 5. 待你拍板

- 是否采用 **C（RESTRICT）** 作为本次落地？
- 是否同时做 **A（软删除）**（当前非阻塞，建议留待「回收站/审计」需求出现时再做）？
- **B** 默认不采纳，除非你有特别理由（如主数据需要频繁物理清理）。
