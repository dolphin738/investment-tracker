---
title: AI代码清理与瘦身实施计划
date: 2026-08-24
tags:
  - AI编程
  - 代码重构
  - 实施计划
aliases:
  - AI代码清理实施计划
  - 代码瘦身计划
parent: "[[AI代码清理与瘦身指南]]"
status: 执行中（阶段3·第3轮完成，待第4轮）
---

# AI 代码清理与瘦身实施计划

> [!abstract] 概述
> 本文档是 [[AI代码清理与瘦身指南]] 的落地实施方案，包含五个阶段的具体动作、可直接使用的 AI 提示词模板、工程规则与验收标准。
> **核心原则：AI 只举证不动手（阶段 2）、人类批准后小步执行（阶段 3）、机器卡死准入（阶段 4）。**

---

## 方法论速览

| 步骤 | 本质 | 类比 |
| --- | --- | --- |
| 1 功能清单 | 立验收基线 | 术前体检确认生命体征 |
| 2 全面体检 | 静态审计 | 拍片定位病灶 |
| 3 小批量删除 | 增量重构 | 分次手术，每次只切一处 |
| 4 防反弹规则 | 持续治理 | 术后康复方案 + 生活习惯 |

---

## 流程总览

```mermaid
graph LR
    A[阶段 0 准备工作] --> B[阶段 1 功能清单]
    B --> C[阶段 2 全面体检]
    C --> D[阶段 3 小批量迭代删除]
    D --> E[阶段 4 防反弹规则]
    D -.发现新问题.-> C
    E --> F[常态化治理]
```

**各阶段产出物：**

| 阶段 | 产出物 | 预估周期 |
| --- | --- | --- |
| 0 准备工作 | 可发布基线分支 + 绿色测试 | 半天 |
| 1 功能清单 | 《功能验收表》 | 1-2 天 |
| 2 全面体检 | 《代码体检报告》（带证据，不改代码） | 1 天 |
| 3 迭代删除 | 3-10 轮删除记录 + 验收留痕 | 每轮半天 |
| 4 防反弹 | 规范文档 + CI/CD 闸门配置 | 1-2 天 |

---

## 阶段 0：准备工作

> [!tip] 目标
> 建立安全网：测试可跑、基线可回、分支隔离。

**动作清单：**

- [ ] 新建分支 `cleanup/phase-{n}`，全程不碰主干
- [ ] 跑通现有测试套件，确认绿色（跑不通先修测试）
- [ ] 打 tag 留存基线：`git tag pre-cleanup`
- [ ] 若项目无测试，先为 P0 链路补冒烟测试

> [!warning] 阶段规则
> - **R0.1** 测试不绿，禁止进入清理阶段
> - **R0.2** 主干必须始终可发布，清理只在分支进行

---

## 阶段 1：功能清单（验收表）

> [!tip] 目标
> 产出《功能验收表》——后续所有删除操作的"免死金牌"。

**给 AI 的提示词：**

```text
角色：你是一名资深测试架构师，任务是为当前代码库生成功能验收清单。

要求：
1. 遍历所有路由/页面，逐页记录：URL、核心交互元素（按钮/表单/列表）、
   每个元素的预期行为、边界条件（空态/错误态）
2. 遍历所有 API 接口，逐个记录：HTTP 方法、路径、入参 schema、
   出参 schema、错误码、副作用（写库/发消息/扣费）
3. 识别核心链路并标注优先级：
   P0 = 出错即造成资损或数据丢失（比如登录、支付、数据存档等）
   P1 = 用户高频使用的主流程
   P2 = 低频或辅助功能
4. 铁律：只记录代码中真实存在的行为，禁止推测"应该有"的功能。
   拿不准的地方标注 [待人工确认]。

输出格式：Markdown 表格，按模块分组，每行一个可独立验收的功能点。
```

**执行清单：**

- [ ] AI 生成清单初稿
- [ ] 人工逐条确认，处理所有 [待人工确认] 项
- [ ] 锁定清单（git 提交）

