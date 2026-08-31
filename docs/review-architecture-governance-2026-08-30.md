# 阶段 4 执行结果质量评审报告（架构治理规范）

> 评审对象：《架构治理规范》（`docs/架构治理规范.md`）＝《AI代码清理与瘦身实施计划》阶段 4 的执行产物。
> 评审方法：三方核验——实施计划阶段 4 的要求（§4.1~§4.4 提示词与清单） ↔ 治理规范条款 ↔ 实际代码/配置/脚本（git HEAD 实测）。
> 评审日期：2026-08-30。状态：评审意见，**未修改任何文档与代码**。

## TL;DR

治理规范整体结构完整（目录职责/依赖方向/依赖准入/行数上限/函数职责/微型化/提交闸门/执行清单八节齐全），落地物（`.cnb.yml`、`scripts/pre_commit_gate.py`、`scripts/check_line_budget.py`、`web/knip.json`、`backend/.importlinter`）均已核验存在且行为与文档基本一致。

共发现 **15 项问题**：实质性错误 3 项、遗漏 5 项、需补充完善 7 项。最严重的两项是：

1. **A1：`core/` 层"禁止 import 业务层"条款与存量代码直接冲突**——`core/scheduler.py` import 了 `app.services.*`，`core/security.py` import 了 `app.models`，且 `.importlinter` 未约束 core→上层。
2. **A2：`types/api.ts` 的"生成物/禁止手改/重新生成"声明与生成链断裂矛盾**——生成脚本 `web/scripts/gen-api-types.py` 的输入源 `docs/openapi.json` 已在第 14 轮（REP-051）删除，规范所描述的"重新生成"流程当前无法执行。

另有 2 处条款与存量代码脱节（前端 `components/`、`composables/` 边界），建议以"例外条款 + 存量登记"方式收敛，而非让绝对化条款持续失真。

---

## 一、问题清单总表

| # | 严重度 | 章节位置（治理规范） | 问题摘要 |
| --- | --- | --- | --- |
| A1 | 高 | §1.1 `core/` 行（L21） | "core 禁止 import 业务层（services/modules/models）"与存量代码冲突，import-linter 未覆盖 |
| A2 | 高 | §1.2 `types/api.ts` 行（L41）、§4 超限表（L77） | "生成物/禁止手改/改契约→重新生成"机制已断链（openapi.json 已删），无法按规范执行 |
| A3 | 中 | 《实施计划》frontmatter（L12） | status 仍停留在"阶段3收尾中"，未更新阶段 4 已完成状态，与正文阶段4执行记录矛盾 |
| B1 | 中 | 头部对应关系（L3） | 头部"对应阶段4（§4.1/§4.2/§4.4）"遗漏 §4.3（CI/CD 闸门），正文多处引用 §4.3 |
| B2 | 中 | §8 人工项（L119）+ `pre_commit_gate.py` MANUAL_CHECKLIST | 实施计划 §4.4 规则1"新增 export 至少一处使用"未在任何落地处体现（自动/人工均缺） |
| B3 | 中 | §1 整体 | 仅覆盖 `backend/app/` 与 `web/src/`，仓库根级目录（backend/web/docker/scripts/docs/dev-scripts/uploads/alembic）无职责约束，§4.1"每个顶层目录"未兑现 |
| B4 | 低 | §8 自动项（L117-118） | 未列前端类型闸门（vue-tsc app + typecheck:e2e），与 `.cnb.yml` frontend-lint 实际配置不一致 |
| B5 | 低 | §6 export 检查行（L94） | `web/knip.json` 的 `ignoreExportsUsedInFile: true` 未记录，影响将来 export 闸门口径 |
| C1 | 中 | §1.2 `components/` 行（L36） | "禁止 import 任何 modules/*"与存量冲突：AppLayout.vue 挂载 4 个 modules 组件、DateRangeQuickPicker.vue 引用 query/quick-range |
| C2 | 中 | §1.2 `composables/` 行（L34） | "禁止跨模块互相 import"过粗：存量 3 处（含 REP-045 刻意再导出），"取常量"与"复用逻辑"未区分 |
| C3 | 低 | §3-3（L67） | "Python 依赖一律钉死版本"与 pyproject 实际（akshare/pypinyin/apscheduler 为 `>=` 下限）措辞矛盾 |
| C4 | 低 | §4 超限表（L76-77） | 行数基线两处与实际不符：market_data_sync.py 1146→实测1148、admin/router.py 829→实测828 |
| C5 | 低 | §4 超限表（L77） | api.ts 的"生成物不适用400行"豁免随 A2 失效（实际为手写维护文件） |
| C6 | 低 | §2 依赖方向图（L52-57） | ASCII 图箭头语义易误读（core 与业务层关系表达不清） |
| C7 | 低 | 《实施计划》阶段4 §2 闸门口径表 + `check_line_budget.py` | "docs/*.md 不计入"表述窄于脚本实际（脚本排除**所有** `.md`） |
| C8 | 低 | §9 执行清单（L125） | "配置 CI/CD 闸门并验证生效"勾选 `[x]` 但真实 CI 首跑未做，勾选粒度易误读 |

