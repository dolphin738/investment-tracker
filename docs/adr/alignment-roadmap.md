# 对齐 `app/` 统一路线图（Plan · 供评审）

> 生成日期：2026-08-10
> 范围：仅基于两端真实源代码（已用 Grep/Read 核验），不含文档/README/注释推断。
> 产物性质：**评审文档**。确认后再分步改代码（遵循 q-1 工作流）。

---

## 0. 结论速览

功能契约**已对齐**（新项目 69 端点 ≥ 旧 `app/` 68；信封 / 错误码 1001–5000 / JWT(HS256) / Decimal→字符串 / UTC+8 / 金融纯函数算法 1:1 复刻；Service 层与写入归属已收口）。

剩余三项均属「**组织层 / 机制层 / 可扩展性**」差异，**不影响已上线功能正确性**，但其中两项是真实缺口：

| 优先级 | 事项 | 类型 | 缺口本质 | 成本 | 是否阻塞业务 |
|--------|------|------|----------|------|--------------|
| **P0** | 定时物理清理软删账户 + 头像孤儿清理 | 机制 / 数据卫生 | 软删永不物理删除 → 唯一索引槽长期不释放；头像目录孤儿文件累积 | 中 | 是（DB 卫生 + 合规） | **（已实施 2026-08-10）** |
| **P1** | 存储抽象层 | 机制 / 可扩展 + 安全 | 直写磁盘、无 driver 抽象、无 `STORAGE_DRIVER` 切换 | 中 | 否 |
| **P2** | 方案 B 模块重组 | 组织层对齐 | 按层划分 vs 按功能包（仅「长得像 app」） | 低 | 否（可选） |

**建议执行顺序：P0 → P1 → P2**（按必要性与风险排序）。

---

## 1. 现状基线（已用源码核验）

| 维度 | 旧 `app/`（NestJS） | 新项目（FastAPI） | 状态 |
|------|---------------------|-------------------|------|
| 统一信封 / 错误码 | `response.util` + 全局过滤器 | `core/envelope.EnvelopeRoute` + 全局异常处理器 | ✅ 对齐 |
| JWT 鉴权 | `passport-jwt` 守卫 | `core/security` + `Depends(get_current_user)` | ✅ 对齐 |
| Decimal→字符串 | Prisma decimal 经 DTO | `EnvelopeJSONResponse` 编码器 | ✅ 对齐 |
| 资源 Service 拆分 | 胖 Service | 10 资源 Service + `PortfolioChildService` | ✅ 对齐 |
| 写入归属收口 | AuthService / UploadService 等 | `UserService` / `UploadService` / `CashflowService.bulk_create` / `TradeService` / `SnapshotService` | ✅ 对齐 |
| 模块边界强制力 | `@Module` imports/exports（编译期） | `import-linter` + AST 测试（约定级） | ⚠️ 部分（语言限制） |
| **存储抽象** | `StorageService` 抽象 + `LocalDiskStorage` + `storageServiceFactory` | `services/upload.py` 直写 `UPLOAD_DIR` | ❌ **缺口** |
| **定时清理** | `CleanupService.@Cron(EVERY_DAY_AT_4AM)` | 软删 + `ACCOUNT_RETENTION_DAYS` 配置，**无调度** | ❌ **缺口** |
| 目录组织 | `modules/<feature>/`（功能包） | `routers/ services/ models/`（按层） | ⚠️ 组织分歧 |

> 依据文件：新项目 `backend/app/main.py`、`backend/app/core/config.py`、`backend/app/services/upload.py`、`backend/app/services/user.py`；旧 `app` `modules/upload/storage/storage.service.ts`、`local-disk.storage.ts`、`upload.module.ts`、`modules/auth/cleanup.service.ts`。

---

## 2. P0 — 定时物理清理软删账户

### 2.1 旧 `app/` 机制（精确，已读源码）
- `modules/auth/cleanup.service.ts`：`CleanupService.purgeSoftDeletedUsers()` 标 `@Cron(CronExpression.EVERY_DAY_AT_4AM)`。
- 口径：`cutoff = now - ACCOUNT_RETENTION_MS`（30 天，取自 `shared`，与 login/restore 同源）。
- 执行：`prisma.user.deleteMany({ where: { deletedAt: { lt: cutoff } } })`，**幂等**（重复跑无副作用）。
- 级联：子数据（组合/现金流/证券/交易/快照/净值/XIRR）由 Prisma `onDelete: Cascade` 自动清理。
- 注释明确：若部署环境不容许进程内定时器，可改为**外部 cron 直接调用该幂等方法**。