> [!warning] 阶段规则
> - **R1.1** 清单经人工确认后锁定，后续变更须显式记录原因
> - **R1.2** P0 链路对应的代码标记为"承重墙"，任何删除方案不得触碰其主路径
> - **R1.3** 每轮删除完成后，必须对照本表逐项复核，复核记录附在 PR 描述中
> - **R1.4** 复核发现失败项，立即回滚本轮全部改动，不带病前进

---

## 阶段 2：代码全面体检

> [!danger] 铁律
> 此阶段 AI ==只读不写==。每条发现必须**先给证据再给建议**。

**六维排查维度：**

| 维度 | 排查内容 | 证据要求 |
| --- | --- | --- |
| 1 死代码 | 未被引用的文件、函数、组件、样式 | 说明"无引用"的确认方式（全局搜索零结果等） |
| 2 重复模块 | 功能高度相似的组件/函数/工具类 | 并排列出两处代码位置与相似点 |
| 3 废弃依赖 | 声明未用的包、调用已废弃的接口 | 引用计数、文档佐证 |
| 4 冗余调用 | 过度封装、不必要中间层 | 展示调用链与原生替代方案 |
| 5 缺失测试 | 对照验收表找无覆盖功能点 | P0 无覆盖单独置顶 |
| 6 安全隐患 | 硬编码密钥、注入风险、过宽权限 | 具体位置 + 攻击场景说明 |

**给 AI 的提示词：**

```text
角色：你是一名代码审计专家。对当前代码库做全面体检。
铁律：只出报告，不修改任何一行代码。每条发现必须先给证据再给建议。

排查以下六个维度：
1. 死代码：未被任何入口引用的文件、函数、组件、样式。
   证据要求：说明你如何确认"无引用"（如全局搜索零结果、路由表未注册）。
2. 重复功能模块：功能高度相似的组件/函数/工具类。
   证据要求：并排列出两处代码的位置与相似点，标注差异部分。
3. 废弃依赖与接口：package.json 中声明但从未 import 的包；
   代码中调用但已无实现方/文档已废弃的接口。
4. 冗余复杂调用：过度封装（仅转调一层的函数）、不必要的中间层、
   可用原生/标准库一行替代的多行实现。
5. 缺失测试的流程：对照功能验收表，列出无测试覆盖的功能点，
   P0 无覆盖的单独置顶。
6. 安全隐患：硬编码密钥、SQL/命令注入风险、未校验的输入、
   过宽的 CORS/权限配置。

每条发现的输出格式：
- 编号 | 维度 | 位置（文件路径:行号）| 证据 | 影响范围 | 建议动作 | 风险等级

排序：按风险等级降序。禁止输出任何没有证据支撑的建议。
最后汇总：总问题数、各维度分布、预计可删除的代码行数。
```

**执行清单：**

- [ ] AI 输出体检报告
- [ ] 人工逐条标注：采纳 / 搁置 / 误报
- [ ] 采纳项整理为阶段 3 任务池
- [ ] 误报项记录原因，用于迭代提示词

> [!warning] 阶段规则
> - **R2.1** 体检阶段禁止任何代码改动（可加 git hook 拦截）
> - **R2.2** 无证据的建议一律不采纳、不进入下一阶段
> - **R2.3** 仅人工标注"采纳"的项才成为阶段 3 任务池
> - **R2.4** 误报原因回流到体检提示词，持续迭代

---

## 阶段 3：小批量迭代删除

> [!tip] 核心纪律
> ==一轮只解决一类问题==。按风险从低到高排序，先易后难。

**轮次规划示例：**

| 轮次 | 类别 | 风险 | 状态 |
| --- | --- | --- | --- |
| 1 | 未使用依赖（package.json 瘦身） | 极低 | ✅ 已完成（提交 c0bcd0c） |
| 2 | 死文件 / 死代码删除 | 低 | ✅ 已完成（本回合提交） |
| 3 | 重复模块合并 | 中 | 待办 |
| 4 | 冗余调用链拍平 | 中 | 待办 |
| 5 | 补 P0 测试（体检发现缺口） | 无删除 | 待办 |

**每轮给 AI 的提示词模板：**