---

## 二、详细问题与修改建议

### A 类 · 实质性错误（内容与事实不符）

#### A1. §1.1 `core/` 禁止 import 业务层 —— 条款与存量代码冲突 【高】

- **位置**：`docs/架构治理规范.md` §1.1 `core/` 行（L21）："禁止 import 业务层（services/modules/models）"。
- **证据链（实测）**：
  - `backend/app/core/scheduler.py:30,38-40`：`from app.models import ...`、`from app.models.enums import ...`、`from app.services.cleanup import CleanupService`、`from app.services.market_data_sync import MarketDataSyncService`。
  - `backend/app/core/security.py:23`：`from app.models import User`。
  - `backend/.importlinter` 仅声明 3 个契约（models_no_upward / services_no_routers / bottom_no_common），**无 core→上层 约束**——现状代码在 import-linter 下全绿，说明"core 不得依赖业务层"从来不是被强制的事实。
- **影响**：条款绝对化但核心模块即违反；AI agent 读到规范会误判"现状合规"或把规范当摆设；§2 依赖图"core 被任何层依赖"的假设与 scheduler 依赖 services 的现实矛盾。
- **修改建议（二选一，需 owner 裁决）**：
  - 方案甲（修订条款，成本低）：改为"core 允许 import `app.models`（ORM/枚举只读）；**禁止 import `app.modules`**；`scheduler` 属调度编排例外，允许依赖 `app.services`"。同步在 `.importlinter` 增加 `core_no_modules` 契约（core 禁依赖 modules），把已能自动化强制的部分落地。
  - 方案乙（维持严格条款）：将 `scheduler.py` 迁出 `core/`（如 `app/services/scheduler.py`）并登记为清理轮候选；但需评估调度器初始化时序与既有 import 面，成本更高。

#### A2. §1.2 `types/api.ts` "生成物/禁止手改/重新生成" —— 生成链已断裂 【高】

- **位置**：`docs/架构治理规范.md` §1.2（L41）："`types/api.ts`：**生成物**（`web/scripts/gen-api-types.py` 产出）；**禁止手改**；改后端契约 → 重新生成"；§4 超限表（L77）"web/src/types/api.ts(1021，**生成物不适用**)"。
- **证据链（实测）**：
  - `web/scripts/gen-api-types.py` docstring："so **docs/openapi.json** can be converted to web/src/types/api.ts without the CLI"——输入源是 `docs/openapi.json`。
  - `docs/openapi.json` **不存在**（`ls` 确认），已在第 14 轮 REP-051 删除；`web/src/types/api.ts:3` 头部自陈："docs/openapi.json 同步废弃；本文件仅保留 components"。
  - `web/src/types/api.ts` 仅含 `components`（operations/paths 已删）；若按规范"重新生成"，gen-api-types.py 会重新输出 operations 结构，与现文件不一致——重跑即产生破坏性 diff。
- **影响**：规范描述的维护流程（改契约→重新生成）当前**无法执行**；api.ts 事实上已是手写维护文件；"禁止手改"与"实际只能手改"直接矛盾。
- **修改建议**：将 §1.2 该行改为——"`types/api.ts`：**历史生成物、现人工维护**（生成链已断：输入源 docs/openapi.json 已废弃，REP-051）；改后端契约时须**人工同步 components 子集**；如需恢复自动化，先补后端 `/openapi.json` 导出并调整 gen-api-types.py 为 components-only 输出（排期项）"。§4 超限表同步删去"生成物不适用"（见 C5）。

#### A3. 《实施计划》frontmatter status 未更新至阶段 4 【中】