### 2.2 新项目落地形态
1. 新建 `backend/app/services/cleanup.py`：
   ```python
   class CleanupService:
       def __init__(self, session: AsyncSession) -> None:
           self.session = session
       async def physical_purge(self) -> int:
           cutoff = datetime.now(timezone.utc) - timedelta(days=ACCOUNT_RETENTION_DAYS)
           # delete(User).where(User.deleted_at < cutoff) → flush
           # 返回删除数；幂等
   ```
   - **级联依据**：新项目 12 表 + 14 FK 均配 `ondelete=CASCADE` + `passive_deletes=True`（Phase 1 确认），硬删 user 由 DB 级联清理子数据，与 app 语义一致。
   - **同源防腐**：`ACCOUNT_RETENTION_DAYS` 取自 `core/config` + `core/enums`，与 `UserService.restore/_assert_restore_window` 同一常量，杜绝「登录说可恢复、跑批却删库」不一致。
2. **调度选型（已定方案 (c)，2026-08-10）**：采用「受保护内部 cron 端点」——新增两个端点 `POST /api/internal/cleanup/accounts`（账户物理清理）与 `POST /api/internal/cleanup/avatars`（头像孤儿清理），均受 `X-Internal-Token` 头保护（独立于用户 JWT），由外部 cron（k8s CronJob / 系统 crontab / GitHub Actions）按各自频率调用。**账户每日 04:00**、**头像每 3 个月**（如 1/4/7/10 月 1 日 04:00）。零新依赖、多副本天然不重复、适配 Serverless。
3. **风险点**：多副本部署时 (a)/(b) 会每副本各跑一次 → 依赖幂等 + 可选 `pg_advisory_xact_lock` 单实例锁；或仅用 (c) 由外部单点触发。

### 2.3 验收
- 构造 `deleted_at = now - 31天` 的用户 + 子数据 → 跑 `physical_purge` → 断言用户被删、子数据经 CASCADE 消失、`restore` 返回 1009。
- 构造 `deleted_at = now - 1天` 用户 → 跑 purge → 断言**不被删**（防误清）。

---

## 2.4 新增：头像孤儿清理定时任务

用户扩展需求：除账户清理外，再增加一个定时任务检查头像保存目录，删除未使用的旧头像。

- **机制**：`CleanupService.sweep_orphan_avatars()` —— 列出 `UPLOAD_DIR/avatar/` 全部文件，查 `user.avatar` 收集被引用文件名集合，删除不在集合中的孤儿文件。
- **安全闸门**：仅删匹配 `<uuid>.<ext>` 命名约定（`AVATAR_FILENAME_RE`）的文件，与 `upload.py._remove_old`、app 的 `LocalDiskStorage.canRemove` 同源（三重校验之「文件名正则」一重）。外链 / 手填路径 / 非 uuid 文件名一律跳过，防误删 / 路径穿越。
- **幂等**：重复运行无副作用。
- **触发**：拆为独立端点 `POST /api/internal/cleanup/avatars`，与账户清理解耦——账户每日触发、头像每 3 个月触发（见 §2.2 调度选型）。

## 3. P1 — 存储抽象层

### 3.1 旧 `app/` 机制（精确，已读源码）
- `storage.service.ts`：`abstract class StorageService`，契约四法 `save(buffer, ext)→{url,path}` / `remove(absPath)` / `canRemove(url)→bool` / `resolvePath(url)→absPath`。
- `local-disk.storage.ts`：`LocalDiskStorage` 实现：
  - `save`：`randomUUID()+魔数ext` 文件名，**绝不用客户端原名**（防 `../../etc/passwd` 穿越）。
  - `remove`：`ENOENT` 视为成功，其余上抛。
  - `canRemove` **三重校验**：① URL 以 `/api/uploads/avatar/` 前缀；② 余部为单一文件名且匹配 `<uuid>.<jpg|png|webp>` 正则（排除 `/`、`..`、查询串）；③ `path.resolve` 后仍在 `baseDir` 内（最终防线）。
- `upload.module.ts`：`storageServiceFactory(config)` 按 `STORAGE_DRIVER` 选实现（`local` 默认；`cos`/`s3` 预留 TODO 分支），业务 `UploadService` 仅依赖抽象。

### 3.2 新项目落地形态
1. 新建 `backend/app/storage/`：
   - `base.py`：`class StorageService(ABC)`（或 `Protocol`），声明 `save(content, ext)→StoredFile` / `remove(path)` / `can_remove(url)→bool` / `resolve_path(url)→str`。
   - `local_disk.py`：`LocalDiskStorage` —— 把 `services/upload.py` 现有落盘 + `_remove_old` 逻辑迁入；`can_remove` 升级为**三重校验**（复用现有 `target != allowed / startswith(allowed)` 这一重，补齐「前缀 + 文件名正则」两重，与 app 完全对齐）。
   - `factory.py`：`get_storage_driver(settings)→StorageService`，按 `STORAGE_DRIVER` 返回实现（`local` 默认，`cos`/`s3` 预留分支）。