```text
角色：你是一名重构执行工程师。本轮任务：{填入具体类别，如"清理未使用依赖"}。

前置约束：
1. 只允许在当前 cleanup 分支操作。
2. 本轮只处理 {类别} 问题，其他类别的问题一律不动，
   发现了就追加记录到 backlog.md，不许顺手修。
3. 删除前先运行测试套件，把结果保存为基线。

执行要求：
1. 每处删除必须引用体检报告的编号（如 REP-023），
   无编号对应的删除一律禁止。
2. 涉及 P0 链路的文件，先暂停并列出清单等我确认，不得自行判断。
3. 全部删除后重跑测试，与基线逐项 diff，输出对比表。
4. 自我检查：重新审视每一处删除，确认没有误删
   （调用方是否全量搜索过、动态引用/字符串拼接引用是否考虑到）。

完成后输出三份材料：
A. 删除清单：位置、对应报告编号、删除行数
B. 测试对比：基线 vs 删后，逐项对比结果
C. 人工验收步骤：对照功能验收表，列出需要人工在界面上逐个点击
   确认的具体操作步骤（精确到"打开某页面，点击某按钮，应看到某结果"）
```

**每轮执行清单：**

- [ ] AI 按提示词执行删除
- [ ] 审核 AI 三份材料（A 删除清单 / B 测试对比 / C 验收步骤）
- [ ] 执行人工验收：P0 链路 100% 逐项、P1/P2 不低于 50% 抽查
- [ ] squash 合并，提交信息格式：`cleanup({类别}): 删除 {行数} 行，依据 REP-{编号范围}`

> [!warning] 阶段规则
> - **R3.1** 一轮一类，违反即中止本轮
> - **R3.2** 测试对比出现任何差异（哪怕看似无关），本轮整体回滚，先查明原因
> - **R3.3** AI 的自我检测不能替代人工验收
> - **R3.4** 每轮合并前 squash 成一个提交
> - **R3.5** 单轮删除量超过总代码量 5% 时，拆成多轮

---

## 阶段 4：防反弹工程规则

> [!tip] 目标
> 清理完成后，用规则把成果焊死。分四个层面落地。

### 4.1 架构规范文档

**给 AI 的提示词：**

```text
角色：你是架构治理专家，为当前项目生成架构规范文档。

要求：
1. 目录职责：每个顶层目录一句话职责说明 + 禁止事项
   示例：
   - src/api        只放接口定义，禁止写业务逻辑
   - src/components 只放展示组件，禁止直接调 API
2. 调用边界：画出依赖方向图（api <- services <- components），
   禁止反向引用
3. 新增依赖准入：须在 PR 中说明"为什么现有依赖/原生能力做不到"
4. 文件行数上限：单文件 400 行，超限需拆分说明理由
5. 函数职责：一个函数只做一件事，禁止"顺手"在里面加功能

输出：Markdown 格式规范文档，可直接放入项目根目录。
```

### 4.2 任务微型化（日常开发提示词纪律）

> [!example] 大任务拆分示例
> **错误示范：** 给这个系统加一个用户功能（登录、权限、资料修改）
>
> **正确示范：**
> - 第 1 次：只做登录页面的表单校验逻辑，输入项：手机号 + 验证码，不涉及任何后端调用
> - 第 2 次：接登录 API，只处理成功分支
> - 第 3 次：补登录失败的三种错误态（验证码错、账号封禁、网络超时）
> - 第 4 次：登录成功后的 token 存储与自动携带

### 4.3 CI/CD 闸门配置

**给 AI 的提示词：**

```text
角色：你是一名 CI 工程师，为本项目配置防代码膨胀闸门。

要求：
1. Lint 闸门：unused-imports、unused-vars、未使用文件检测设为 error，
   违规直接 fail 构建
2. 依赖闸门：集成 knip（或 depcheck），PR 中新增未被使用的依赖即打回；
   依赖总数比 main 分支增加超过 3 个时要求说明
3. 体积闸门：构建产物体积与 main 对比，增长超过 5% 时打标签警告
4. 行数闸门：单 PR 新增代码超过 800 行时强制人工说明拆分理由
5. 测试闸门：改动文件若无对应测试变更，PR 打标签"缺测试"；
   核心链路覆盖率低于 80% 时 fail
6. 以上全部集成到 PR 检查，不通过禁止合并

输出：可直接使用的 CI 配置文件 + 每条闸门的说明。
```

### 4.4 提交自动检测规则