- **位置**：`docs/AI代码清理与瘦身实施计划.md` frontmatter（L12）：`status: 收尾中（阶段3·第14轮安全加固/缺失测试/废弃接口/门禁已落地；后续 BF-02/BF-03/DEL-02 缺陷修复 + alembic 漂移修复已提交；前端测试门禁已实证可用；待 owner 验收 + push）`。
- **证据**：正文已含"## 阶段4 执行记录（2026-08-30）"（L1019-1060，5 笔提交 + 四闸门落地 + ruff 基线归零 73→0）。
- **影响**：文档自洽性受损；AI/读者按 frontmatter 判断状态会误以为阶段 4 未做。
- **修改建议**：更新为如"阶段4 防反弹工程规则已落地（架构治理规范成文 + ruff/import-linter/knip/行数四闸门 + 真实 pytest 350 通过）；待 owner 审定规范 + push + CNB 流水线首跑确认"。

### B 类 · 遗漏（应覆盖未覆盖）

#### B1. 头部对应关系遗漏 §4.3 【中】

- **位置**：`docs/架构治理规范.md` L3："对应《AI代码清理与瘦身实施计划》阶段 4（**§4.1 架构规范 / §4.2 任务微型化 / §4.4 提交自动检测**）"。
- **证据**：正文 §3 标注"（§4.1-3 + **§4.3-2**）"、§6 标题"（**§4.3** 已规划未落）"、§8 依赖 §4.4——多处对应 §4.3，头部独缺。
- **修改建议**：补为"（§4.1 架构规范 / §4.2 任务微型化 / §4.3 CI/CD 闸门 / §4.4 提交自动检测）"。

#### B2. §4.4 规则 1"新增 export 至少一处使用"未落地（自动+人工均缺） 【中】

- **位置**：实施计划 §4.4 规则 1；治理规范 §8 人工项（L119）；`scripts/pre_commit_gate.py:33-38` MANUAL_CHECKLIST。
- **证据（实测）**：
  - `pre_commit_gate.py` 的 MANUAL_CHECKLIST 仅 3 项（依赖准入、防御性垃圾、单一职责），对应 §4.4 规则 2/3/4；
  - knip gate 参数 `--include dependencies,unlisted,files`（pre_commit_gate.py:93 与 .cnb.yml 一致），exports 未启用，§6 自承"未落"；
  - 而 REP-047/048（悬空转出口、13 死导出）恰是 export 类死代码——规则 1 正是针对该类问题的防线。
- **影响**：§4.4 四条提交前规则实际只落地三条；"新增 export 无人检查"成为防反弹盲区。
- **修改建议**：① §8 人工项补第 4 条"新增的每个 export 至少有一处使用（knip exports 未启用前的人工替代）"；② 同步 `pre_commit_gate.py` MANUAL_CHECKLIST 加该行（脚本改动为 1 处字符串，零风险）；③ 中长期启用 knip exports 时用存量 17 处豁免清单过渡（见 §6 既有记录）。

#### B3. 仓库根级目录职责未覆盖（§4.1"每个顶层目录一句话职责"未兑现） 【中】

- **位置**：`docs/架构治理规范.md` §1 整体——仅覆盖 `backend/app/` 与 `web/src/` 两张表。
- **证据**：仓库根存在 `backend/`（根）、`web/`（根）、`docker/`、`scripts/`、`dev-scripts/`、`docs/`、`uploads/`、`backend/alembic/` 等目录，均无职责/禁止事项条款。
- **影响**：AI 放错位置的典型风险无文字约束（如闸门脚本放 `scripts/` 还是 `dev-scripts/`、文档落 `docs/` 与 `docs/archive/` 的分界、alembic 迁移文件位置），与 §4.1 提示词"每个顶层目录一句话职责说明 + 禁止事项"的要求有差距。
- **修改建议**：新增 §1.3"仓库根级目录"（简短表格）：
  - `backend/`：Python 后端（应用代码在 `app/`，迁移在 `alembic/versions/`）；禁放前端/文档。
  - `web/`：前端（应用代码在 `src/`，e2e 在 `e2e/`）。
  - `docker/`：镜像构建与部署配置（Dockerfile / entrypoint / 生产 env 模板）。
  - `scripts/`：仓库级闸门/工具脚本（git 跟踪）；`dev-scripts/`：本地运维脚本（push-all 等），两者分工见项目记忆。
  - `docs/`：分析/方案/诊断 markdown；归档落 `docs/archive/`，ADR 落 `docs/adr/`；常显 ` M` 的 CRLF 假象文档不提交。
  - `uploads/`：运行期上传数据目录，不入库。

#### B4. §8 自动项未列前端类型闸门（vue-tsc app + e2e） 【低】

