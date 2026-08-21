# 全站集中式日志与通知管理系统 — 方案设计

- 日期：2026-08-19
- 状态：评审已落实（2026-08-22 补充 §4.2/§4.4/§4.6 精确语义 + 第七章决策记录；待进入实施）
- 范围：统一日志中心、错误捕获上报、日志展示、自动清理策略、权限配置

## 一、目标

构建一个全站统一的日志与通知管理能力：

1. 统一日志中心：集中展示全站各模块的操作日志、错误日志、警告、系统通知，支持按时间范围、级别、来源模块、关键字检索。
2. 错误与通知捕获：前端拦截未处理异常 / API 失败 / 业务失败；后端记录运行时错误、异常堆栈、业务通知。全部统一写入日志中心。
3. 清晰日志界面：时间戳、级别色标、来源模块、消息详情、堆栈展开、分页、详情弹窗。
4. 自动清理：按“保留 N 天”和“超过 N 条”两种策略定时清理，防存储膨胀。
5. 权限与配置：日志中心仅管理员（或有权限用户）可访问；清理策略可配置。
6. 复用优先：不重复造轮子，先复用现有机制，缺的才新增。

## 二、现有机制盘点（复用清单）

| 现有资产                                                                  | 位置                                                                                                                                  | 承载内容                       | 复用方式           |
| --------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | -------------------------- | -------------- |
| 站内信 `notifications` 表 + `NotificationService` + 铃铛 `NotificationBell` | `backend/app/models/notification.py`、`backend/app/services/notification.py`、`web/src/modules/admin/components/NotificationBell.vue` | 系统通知（行情接口失败告警、已读/未读、铃铛 UI） | 复用，作为“通知类”日志来源 |
| 任务执行日志 `job_run_logs` + 查看执行日志 UI + `max_logs` 保留策略                   | `backend/app/models/job.py`、`backend/app/core/scheduler.py`、SchedulePage                                                            | 定时/手动任务执行结果与错误             | 复用，作为“任务类”来源   |
| 前端 API 失败统一拦截 + toast                                                 | `web/src/lib/api-client.ts`                                                                                                         | API 失败提示（仅 toast，不落库）      | 复用 UI，补上报落库    |
| APScheduler + `job_configs` 系统任务调度                                    | `backend/app/core/scheduler.py`                                                                                                     | 定时执行 / 账户清理等               | 复用，承载日志清理任务    |
| admin 权限 `require_admin` / `useIsAdmin`                               | 全局                                                                                                                                  | 权限守卫                       | 复用，日志中心仅 admin |
| CronInput / SchedulePage 任务表单                                         | `web/src`                                                                                                                           | 配置载体                       | 复用，承载清理策略配置    |

## 三、缺口（项目当前没有、需新增的机制）

1. **运行错误 / 业务操作日志无持久化**：后端错误仅 Python logging 打到控制台（无 FileHandler、无落库），不可检索；前端未捕获异常 / 业务操作无任何落库（`config.errorHandler`、`unhandledrejection` 均不存在）。
   → **新增统一 `app_logs` 表 + 前后端捕获写入**。这是唯一真正“再造”的部分。
2. **无聚合视图**：通知 / 任务日志 / 操作错误三种日志分散存储、无统一界面。
   → **新增日志中心 API + 页面**（只读聚合，不重建库）。
3. **无全局自动清理任务**：`notifications` 无清理；`job_run_logs` 只有 per-task `max_logs` 即时裁剪。
   → **新增定时清理系统任务 + 全局保留策略（天数 / 条数）配置**。

## 四、总体设计

### 4.1 数据与存储（最小新增）

- 新增一张 `app_logs` 表承载“运行错误 + 业务操作”，字段：
  - `id`、`level`（error/warning/info）、`scope`（operation=业务操作 / error=运行错误 / system=系统）
  - `module`（来源模块字符串）、`message`、`trace`（可空，异常堆栈）、`detail`（JSON）、`user_id`（可空）、`created_at`
  - 归一时区/格式，与现有 `notifications`、`job_run_logs` 对齐。
- **不迁移、不合库**：通知仍留 `notifications`，任务日志仍留 `job_run_logs`。日志中心做**只读聚合**（归一成统一 `LogItem`）。
- **决策（三审更新）**：存储采用**方案 A —— 逻辑聚合，不物理合库**。三表保留、不动已验证稳定的业务读写路径（铃铛未读数/已读、告警去重 claim、job 外键级联、max_logs 裁剪），由聚合 API 实现统一查看与统一清理，避免回归验证过的机制。

### 4.2 写入链路（复用 + 补捕获）