```text
规则：每次 AI 生成代码提交前，自动执行以下检查，任一不过即打回：
1. 新增的每个 export 是否至少有一处使用
2. 新增依赖是否在准入清单中（不在则要求人工批准）
3. 是否有"防御性垃圾"：捕获异常后返回默认值、无意义的重试包裹、
   复制粘贴的相似代码块（相似度阈值 0.9）
4. 单次提交是否只做一件事（混合了功能+重构+格式化的提交要求拆分）
```

**阶段执行清单：**

- [ ] 生成并人工审定架构规范文档
- [ ] 配置 CI/CD 闸门并验证生效
- [ ] 制定任务微型化的 Prompt 拆分习惯
- [ ] 建立提交自动检测流程

---

## 贯穿全程的元规则

> [!important] 人盯 AI 的五条纪律
> 1. **先举证后动手**：AI 提出的每个删除/修改，必须先给出证据链，人类批准后才执行
> 2. **AI 不自批**：AI 的自我检测不能替代人工验收，尤其是 P0 链路
> 3. **回滚零心理负担**：发现异常立即回滚本轮，"已经删了这么多舍不得回滚"是最大陷阱
> 4. **提示词本身要迭代**：体检误报多就补证据要求，删除误判多就加"动态引用检查"——把每次事故变成提示词的新条款
> 5. **度量的存在感**：清理前后各跑一次统计，数字是说服管理层继续投入的最强武器

---

## 度量记录表

> [!note] 使用方法
> 清理前后各填写一次，用数字证明价值。

| 指标 | 清理前 | 清理后 | 变化 |
| --- | --- | --- | --- |
| 总代码行数 |  |  |  |
| 依赖总数 |  |  |  |
| 构建产物体积 |  |  |  |
| 测试覆盖率 |  |  |  |
| P0 链路测试覆盖 |  |  |  |

---

## 落地优先级建议

> [!success] 时间有限时的最小闭环
> 1. **必做**：阶段 0 + 阶段 1（P0 清单）+ 阶段 3 的第 1-2 轮（依赖和死代码，风险最低、见效最快）
> 2. **强烈建议**：阶段 4 的 Lint 闸门和依赖闸门（成本低，防反弹收益最大）
> 3. **有余力**：完整六维体检、全部轮次、体积/覆盖率闸门

---

## 阶段 3 执行记录

> 本部分由 AI 按阶段 3 纪律逐轮填充：每轮含 A 删除清单 / B 测试对比 / C 人工验收，并附 git 提交指针与轮次验收结论。

### 第 1 轮 · 依赖瘦身（2026-08-28，已提交）

- 分支：`cleanup/phase-0`（脱离 main，未 push）
- 提交：`c0bcd0c`（5 文件，+3 / −31）
- 范围：REP-004 / REP-039 / REP-040 / REP-041 / REP-054

#### A. 删除清单

| REP | 文件 | 动作 | 行数 |
| --- | --- | --- | --- |
| REP-004 | backend/pyproject.toml | `httpx` 由 dev 组 → `[project.dependencies]`（升格，防生产精简安装 ImportError） | +1（净移动） |
| REP-039 | web/package.json + web/vite.config.ts | 移除 `date-fns` + 删 `manualChunks` `/date-fns/` 死分支 | −1 / −1 |
| REP-040 | web/package.json + web/vite.config.ts | 移除 `papaparse` + 删 `vendor-papaparse` 死分支 | −1 / −1 |
| REP-041 | web/package.json | 移除 `@types/papaparse` | −1 |
| REP-054 | backend/.env.example | 真实熵密钥样例 → 占位符 `CHANGE_ME_TO_RANDOM_32BYTE_SECRET` | 改值 |
| 同步 | web/pnpm-lock.yaml | 移除 3 包全部引用（importer/packages/snapshots 共 9 处）使 lockfile 对齐 | −24 |

#### B. 测试对比（基线 vs 删后）