- **位置**：`docs/架构治理规范.md` §8 自动项（L117-118）。
- **证据**：`.cnb.yml` frontend-lint 含 `pnpm run lint`（vue-tsc app）与 `pnpm run typecheck:e2e`（L55-59）；§8 自动项仅列 ruff F / import-linter / knip / 行数预算 4 项。
- **影响**：本地 `pre_commit_gate.py` 清单与 CI 实际闸门不一致，AI 提交时不知道前端 typecheck 在 CI 侧强制。
- **修改建议**：§8 补一条"前端类型门禁（`vue-tsc -p tsconfig.app.json` + `-p tsconfig.e2e.json`，CI frontend-lint 执行；本地可 `pnpm run lint`/`typecheck:e2e` 预跑）"，或注明"本地闸门与 CI 闸门的完整对照见阶段4执行记录 §2"。

#### B5. knip.json 的 `ignoreExportsUsedInFile` 未记录 【低】

- **位置**：`docs/架构治理规范.md` §6 export 检查行（L94）。
- **证据**：`web/knip.json:4` `"ignoreExportsUsedInFile": true`——豁免"仅同文件内使用"的 export。
- **影响**：将来启用 knip exports 闸门时，该开关会显著改变检出口径（同文件自用 export 不报）；现在不记录则届时不透明。
- **修改建议**：§6 export 行补注"`web/knip.json` 已设 `ignoreExportsUsedInFile: true`（同文件自用 export 豁免），启用 exports 检查时口径以此为准"。

### C 类 · 需补充完善（不完整/不清晰）

#### C1. §1.2 `components/` 条款与存量冲突 —— 建议例外条款 + 存量登记 【中】

- **位置**：`docs/架构治理规范.md` §1.2 `components/` 行（L36）："禁止 import 任何 `modules/*`"。
- **证据（实测）**：`web/src/components/layout/AppLayout.vue:27-30` import 4 个 modules 组件（NotificationBell / PortfolioSelector / PortfolioDialog / PreferenceBootstrap）；`web/src/components/date/DateRangeQuickPicker.vue:40` import `@/modules/query/quick-range`。§1.2 底部注释亦自承"前端边界为约定 + knip 检测，尚未 AST 强制"。
- **修改建议**：条款细化为"纯展示组件禁止 import modules/*；`components/layout/` 等**组合容器**可挂载业务组件（AppLayout 现状即此模式）"；对存量 2 处登记为已知例外，待前端 AST 边界检查（§6 后续项）落地时一并豁免/重构。

#### C2. §1.2 `composables/`"禁止跨模块互相 import"过粗 【中】

- **位置**：`docs/架构治理规范.md` §1.2 `modules/<域>/composables/` 行（L34）。
- **证据（实测）**：存量 3 处跨模块 import——
  - `modules/overview/composables/use-query-data.ts:21` 从 analysis 再导出（**REP-045 刻意设计的共享模式**）；
  - `modules/portfolio/composables/use-portfolios.ts:27` 取 `PREFERENCE_KEY` **常量**；
  - `modules/security-price/composables/use-security-prices.ts:27` 取 `priceSyncStatusKey` **queryKey 常量**。
- **影响**：条款字面禁止一切跨模块 import，与"取常量"和"再导出"两类正当场景冲突；AI 会无所适从或误删。
- **修改建议**：细化为"禁止**复用他域 composable 的行为逻辑**；允许引用他域导出的常量/类型/queryKey，以及经显式再导出文件的符号"；存量 3 处按上述分类登记。

#### C3. §3-3"Python 依赖一律钉死版本"与 pyproject 实际矛盾 【低】

- **位置**：`docs/架构治理规范.md` §3-3（L67）。
- **证据**：`backend/pyproject.toml:27-33` akshare>=1.14、pypinyin>=0.53、apscheduler>=3.10 均为**下限约束**（非钉死），且均注明用途；钉死的是核心依赖（fastapi==0.141.1 等）。
- **修改建议**：措辞改为"核心运行时依赖**钉死版本**；可选/懒加载依赖可用下限 `>=`，但**必须注明用途**（现状 akshare/pypinyin/apscheduler 即此模式）"。

#### C4. §4 超限基线行数与实测不符 【低】

- **位置**：`docs/架构治理规范.md` §4 超限表（L76-77）。
- **证据**：`wc -l` 实测 `market_data_sync.py`=1148（规范写 1146）、`admin/router.py`=828（规范写 829）；其余 4 项吻合（api.ts 1021 / SchedulePage 902 / SettingsPage 884 / DashboardPage 775）。
- **修改建议**：复核并注明计量口径（`wc -l` 是否计入末尾无换行的最后一行 / 编写后是否又有改动）；加注"以 git HEAD 实测为准，季度复查时同步更新"。

