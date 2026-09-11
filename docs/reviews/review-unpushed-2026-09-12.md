# 未推送代码审查报告（2026-09-12）

- 审查人 role：CodeReviewExpert
- 范围：`cnb/main..HEAD` 共 **17 笔提交**（12 笔特性 + 5 笔索引快照）+ 工作树未提交改动
- 结论：**无 P0/P1 阻断项，可推送**；建议推送前补 M-1（零测试）与 M-2（强引用回归）

---

## 一、TL;DR

实现质量整体**高于项目平均**：P1 `response_fields` 正确落地了 4 个同步用途契约并配了约 1500 行测试；
新增实调预览端点的安全边界扎实（admin-only + 复用生产 SSRF 校验 + 不跟随重定向）；
行情回补的「强制 `slot=date` 才回补」是把新能力用在正地方的自愈护栏。

**但存在一处显著的不对称**：`response_fields` 序列测试密度极高，而同一批里的
**行情缺口回补（`fba3475`）新增 165 行服务方法 + 1 个 admin 端点 + 前端按钮，后端与前端均零测试**——
且该操作**写历史价格表**，出错会污染股息率曲线与排名。这是本轮最值得补的缺口。

---

## 二、提交清单

| 提交 | 内容 | 规模 |
| --- | --- | --- |
| `865bbfb` | docs(plan) 方案吸收审查意见 12 条 | 397 |
| `bfb3d63` | chore(gitignore) 忽略 coverage 并行产物 | 2 |
| `c462598` | **feat(quote-interface) response_fields 槽位解析 + 测试命中率（P1）** | 约 3800 |
| `fba3475` | **feat(dividend-yield) 行情缺口回补（路线 A）** | 311 |
| `cc68f6a` | feat(admin) stock_zh_a_hist 参数提示 | 8 |
| `cf61c24` | feat(quote-interface) 无 id SDK 实调预览端点 | 379 |
| `3d601b4` | feat(admin) 弹窗支持实调预填字段映射 | 460 |
| `ecfb5de` | feat(quote-interface) 实调预览支持 HTTPS 提供方 | 626 |
| `8b4d1e3` | feat(admin) 弹窗预填支持 HTTPS 提供方 | 390 |
| `c55893c` | chore(api) 重生成 openapi 与前端类型 | 154 |
| `6e761e2` | docs 字段映射配置指南 | 610 |
| `c195a86`/`6805ccf`/`72d6b59`/`7f3feb2`/`d2508cc`/`af01d1e` | 索引快照同步（6 笔） | — |

---

## 三、发现项

### 🟡 M-1｜行情缺口回补（`fba3475`）后端与前端**均零测试**（本轮最高优先级）

**证据**：`backend/tests/` 全目录 `grep gap_backfill|backfill-prices|缺口回补` → **无命中**；
`web/src/` 仅实现文件自身命中（`api.ts` / `types/api.ts` / `RankingPage.vue` / `use-dividend-yield.ts`），**无测试文件**。

**为什么重要**：该端点写 `market_security_daily_price`（历史价格表），是股息率曲线与排名的输入源。
`gap_backfill_daily`（`market_daily_price_sync.py:414`）有 5 条 fail-fast 分支与并发/幂等语义，
任一支出错都是**数据污染**而非简单功能失效。同批 `c462598` 为同等规模改动配了约 1500 行测试，反差明显。

**建议补（按价值排序）**：

| # | 用例 | 落点 |
| --- | --- | --- |
| 1 | `/backfill-prices` 401 未登录 / 403 非 admin | 契约（同 M-2 既有 `/backfill-specials` 写法） |
| 2 | 接口未配 `slot=date` → fail-fast 拒绝回补 | `market_daily_price_sync.py:444-448` |
| 3 | `access_method != https` → 拒绝并给中文原因 | `:437-442` |
| 4 | 单日失败不回滚其它日（每日独立 commit） | `_one_day` 异常聚合路径 |
| 5 | `lookback_days` 钳制边界（0 / 负数 / >400） | 路由 `:656` + 服务层 `:456` 双重钳制 |
| 6 | 前端按钮 admin 可见、点击触发、非 admin 不渲染 | 同 M-3 契约 |

---

### 🟡 M-2｜新端点 fire-and-forget 未持有强引用（**已收敛债务的回归**）

- 位置：`backend/app/modules/dividend_yield/router.py:667`
- 现状：`asyncio.create_task(_runner())` 裸调用，未保存 task 引用。
- 对比：`portfolio/router.py:124`、`scheduler.py:342` / `:454` 均已统一走 `_track_task`
  （模块级 `_BG_TASKS` set + `add_done_callback(discard)`）——这是此前已收敛的债务，**本端点是新增代码、漏网**。