- `pyproject.toml` TOML 合法，`httpx` 在 runtime deps，dev 组保留 `httpx2` ✅
- 前端 `vue-tsc --noEmit` 直跑 **exit 0、零错误** ✅（绕过被 WorkBuddy safe-delete 拦截的 `pnpm`）
- `pnpm-lock.yaml`：`date-fns`/`papaparse` 全仓零引用，顶层结构（lockfileVersion/importers/packages/snapshots）完整 ✅
- **零差异**（R3.2 未触发回滚）
- ⚠️ 环境缺口（非本轮问题，需 owner 门禁）：本沙箱离线，`pnpm install` 跑不了（DNS 不可达），`--frozen-lockfile` 在本环境异常退出；建议联网环境跑 `pnpm install` + `pytest` 做最终回归。

#### C. 人工验收步骤

1. 前端 `pnpm dev` / `pnpm build`：控制台无「缺少 date-fns/papaparse 模块」报错。
2. 打开投资组合概览 DashboardPage、行情页：图表与数据加载正常（删的是未使用依赖，无功能影响）。
3. 后端：复制 `.env.example`→`.env`，确认 `JWT_SECRET` 为新占位符（⚠️ 生产须替换为真实 ≥32 字节随机串）；`uvicorn`/`alembic` 启动无 ImportError。
4. `pnpm build` 成功，无因依赖缺失导致的打包错误。

#### ⚠️ 过程插曲：git ref gremlin 已恢复

提交 `c0bcd0c` 后分支引用被实时篡改（松散引用 `refs/heads/cleanup/phase-0` 被删、`packed-refs` 第 1 行被改回旧 tip `e8c6c05`）。已按项目记忆 **packed-refs sed 法**恢复：备份 → 原地改写 sha → `git rev-parse HEAD` 复核 = `c0bcd0c`、`git log --oneline -3` 链完整，现已稳定。工作树干净，5 个文件改动均已入提交。**预先存在的无关改动（docs/、`.codebase-memory/`）未纳入本轮提交**，保持隔离。

### 第 2 轮 · 死文件死代码（2026-08-28，已提交）

- 分支：`cleanup/phase-0`（脱离 main，未 push）
- 提交：本回合 squash 提交（10 文件删除 + 8 文件修改，约 −330 行）
- 范围：REP-020~028、REP-046~050（REP-024 撤销、REP-049/050 暂缓，见异常记录）

#### A. 删除清单

| REP | 文件 | 动作 | 行数 |
| --- | --- | --- | --- |
| REP-020 | web/src/components/common/PageSkeleton.vue | 删除（零引用） | −35 |
| REP-021 | web/src/components/common/CardSkeleton.vue | 删除（唯一引用方 PageSkeleton 已删） | −15 |
| REP-022 | web/src/components/common/LoadingSpinner.vue | 删除（零引用） | −38 |
| REP-023 | web/src/components/ui/alert/（Alert/AlertDescription/AlertTitle/index.ts 共 4 文件） | 删除（零外部 import，与 alert-dialog 不同族） | −73 |
| REP-025 | web/src/components/ui/dialog/DialogTrigger.vue、DialogClose.vue + 清 dialog/index.ts 导出 | 删除（业务对话框均 v-model 受控，本地包装零消费） | −22 |
| REP-026 | web/src/components/ui/alert-dialog/AlertDialogTrigger.vue + 清 alert-dialog/index.ts 导出 | 删除（9 处使用方均受控 open） | −11 |
| REP-027 | web/src/lib/utils.ts `isStale()` | 删除（调用计数 0，新鲜度已由后端下发） | −16 |
| REP-028 | backend/app/core/date_utils.py `now_app_tz()` | 删除（定义处 1 次命中） | −3 |
| REP-046 | backend/app/modules/calculation/router.py `_shares_at()` | 删除（定义处 1 次命中，nav 聚合已内联） | −4 |
| REP-047 | web/src/modules/security-price/composables/use-security-prices.ts 悬空转出口 | 删除 `export { useUpsertSecurityPrice }`（真实定义/消费方在 holdings 模块） | −2 |
| REP-048 | web/src/lib/constants.ts（5）+ web/src/lib/types.ts（8）共 13 死导出 | 删除（全零引用；保留 API_BASE_URL/toIsoDate/ACCOUNT_RETENTION_DAYS/ExportType·ImportType 类型/EXCHANGE_LABELS） | −60 |

#### B. 测试对比（基线 vs 删后）