#### C5. §4 超限表 api.ts"生成物不适用"豁免失效 【低】

- **位置**：`docs/架构治理规范.md` §4 超限表（L77）。
- **证据**：承接 A2——api.ts 实为手写维护文件，"生成物不适用 400 行"的前提不成立。
- **修改建议**：与 A2 一并修订为"历史生成物（现人工维护，1021 行）；400 行上限暂缓适用，恢复自动化生成后重新评估"。

#### C6. §2 后端依赖方向图可读性差 【低】

- **位置**：`docs/架构治理规范.md` §2（L52-57）。
- **证据**：ASCII 图中 core 与业务层关系用 `▲ │ ──▶ ◀────` 组合表达，易误读为"core 依赖业务层"（恰与 A1 的现状混淆）。
- **修改建议**：拆为两行清晰表述——"业务依赖链：modules → services → models / finance_core；横切依赖：任意层 → core（core 不得反向依赖业务层）"，或改用 mermaid。

#### C7. 行数闸门文档口径窄于脚本实际 【低】

- **位置**：《实施计划》阶段 4 §2 闸门口径表（L1040"docs/*.md 与锁文件/生成物不计入"）+ `scripts/check_line_budget.py`。
- **证据**：`check_line_budget.py:73` 排除条件为 `path.endswith(".md") or path.startswith("docs/")`——**所有目录下的 .md** 均不计入，不限于 docs/。
- **修改建议**：脚本 docstring 或治理规范 §4 口径提示改为"所有 `.md` 文件均不计入（非仅 docs/）；另排除锁文件与二进制生成物"。

#### C8. §9 "验证生效"勾选粒度易误读 【低】

- **位置**：`docs/架构治理规范.md` §9 执行清单（L125）。
- **证据**："[x] 配置 CI/CD 闸门并验证生效 —— .cnb.yml 四流水线 + 本地全绿；CNB 真实首跑待 push 后确认"——勾选"验证生效"与"真实首跑未做"并存。
- **修改建议**：拆为两条——`[x]` 闸门配置与本地静态校验（YAML 解析/锚点/脚本端到端）；`[ ]` CNB 流水线真实首跑确认（push 后）。

---

## 三、附：核验通过项（防止误伤，明确"未发现问题"）

以下条款经实测与代码一致，**无需改动**：

| 章节 | 条款 | 核验结论 |
| --- | --- | --- |
| §1.1 `models/` | 禁止 import services/modules | ✓ 全仓 grep 零违规 |
| §1.1 `finance_core/` | 禁止 import DB/ORM/HTTP/配置 | ✓ 仅 holding.py import `app.models.enums`（枚举，非表模型，建议 §1.1 补一句"枚举/常量可 import"以消歧义） |
| §1.1 `schemas` | 金额字段统一 DecimalStr（定义于 core/types.py） | ✓ `types.py:23` 定义，`schemas.py:15` import |
| §1.1 `common.py` | bottom_no_common 契约 | ✓ `.importlinter:27-33` 存在 |
| §1.1 `storage/` | 禁止 import 业务层 | ✓ 仅依赖 core.config 与自身 |
| §1.2 `api/` | 禁止 import components/modules | ✓ 全仓 grep 零违规 |
| §3-2 | knip 强制新增未使用依赖 fail | ✓ `knip.json` + CI/pre_commit_gate 均 `--include dependencies,unlisted,files` |
| §4 口径 | 400 行（人工约定）vs 800 行（脚本强制）区分 | ✓ `check_line_budget.py` DEFAULT_LIMIT=800 |
| §6 | 未落项（体积/覆盖率/缺测试标签/export） | ✓ 与 .cnb.yml 注释、实施计划阶段4 §2 一致 |
| §8 | 自动项四件套 | ✓ `pre_commit_gate.py:82-99`（ruff / import-linter / knip / line-budget） |

---

## 四、修订优先级建议

1. **立即修（高，先于 owner 审定）**：A1（core 条款二选一）、A2（api.ts 生成物表述）、B2（补 export 人工项，含脚本 1 行改动）、A3（frontmatter status）。
2. **随审定一并改（中）**：B1（头部补 §4.3）、B3（补仓库根级目录节）、C1/C2（例外条款 + 存量登记）。
3. **可并入季度复查（低）**：B4/B5、C3~C8。

> 备注：以上均为评审意见，未改动任何文档与代码。A1 的"方案甲/乙"需 owner 裁决后再落笔。