- 风险：Python 官方建议持有运行中 Task 的强引用，否则可能在完成前被 GC 回收（长耗时回补场景风险更高）。
- 建议：把 `_track_task` / `_BG_TASKS` 提到公共位置（如 `app/core/bg.py`）后统一调用，避免第三处复制。
- 注：同文件 `/backfill-specials`（`:613`）走 `run_task_now` → 已 tracked ✅，仅新端点漏。

---

### 🟡 M-3｜方案 §4.1 表与 §6 `SLOT_CONTRACT` 对 `name`/`exchange` 必填性**表述不一致**

- 方案 §4.1 表把 `name` / `exchange` 列为「必填用途 `MASTER_LIST`」；
- 但 §6 `SLOT_CONTRACT` 与实现 `response_fields.py:72-76` 均只强制 `code`：
  `MASTER_LIST: {code}` / `QUOTE: {code, price, date}` / `DIVIDEND_LIST: {code}` / `NOTICE: {code}`。
- **实现取的是保守且正确的一支**（有兜底的槽不强制，见 §6「仅强制无兜底的槽」），
  但方案表会误导后续维护者以为 `name`/`exchange` 会被校验拦截。
- 建议：§4.1 表把 `name` / `exchange` 两行改为「非强制（有兜底，契约层不拦截）」。

---

### 💭 L-1｜工作树存在**未提交的删除**

- `docs/字段映射配置指南.html`（`6e761e2` 刚加入）在**工作树被删除但未提交**（`git status` 为 ` D`）。
- 若属有意（`.md` 为源、`.html` 为渲染产物），应显式 `git add -A` 提交删除；
  否则后续任何 `git add -A` 会误纳此删除。请确认意图后处理。

### 💭 L-2｜索引快照夹杂

6 笔索引快照穿插特性之间，符合 2026-09-07「索引快照随提交同步」指令 ✅；
`graph.db.zst` 约 3.8MB 二进制每笔产生大 diff，属预期，非问题。

---

## 四、✅ 做得好的地方

1. **P1 契约正确落地 4 个同步用途**：`response_fields.py:65-76` 定义
   `MASTER_LIST/QUOTE/DIVIDEND_LIST/NOTICE` 与 `SLOT_CONTRACT`，**分红与公告未漏**（此前审查的阻断项已闭环）；
   配套 5 套测试（fields / path / api / equivalence / guardrail + QA 回归）约 1500 行。
2. **实调预览安全边界扎实**：
   - 鉴权 `Depends(require_admin)`（`admin/router.py:889`）✅
   - 复用生产 `_fetch_https_raw`，共享 `assert_safe_url` SSRF 校验（`market_data_sync.py:522`）✅
   - **全仓无 `follow_redirects` 设置** → httpx 默认**不跟随重定向**，
     故不存在「校验 base_url 后被 302 带到内网」的绕过，SSRF 被限制在已校验的 `base_url` 内 ✅
   - 不写库、不计 `consecutive_failures`、`retry_count=0`、不限流，探测语义干净 ✅
3. **回补自愈前提校验优秀**：强制接口配 `slot=date` 才回补
   （`market_daily_price_sync.py:444-448`），避免把陈旧价写进历史日期——新能力的正确用法。
4. **`lookback_days` 双重钳制**：路由 `:656` 与服务层 `:456` 各钳一次，防 DoS，纵深防御 ✅
5. **两个回补按钮都有二次确认**：`RankingPage.vue:330-353`（特别分红）与 `:355-379`（行情缺口），
   延续 L-4 做法，描述里还写明了「行情接口无历史查询能力」的能力边界 ✅
6. 小提交（参数提示、预填）也都带了测试，无裸改。

---

## 五、验证状态

| 项 | 状态 |
| --- | --- |
| 代码事实核对 | 逐条 `Read`/`Grep` 实测（非凭记忆） |
| 契约与方案一致性 | ✅ 4 用途契约一致；⚠️ §4.1 表文案不一致（M-3） |
| 安全（鉴权 / SSRF / 重定向 / 输入钳制） | ✅ 均无问题 |
| 测试覆盖 | ⚠️ `fba3475` 零测试（M-1） |
| 本轮是否跑全量测试 | 否（本轮为审查，未改代码） |

---

**一句话**：可推送，但**行情缺口回补这条写历史价格表的链路目前零护栏**——这是本轮唯一实质风险点，
建议按 M-1 表格补齐后再推；M-2 顺手修，M-3 改方案文案，L-1 确认删除意图。