- **后端**：新增 FastAPI 全局异常处理器 + 统一 `log_service.record()` 写 `app_logs`；关键业务失败点按需补写 `operation/error`（聚焦关键操作，不铺满全站）。
  - **落库范围限定（评审补充 · 2026-08-22）**：全局异常处理器**仅捕获 5xx / 未捕获异常**并落库（代码 bug、外部依赖故障、技术栈堆栈，带 `trace`）；用 `BusinessException` 抛出的 **4xx 业务异常（未认证 401、无权限 403、不存在 404、参数校验 400/422 等）不落 `app_logs`**——它们是预期内、前端已用 toast/卡片正常呈现的业务反馈，落库只会产生噪音且已有结构化返回。这样错误日志中心保持「系统故障」纯净度，清理策略也能真正减负。
- **前端**：`main.ts` 挂 `config.errorHandler` + `window.addEventListener('unhandledrejection'/'error')` 上报到 `app_logs`；`api-client` 拦截器失败分支追加一次上报（保留现有 toast）。

### 4.3 聚合查询 API（admin）

- `GET /api/admin/logs?level=&scope=&module=&start=&end=&keyword=&page=&pageSize=`
  —— 从 `app_logs` + `notifications` + `job_run_logs` 归一聚合，返回统一 `LogItem[]`。
- `GET /api/admin/logs/{id}` —— 详情（含堆栈展开）。
- **决策（三审更新）**：读取守卫用 `require_any_role("admin", "auditor")`；删除/清理等写操作仍 `require_admin`。

### 4.4 权限（三审更新：细化到非 admin 只读角色）

- 在现有 `users.role` + `UserRole`（USER/ADMIN）基础上**新增只读角色 `AUDITOR`**；日志中心读接口接收 admin/auditor，写（清理/删除）仍限 admin。
- 实现：`core/security.py` 新增通用依赖 `require_any_role(*roles)`，`require_admin` 退化为其对 `"admin"` 的特例（不破坏现有调用）。
- 影响面：`enums.UserRole` 增 `AUDITOR`、用户管理角色下拉支持新值、前端 `useIsAdmin` 扩展为按角色集合判断菜单/路由显隐。
  - **落地坑（评审补充 · 2026-08-22，已按代码核正）**：`UserRole` 当前仅 `USER`/`ADMIN` 两值（见 `backend/app/core/enums.py:11-21`）。**`users.role` 列为普通 `String(20)`（见 `backend/app/models/user.py:24-26`），非 PG native enum**，故新增 `AUDITOR` **无需任何 DB 迁移**——只需改 Python 枚举值 + 前端角色下拉/判断即可。`require_any_role` 本身在 `security.py` 中**尚不存在**，是本次新增依赖，`require_admin` 须重构为其对 `"admin"` 的特例，且现有所有 `require_admin` 调用方不受影响。

### 4.5 前端页面（admin 菜单“日志中心”）

- `LogCenterPage.vue`：时间范围 + 级别 + 来源模块（通知/任务/操作/错误）+ 关键字筛选；列表（时间戳、级别颜色徽标、来源模块、消息摘要）+ 分页 + 详情弹窗（堆栈可展开）。
- 复用现有 `Select/Input/Pagination/Dialog/Badge` 等组件。站内信铃铛保持不变。

### 4.6 自动清理策略（复用调度与配置，不重造）

- **决策（三审更新：按重要性分级）**：保留周期与行数上限**按级别分别配置**，而非全局一刀切：
  - `retention_days: { error: 90, warning: 30, info: 7 }`（错误留最久、警告次之、信息最短）；
  - `max_rows: { error: 20000, warning: 10000, info: 5000 }`（同级别超量从最旧删）；可配全局基线兜底。
  - 清理任务按 `level` 遍历，分别执行“过期 + 超量”两条规则。
- **新增系统任务类型 `LOG_CLEANUP`**（走现有 `job_configs` 系统任务机制，仅 admin 可编辑不可删）。
- 策略从该任务 `params` 读取并可在 SchedulePage 表单编辑（上述按 level 的映射）。
- 清理范围（评审补充 · 2026-08-22）：
  - `app_logs` 过期/超量行（按 level 分级策略）。
  - `notifications`：**仅清理 `read = true`（已读）且 `created_at` 超过 `notifications_retention_days` 的行**；**未读通知永不自动删除**（那是用户尚未看到的待办，如行情失败告警，清掉等于丢提醒）。`notifications_retention_days` 复用本任务的 `params`（可独立配置，不与 `app_logs` 的 `info` 天数混淆）。
  - 未配置 `max_logs` 任务的 `job_run_logs` 超期行（也按级别策略）。
  - **与铃铛去重 claim 不冲突**：`MarketDataSyncService._mark_failure` 的 claim 去重看的是「故障是否已 claim」，与「已读后多久清掉历史通知行」是两件事，清理已读旧消息不会破坏去重。