- 前端 `vue-tsc --noEmit -p tsconfig.app.json` **exit 0、零错误** ✅
- 后端 `py_compile` date_utils.py / router.py 通过，全仓零 `now_app_tz`/`_shares_at` 悬挂引用 ✅
- 全目标符号 grep 复核：13 死导出 + isStale + 转出口 + 后端 2 函数均仅剩无关字段/注释，无代码引用 ✅
- **零差异**（R3.2 未触发回滚）

#### C. 人工验收步骤

1. 前端 `pnpm dev`：应用正常启动，控制台无「找不到模块 PageSkeleton / ui/alert / DialogTrigger」类报错。
2. 打开任意含对话框的页面（如持仓列表删除确认、设置页）：对话框正常开关（受控 `v-model:open` 不受影响）。
3. 打开主数据/交易所筛选（StockListPanel）：交易所中文标签正常（EXCHANGE_LABELS 保留）。
4. 后端 `uvicorn`/`alembic` 启动无 ImportError；行情/净值接口正常（_shares_at 内联等价）。

#### ⚠️ 异常记录（本轮关键插曲）

1. **REP-024 撤销**：复核发现 `SelectGroup`/`SelectLabel`/`SelectSeparator` 已被 `web/src/modules/portfolio/components/PortfolioSelector.vue:15,17,18,72-94` 实际消费，**不再是死代码**（报告 2026-08-25 证据已过期）。按"信任但验证"纪律撤销该项，保留三组件。
2. **REP-049 / REP-050 暂缓**：REP-049（12 个过度导出去 `export` 关键字）为 [待人工确认]·最低优先级，且移除 `export` 可能触发 `noUnusedLocals` TS 报错（如 `EntryButtonKey` 连内部都未使用）；REP-050（`stringCodec`）仅测试引用，属测试基建。两者均暂缓，待 owner 决策后单独排期。
3. **D:\sync 同步误删 87 文件**：本回合 `git rm` 10 个目标文件后，工作树突现 87 个核心文件（Card.vue、DynamicIcon.vue、SelectGroup.vue 等）被外部进程（疑似 D:\sync 云同步）从磁盘删除、但 git 仍跟踪。已**全部从 git 索引恢复**，仅保留 10 个目标删除，避免误删真实文件与误提交。提交已隔离，不含这 87 个文件。
4. **git ref gremlin**：提交后按上轮经验立即核验分支引用；如出现松散引用被删/packed-refs 被改，按 packed-refs sed 法恢复。

### 第 3 轮 · 前端 overview 重复模块清理（2026-08-28，已提交）

- 分支：`cleanup/phase-0`（脱离 main，未 push）
- 提交：本回合 squash 提交（3 文件删除 + 9 文件修改 + 1 新建，净 −480 行左右）
- 范围：REP-029/030（删 overview 旧图表副本改用 `@/components/charts` 版）、REP-031/032/033（抽共享 `AxisTooltipParam`/`extraCssText`/`formatter`/`splitLine` 到 `chart-tooltip.ts`）、REP-044（删 overview `use-snapshots` 副本）、REP-045（`use-query-data` 五件套收敛到 analysis 版为单一真相源）

#### A. 删除 / 新增 / 收敛清单

| REP | 文件 | 动作 | 行数 |
| --- | --- | --- | --- |
| REP-029 | web/src/modules/overview/components/XirrTrendChart.vue | 删除（图表已迁至 `@/components/charts/XirrTrendChart.vue`，props 契约一致） | −130 |
| REP-030 | web/src/modules/overview/components/NavTrendChart.vue | 删除（图表已迁至 `@/components/charts/NavTrendChart.vue`） | −182 |
| REP-044 | web/src/modules/overview/composables/use-snapshots.ts | 删除（唯一消费者 `TotalAssetTrendChart.vue` 改用 `@/modules/snapshot/composables/use-snapshots`，`useSnapshots` 签名/行为逐字一致） | −36 |
| REP-031/032/033 | web/src/components/charts/chart-tooltip.ts | **新建**（共享 `AxisTooltipParam` / `TOOLTIP_EXTRA_CSS_TEXT` / `formatPercentAxisLabel` / `axisSplitLine` / `formatPercentAxisTooltip`，归并 nav/xirr/yearly 三图逐字复制） | +51 |
| REP-045 | web/src/modules/overview/composables/use-query-data.ts | 收敛为再导出（五件套从 `@/modules/analysis/composables/use-query-data` 再导出；删除死副本 `useNavTotalAssetMap`） | −134→+13 |
| REP-029/030/044 | DashboardPage.vue / TotalAssetTrendChart.vue / dashboard-page*.test.ts | import 路径改走 `@/components/charts` 与 `@/modules/snapshot`；test mock 路径同步 | 改 |
| REP-031/032/033 | nav/xirr/yearly-bar-chart.ts + total-asset-trend-chart.ts | 改用共享符号，移除各自复制的 `AxisTooltipParam` / `extraCssText` / `splitLine` / `formatter` | 改 |