2. 改 `services/upload.py`：`UploadService` 构造注入 `StorageService`，**不再直接写盘**；`main.py` 经 `Depends` 提供驱动实例（或模块级 `get_storage_driver(get_settings())` 单例）。
3. `core/config.py` 加 `STORAGE_DRIVER: str = "local"`。

### 3.3 注意
- 现有 `upload.py` 已有基础穿越防护（`_remove_old` 的 `resolve` 在 baseDir 检查），升级到三重校验为**增强**而非从零。
- 抽象增加一层间接，但换来 cos/s3 可插拔（P1 价值）与统一安全闸门。

### 3.4 验收
- `LocalDiskStorage.can_remove` 对「外链 http://」、「`/api/uploads/avatar/../../etc/passwd`」、「`/api/uploads/avatar/abc.png`(非 uuid)」均返回 `False`。
- `save` 生成的 URL 与旧 app 同形（`/api/uploads/avatar/<uuid>.<ext>`）；`STORAGE_DRIVER=cos` 时 factory 走到预留分支（即便暂未实现，也应命中告警/异常而非崩溃）。

---

## 4. P2 — 方案 B 模块重组（组织层对齐，可选）

### 4.1 目标
把「按层划分」改为「按功能包」，使目录心智与 `app/` 的 `modules/<feature>/` 同构。**只对齐组织，不复刻机制**（边界强制力仍靠 import-linter）。

### 4.2 落地形态
```
backend/app/
  modules/
    auth/         router.py service.py schemas.py __init__.py(暴露 router)
    portfolio/    ...
    cashflow/     ...
    security/     ...
    trade/        ...
    price/        ...
    cashbalance/  ...
    snapshot/     ...
    dividend/     ...
    calculation/  ...
    data_transfer/...
    preference/   ...
    upload/       ...
    aggregation/  ...
    health/       ...
  core/ db/ finance_core/ models/ storage/(P1 新建) services/base.py(保留基类)
```
- `main.py` 改为逐个 `include_router(modules.<f>.router)`。
- **保留共享**：`core/ db/ finance_core/ models/`（SQLAlchemy 模型因全局 metadata 仍集中，不拆进模块——这是 Python ORM 特性，非缺口）；`storage/` 作为共享基础设施。
- **关键约束**：`aggregation` 须在 `portfolios` 前 `include_router`（FastAPI 顺序敏感，已注释规避），重组后该约束保留。

### 4.3 与 P0/P1 的关系
- **正交**：模块化不改运行时能力；P0 清理、P1 存储抽象独立可先做。
- **import-linter 契约需更新**：从「层边界规则」改为「模块边界规则」（模块不得反向依赖其它模块内部，只能经 router/service 公共接口）。

### 4.4 验收
- 全量测试仍绿；`import-linter` 新规则通过；目录结构与 `app/modules/<feature>/` 一一可映射。

---

## 5. 风险与权衡汇总

| 事项 | 主要风险 | 缓释 |
|------|----------|------|
| P0 清理 | 多副本重复跑 / serverless 无长驻进程 | 幂等 + 可选 advisory lock；或仅用外部 cron 端点 |
| P1 存储 | 抽象层间接性；cos/s3 暂未实现 | 仅 `local` 落地即达标；预留分支不强制实现 |
| P2 模块 | import 全面改写成本高、易漏 | 纯搬文件 + 机械化改 import；lint 规则先行更新 |

---

## 6. 建议执行顺序

1. **P0 定时清理**（功能/数据卫生缺口，先补）→ 2. **P1 存储抽象**（可扩展+安全增强）→ 3. **P2 模块重组**（组织对齐，可选，可与前两项并行或后置）。

---

## 7. 决策记录与待确认

- **P0 已定 (c) + 新增头像孤儿清理，已完成实施（2026-08-10）**：见 `services/cleanup.py`、`routers/internal.py`（已拆为 `cleanup/accounts` 每日 + `cleanup/avatars` 每 3 月两个端点）、`core/config.py`(INTERNAL_CLEANUP_TOKEN)、`main.py` 注册、`tests/test_cleanup.py`（8 测试全过，全量 110 passed 无回归）。
- 待确认：
  1. P1 是否接受「仅落地 `local` 驱动 + 预留 cos/s3 分支」而不实现对象存储？
  2. P2 模块重组是否本次一并做，还是先收口 P1 再单独评审？

> 确认后我将按 q-1 流程分步实施，每步附改动文件清单 + 测试，不自动 push（沙箱无法自推，需你本机 `dev-scripts/push-all.ps1`）。