- 现有 `job.max_logs`（per-task 即时裁剪）**保留并存**：负责“任务自身执行日志”，全局清理负责“整个日志中心基线”，互补不冲突。
- 可选补充 `GET/PUT /api/admin/log-config` 读写策略（或复用 SchedulePage 编辑该系统任务 params，二选一）。

## 五、实施步骤

1. 后端：`app_logs` 模型 + alembic 迁移；`log_service`；FastAPI 全局异常落库；新增 `AUDITOR` 角色 + `require_any_role`。
2. 前端：全局错误捕获 + API 失败上报。
3. 后端：聚合查询 API（三源归一，读守卫 `require_any_role("admin","auditor")`，写操作仍 `require_admin`）。
4. 前端：`LogCenterPage` 页面 + 按角色集合的菜单/路由显隐（admin/auditor 可见）。
5. 后端：`LOG_CLEANUP` 清理任务 + 按 level 分级策略配置 + 定时注册。

## 六、复用 vs 新增边界

- **复用**：通知 / 任务日志 / APScheduler / 系统任务 / 权限 / 表单配置 / 前端组件。
- **新增（仅现缺的）**：`app_logs` 表、前后端错误上报捕获、聚合 API、日志中心页面、全局清理任务与策略、新增 `AUDITOR` 只读角色（`require_any_role`）、按级别（error/warning/info）分级的保留/上限清理策略。

## 七、评审补充与决策记录（2026-08-21 评审 · 2026-08-22 落地）

> 本节沉淀首次评审意见与用户拍板结论，已落实的精确改动已就地并入 §4.2 / §4.4 / §4.6，此处保留上下文与未就地写入的补充项。

### 7.1 可行性结论

方案**可行**，方向正确、边界克制，「逻辑聚合、不物理合库」的决策避免了迁移 `notifications` / `job_run_logs` 这两个已验证稳定机制的回归风险。对照代码现实，复用清单所列资产均真实存在且接口匹配，**可直接进入实施**。

### 7.2 设计提醒（无法在原章节落地，仅作实施注意）

> 评审中确认的 `require_any_role` 不存在、`UserRole` 需 native enum 迁移两项**已直接写入 §4.4 落地坑**，此处不再复述。

1. **`notifications` 无 `user_id`**：通知为全局共享（所有 admin 看同一列表），聚合进 `LogItem` 时其 `user_id` 应填 `null` 或系统标识，勿与 `app_logs.user_id` 混淆。
2. **前端错误上报依赖登录态**：`api-client.ts` 失败分支在 401/1007 等场景触发登录失效逻辑；前端 `unhandledrejection` 上报 `app_logs` 需带 token，**未登录/登录失效时的前端错误不应发请求**（避免上报接口自身 401 循环），仅打 console。

### 7.3 其余补充建议（尚未就地写入，建议实施时采纳）

1. **`app_logs` 建议增加可空 `scope_id`（组合/任务维度）**：本系统按 `portfolio` 多组合隔离，若未来多用户，聚合应按当前用户可见组合过滤，避免越权看他人日志。单租户个人工具可暂缓。
2. **写入性能 / 噪音控制**：
   - 后端全局异常落库**仅 5xx / 未捕获**（见 §4.2 已落实）；
   - 前端上报加**同源去重 + 节流**（同 message 5 分钟内只报一次），否则高频错误会瞬间灌爆 `app_logs`，再精细的清理策略也扛不住。
3. **聚合查询跨三源分页**：`app_logs` + `notifications` + `job_run_logs` 三表归一须用**单条 `UNION ALL` CTE + 统一 `created_at` 排序 + `LIMIT/OFFSET`** 实现，不能各查一页再拼接（会破坏排序与分页正确性）。
4. **测试与验收缺口**（§五 实施步骤未列测试，建议补）：
   - 后端 `log_service.record` + 全局异常落库（仅 5xx）pytest；
   - 聚合 API 三源归一 + 分页 + 角色守卫（admin 可看 / user 403 / auditor 只读）；
   - `LOG_CLEANUP` 按级别分级清理 + `notifications` 仅清已读超期 pytest（造过期/超量数据验证）；
   - 前端错误上报节流单测。

### 7.4 用户拍板决策（2026-08-22）

| # | 议题 | 决策 | 落点 |
|---|---|---|---|
| 1 | 历史数据迁移 | **无需迁移**（无旧数据），仅新建 `app_logs` 空表 + 迁移 | §4.1 已选逻辑聚合，本决策进一步确认零搬迁成本 |
| 2 | `notifications` 自动清理 | **已读且超期可清理，未读永不自动删** | §4.6 清理范围已精确化（新增 `notifications_retention_days`） |
| 3 | 4xx 业务异常是否落库 | **不落库**（仅 5xx / 未捕获异常落 `app_logs`） | §4.2 落库范围限定已落实 |