# AGENTS.md — AI 协作常驻指令（仓库级，随克隆传播）

本文件供 AI 编码助手（WorkBuddy / CodeBuddy / Cursor / Claude 等）在本仓库工作时读取。
内容均为**已审定的项目约定与治理约束**，非建议性。

---

## 0. 项目概览

- **投资回报追踪器** monorepo：Python 后端（`backend/`，FastAPI + SQLAlchemy 2.0 + PostgreSQL）+ **Vue3** 前端（`web/`，Vite + Pinia + vue-query + vee-validate）。
- 权威远端：`cnb`（cnb.cool）；`github` 仅镜像，**非推送目标**。
- 工作流：改动完自动提交（Conventional Commits，作者 `senior-dev <dev@local>`）；**agent 不主动 push**。

---

## 1. 架构治理规范（已审定生效，2026-08-31｜写码前触发式预读）

**文档**：`docs/架构治理规范.md`（状态：已审定生效；owner 审定后「禁止」类条款即日起由 CI 四流水线 + `scripts/pre_commit_gate.py` 强制）。

**触发式预读（轻量，落地 A）**：AI 写/改代码时，**仅当触及以下场景**才必须先 `Read docs/架构治理规范.md` 核对对应章节，再动手；其余情况交给 CI/提交闸门，不重复预读：

| 触发场景 | 核对章节 |
| --- | --- |
| 新建文件 / 大改存量文件 | §4 单文件 ≤400 行（**人工约定，CI 不拦**）、§1 目录职责 |
| 新增/升级依赖（npm/pip） | §3 依赖准入（「为何现有能力做不到」自证）、§8 行数预算 |
| 动前端模块边界（pages/components/composables/api 间调用） | §1.2 / §2 前端边界（**仅约定 + knip，CI 未 AST 强制**，最易漏） |
| 改 services/modules/models 依赖方向 | §2 调用边界 + `.importlinter` 契约（`core_no_business`/`bottom_no_common`） |
| 提交前 | 必跑 `python scripts/pre_commit_gate.py`（slow 项按需 `--only coverage fe-coverage bundle`） |

**预读只为覆盖 CI 静默放行的盲区**：单文件 400 行、前端边界、函数单一职责（§5）、依赖自证叙述（§3）、任务微型化（§7）。机器可查项（knip/ruff/import-linter/覆盖率/体积/行数预算）由闸门拦，不必预读。

---

## 2. 工程闸门（CI + 本地提交强制）

脚本均在仓库根 `scripts/`，CI 入口为 `.cnb.yml`（main 分支 push/PR 触发四流水线：`#001` backend-lint / `#002` frontend-lint / `#003` backend-test / `#004` frontend-test）：

- 依赖/文件/导出：knip（配置 `web/knip.json`）— 硬
- 行数预算：`check_line_budget.py`（>800 fail；`LARGE_PR_APPROVED=1` 豁免；`.md` 不计入）— 硬
- 架构边界：import-linter（`.importlinter`，含 `core_no_business`）— 硬
- 后端覆盖率：`check_coverage.py`（阈值见脚本；`COVERAGE_APPROVED=1` 豁免）— 硬
- 前端体积：`check_bundle_size.py`（`BUNDLE_SIZE_STRICT=1` 转硬）— 告警
- 「缺测试」标签：`check_tests_touched.py`（`REQUIRE_TESTS=1` 转硬）— 本地告警
- 前端覆盖率：`check_frontend_coverage.py`（基线见 `scripts/bundle-baseline.json`）— 硬

---

## 3. 关键硬约束

- **禁止改动**开发库 `investment_tracker`（由 `backend/.env` 的 `DATABASE_URL` 驱动）。
- **零遗留**：不含任何 NestJS/Prisma/TS 后端代码。
- `backend/scripts/`（git 跟踪）≠ 仓库根 `dev-scripts/`（`.gitignore` 忽略）。
- push 必须走 `dev-scripts/push-all.ps1` + `CNB_TOKEN`（内嵌 URL 绕过凭据弹窗）；**不要**直接 `git push`（非交互环境会卡死）。

---

## 4. 验证命令

- 后端改动后：`uv run pytest`
- 前端改动后：`pnpm run lint`（`vue-tsc --noEmit`） + `pnpm test`（`vitest run`）+ 必要时 `pnpm run typecheck:e2e`
- 提交前：`python scripts/pre_commit_gate.py`

---

> 维护：最后更新 2026-08-31。每次架构变更（新增目录/依赖层/CI 闸门）时复查 `docs/架构治理规范.md` 并同步本文件。