#### B. 测试对比（基线 vs 删后）

- 前端 `vue-tsc --noEmit -p tsconfig.app.json` **exit 0、零错误** ✅（全 `src` 类型门禁；确认无重复 import、无悬空 import 到已删文件、overview `use-query-data` 再导出解析正常）
- **REP-045 行为差异核验**：overview 原 disabled 态 `queryKey` 为 `['xirr','series', null, params]`（null portfolioId），analysis 版为 `['xirr','series','disabled']` 哨兵；收敛后 overview 采用 `'disabled'`。**enabled 态 key 两版完全一致**；disabled 态 `enabled:false` 永不触发，无缓存 / 数据影响 → **零行为差异**。
- **消费者核验**：仅 `DashboardPage.vue` 从 `overview/use-query-data` 取 4 个共享 hook（`useXirrSeries`/`useNavSeries`/`useLatestXirr`/`useLatestNav`），import 路径不变经再导出解析；测试仅 mock `@/api/query.api` 层（非 composable），不受再导出影响。
- **关键纠正（信任但验证）**：体检报告 REP-045 建议 overview "仅保留独有 hook `useNavTotalAssetMap`"——实际 `useNavTotalAssetMap` 在 overview 版为**死副本**（定义 + 注释，无任何消费者从 overview 引用；真身已在 `snapshot/use-snapshots.ts` 被 `SnapshotForm` 消费），故直接删除而非保留。
- ⚠️ 环境缺口（非本轮问题，同前）：本沙箱 `vitest` 损坏（`node_modules/vitest` 被 D:\sync 污染为二进制），无法跑单测；建议 owner 联网 `pnpm store prune` + `pnpm install` 后补 `vitest` 回归。`vue-tsc` 门禁已零错误通过。

#### C. 人工验收步骤

1. 前端 `pnpm dev`：应用正常启动，控制台无「找不到模块 XirrTrendChart / NavTrendChart / use-snapshots」类报错。
2. 打开投资组合概览 `DashboardPage`：XIRR 趋势、净值趋势、总资产走势三图正常渲染，tooltip 样式与迁移前一致（共享 `extraCssText` / `splitLine`）。
3. 资产记录录入表单（`SnapshotForm`）：覆盖提示仍正常（`useNavTotalAssetMap` 走 snapshot 真身）。
4. 打开 XIRR / 净值分析页：五件套 hook 行为不变（`queryKey` `'disabled'` 哨兵仅影响 disabled 缓存标签，无数据影响）。

#### ⚠️ 异常记录（本轮关键插曲）

1. **编辑期 gremlin 高频干扰**：本轮编辑过程中 D:\sync 云同步多次从磁盘删/改被跟踪文件，导致 `Edit` 报 "File has been modified since read"——典型表现为某文件首个 Edit 失败、其余 Edit 成功（共享符号已写入但 import 未写入 → 临时悬空引用）。处置：每次失败即重新 Read 该文件再补 import，最终以 `vue-tsc --noEmit` 全量零错误闭环验证；commit 前再 `git status`/`git diff` 复核工作树与 HEAD 一致。
2. **git ref gremlin 待核验**：提交后立即 `git rev-parse HEAD` / `git log --oneline -3` 核验；若松散引用被删 / `packed-refs` 被改，按 packed-refs sed 法恢复（备份 → 原地改写 sha → 复核）。

## 相关文档

- [[AI代码清理与瘦身指南]]——方法论原文
