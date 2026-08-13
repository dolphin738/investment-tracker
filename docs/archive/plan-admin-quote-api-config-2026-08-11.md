# 方案：证券行情 API 地址 · 管理员专属配置模块

- 日期：2026-08-11
- 状态：方案稿（评审中）；D1/D2/D3/D4 全部已拍板，待开工
- 关联：分析文档 `./analysis-three-issues-2026-08-11.md`

---

## 1. 背景与目标

需要一个**仅管理员可见、可改**的配置项：证券行情 API 地址（如 AKShare / Tushare / 自建行情网关的 Base URL）。要求：

1. 后端对读取/写入做**权限校验**（非管理员 → 拒绝）。
2. 前端对普通用户**完全隐藏**该入口（侧边栏无入口、直接访问也被拦截、且普通用户的前端请求根本不应打这个 admin 端点）。
3. 配置数据**全局唯一**（非 per-user），只对授权人员可见可改。
4. 不破坏现有用户正常使用，不影响其它设置项。

> 范围说明：当前 `backend/` 内**没有任何行情拉取代码**（grep `akshare|quote|market_data` 全否，`price.py` 仅是人工录入最新价）。因此本方案**只落地「配置存储 + 管理员 CRUD + 权限门控」**，并提供一个 `get_quote_api_base_url()` 读取入口供未来行情客户端消费；完整的行情接入（AKShare 调用、定时刷新等）不在本方案内，另行立 Phase。

---

## 2. 现状基线（已核实，非假设）

| # | 事实 | 落点 | 对方案的影响 |
|---|---|---|---|
| B1 | **无角色概念**：`User` 模型无 `role` 字段；JWT payload 仅 `{sub, email, iat, exp}`；唯一鉴权依赖 `get_current_user` | `backend/app/models/user.py:13-30`、`core/security.py:31-106` | 需新增角色模型 + 管理员依赖 |
| B2 | **无全局配置表**：全局配置走 `core/config.py` 环境变量；`UserPreference` 是纯 per-user 且带归属白名单 | `backend/app/models/user.py:33-60`、`core/config.py` | 行情地址属「全局管理员配置」，应新建 `SystemConfig` 表，不混入 `UserPreference` |
| B3 | **前端无角色隐藏先例**：`App.tsx:90-96` 的 `AuthGuard` 只校验 `isAuthenticated`；设置页 4 个 Card 无按角色条件渲染；`UserPublic` 无 `role` | `web/src/App.tsx`、`pages/settings.tsx:289/375/679/732`、`api/types.ts:296` | 需新增 `useIsAdmin()` + 侧边栏/路由门控 |
| B4 | **无权限拒绝业务码**：现有 `BusinessErrorCode` 只有 `UNAUTHORIZED=1001(401)`、`TOKEN_EXPIRED=1002(403)`，无 FORBIDDEN 类 | `backend/app/core/enums.py:11-28` | 需新增 `FORBIDDEN = 4001 (HTTP 403)` 并补状态码映射 |

---

## 3. 核心设计决策

### D1 · 角色模型（源真相在 DB，JWT 仅做前端便利缓存）
- `User` 新增 `role` 列（`String(20)`，默认 `"user"`，非空），由 Python 枚举 `UserRole(user="user", admin="admin")` 约束取值。
- **注册默认 `role="user"`**，`UserService.register(email, password, name, role="user")`。
- **JWT 写入 `role`**（仅前端判断显示用，不用于后端授权）。
- **后端授权以查库为准**：扩展 `CurrentUser` 携带 `role`（在 `get_current_user` 已 `select(User)` 的现有查库结果上顺带取 `user.role`，零额外查询）；新增依赖 `require_admin` = `get_current_user` 后校验 `current_user.role == "admin"`，否则抛 `FORBIDDEN(4001,403)`。
  - 理由：避免「改了角色但旧 JWT 仍有效」的陈旧授权问题；现有鉴权链已经是「查库确认用户存在」，扩展成本为零。

### D2 · 配置存储（新建 `SystemConfig` 表，key/value）
- 新建 `system_configs` 表：`id | key(VARCHAR, UNIQUE, NOT NULL) | config_value(JSONB, NOT NULL) | description | updated_by | updated_at`。
- 配置 key：`securities_quote_api_base_url`（value = `{ "url": "https://..." }`，JSON 便于未来扩展代理/超时等字段）。
- **首次启动种子**：若 DB 无该 key，读取环境变量 `SECURITIES_QUOTE_API_BASE_URL` 作为初始值写入；两者皆空则存 `""`。
- 提供 `SystemConfigService.get(key)` / `.set(key, value, actor_id)`；以及面向行情消费者的便捷函数 `get_quote_api_base_url() -> str`（优先 DB，回退 env）。
- **不塞进 `UserPreference`**：后者有 per-user 归属隔离白名单语义，混入会破坏隔离模型；独立表还可复用于未来其它全局项。

### D3 · 前端按角色隐藏（三重保险，UI 落点已拍板见 D1）
1. `UserPublic` 增加 `role`；`auth.store` 派生 `isAdmin`；新增 `useIsAdmin()` hook。
2. **侧边栏新增「系统管理」入口，仅 `isAdmin` 可见**；配置表单承载于独立的 `/admin` 页面（route 受 `AuthGuard` 包裹，页面内再按 `isAdmin` 渲染）。
3. 新 hook `useSystemConfig(key)` / `useUpdateSystemConfig(key)` 以 `enabled: isAdmin` 守护 —— 普通用户登录后**根本不会发起** admin 端点请求（纵深防御，不只靠 UI 隐藏）。

---

## 4. 后端改动清单（带落点）

| 文件 | 改动 |
|---|---|
| `backend/app/core/enums.py` | 新增 `FORBIDDEN = 4001`，并补 `HTTP_STATUS_MAP` 中 `4001 → 403`（参考 L34/L43 现有写法） |
| `backend/app/core/enums.py` | 新增 `class UserRole(str, Enum): USER="user"; ADMIN="admin"` |
| `backend/app/models/user.py` | `User` 加 `role: Mapped[str] = mapped_column(String(20), default="user", nullable=False)` |
| `backend/app/core/security.py` | `CurrentUser` 增加 `role` 字段；`get_current_user` 末行改为 `return CurrentUser(user_id=user.id, email=user.email, role=user.role)`；新增 `async def require_admin(current: CurrentUser = Depends(get_current_user)) -> CurrentUser: if current.role != "admin": raise BusinessException(FORBIDDEN…)` |
| `backend/app/services/user.py` | `register(..., role: str = "user")` → 设 `user.role`；登录/签发 token 处把 `role` 写入 JWT payload（改 `create_access_token` 或 `issue_token`） |
| `backend/app/core/security.py` | `create_access_token(sub, email)` → `create_access_token(sub, email, role)`，payload 加 `"role": role` |
| `backend/app/models/system_config.py` | 新建 `SystemConfig(Base, TimestampMixin)`：`key/value(JSONB)/description/updated_by` |
| `backend/app/services/system_config.py` | `SystemConfigService`：`get(key)` / `set(key, value, actor_id)` / `get_quote_api_base_url()`（回退 env） |
| `backend/app/modules/system_config/router.py` | 新建 admin 路由：`GET /api/admin/system-config/{key}`、`PATCH /api/admin/system-config/{key}`，均依赖 `Depends(require_admin)`；复用 `EnvelopeRoute` + 信封序列化 |
| `backend/app/main.py`（或 routers 聚合处） | 注册 `system_config` router（路径前缀 `/api/admin`） |
| `backend/alembic/versions/xxxx_*.py` | 迁移：① `users` 加 `role` 列（含 `server_default='user'` 与回填老数据）② 建 `system_configs` 表；种子写入 `securities_quote_api_base_url` |
| `backend/scripts/bootstrap_admin.py`（新增） | 一次性脚本：按 `BOOTSTRAP_ADMIN_EMAIL` 将指定用户 `role` 置为 `admin`（首个管理员引导，见 §9-D4，已拍板） |

---

## 5. 前端改动清单

| 文件 | 改动 |
|---|---|
| `web/src/api/types.ts` | `UserPublic` / `UserProfile` 增加 `role: 'user' \| 'admin'` |
| `web/src/stores/auth.store.ts` | `AuthState` 增加 `isAdmin: boolean`（由 `user?.role === 'admin'` 派生）；`loadInitialState` 与 `setUser` 同步 |
| `web/src/hooks/use-auth.ts`（或 `use-user.ts`） | 新增 `useIsAdmin()` → `useAuthStore(s => s.isAdmin)` |
| `web/src/hooks/use-system-config.ts`（新增） | `useSystemConfig(key)`（GET，`enabled: isAdmin`）、`useUpdateSystemConfig(key)`（PATCH） |
| `web/src/api/admin.api.ts`（新增或并入 config.api） | `getSystemConfig(key)` / `updateSystemConfig(key, value)` 封装 |
| `web/src/pages/admin.tsx`（新增） | 独立「系统管理」页，承载「管理员配置」表单：「证券行情 API 地址」`Input` + 保存按钮 + 说明文案（复用 `settings.tsx:604` 同款模式）；整页按 `isAdmin` 渲染 |
| `web/src/components/layout/sidebar.tsx` | 新增「系统管理」入口，**仅 `isAdmin` 可见**（普通用户侧边栏无此项） |
| `web/src/App.tsx` | 新增 `/admin` 路由，受 `AuthGuard` 包裹（后端 `require_admin` 为最终防线；前端仅做入口隐藏） |

---

## 6. 权限双保险总结

| 层 | 机制 | 普通用户结果 |
|---|---|---|
| 后端路由 | `Depends(require_admin)` 查库校验 | 直接 `403 / FORBIDDEN(4001)`，拿不到配置 |
| 前端 UI | 侧边栏「系统管理」仅 `isAdmin` 可见 + `/admin` 页内按 `isAdmin` 渲染 | 普通用户侧边栏无入口、直接访问 `/admin` 也被后端 `require_admin` 拦 |
| 前端请求 | hook `enabled: isAdmin` | 普通用户登录后**不发** admin 端点请求 |
| 数据模型 | 配置存 `system_configs`，与 `UserPreference` 隔离 | 即使越权也拿不到他人数据 |

---

## 7. 测试策略

**后端（pytest）**
- `test_security.py`：`require_admin` 对 `role=user` 返回 403、对 `role=admin` 通过；改角色后旧 JWT 仍按 DB 实时判定（陈旧 JWT 不绕过）。
- `test_system_config.py`：admin 可读/写 `securities_quote_api_base_url`；非 admin 写 → 403；`get_quote_api_base_url()` 在无 DB 行时回退 env。
- 迁移测试：conftest 自动建表后 `users.role` 默认 `user`、`system_configs` 有种子行。

**前端（vitest）**
- `admin.test.tsx`（新增）：mock `isAdmin=false` → 断言「证券行情 API 地址」`queryByText` 为 null、侧边栏无「系统管理」项；mock `isAdmin=true` → 断言表单可见且保存调用 admin 端点。
- `use-system-config.test.tsx`：`isAdmin=false` 时 query `enabled=false`，不发请求；`isAdmin=true` 时正常拉取。

---

## 8. 文档回填（PRD / ARCHITECTURE）

- **PRD.md**：新增「角色与权限」需求池（`AUTH-P0-01` 角色模型、`SYS-P0-01` 管理员配置）；设置页分区表补「系统管理区 → `/admin`」（标注仅 admin 可见）；`ACC/SET` 不受影响。
- **ARCHITECTURE.md**：§4.2 路由表补 `/api/admin/system-config/{key}`（GET/PATCH，依赖 `require_admin`）+ 前端 `/admin` 路由；`§4.2.16` 职责重划注补「管理员专属配置收口 `/api/admin` 与 `/admin` 页，普通用户不可见不可改」；新增「角色模型」小节（`User.role` + JWT 缓存 + `require_admin` 查库校验）。

---

## 9. 开放决策点（D1/D4 已拍板，D2/D3 待定）

**D1 · UI 落点 — ✅ 已拍板：独立 `/admin` 页 + 侧边栏「系统管理」入口（仅 admin 可见）**
- 见 §3-D3、§5、§6。普通用户侧边栏无此项、直接访问 `/admin` 也被后端 `require_admin` 拦截。

**D2 · `role` 列类型 — ✅ 已拍板：`String(20)` + Python 枚举 `UserRole`**
- 选定：`String(20)` + Python 枚举 `UserRole(user="user", admin="admin")`（与 §3-D1 落点一致）。
- 理由：迁移一行 `ALTER TABLE users ADD COLUMN role VARCHAR(20) NOT NULL DEFAULT 'user'`，可逆、零原生枚举回退坑；未来加角色（如 `analyst`）只改 Python 枚举、不动库表。
- 否决：原生 PG 枚举 `userrole`（与现有 8 个业务枚举风格一致，但 `ALTER TYPE ADD VALUE` 旧版 PG 事务块限制 + downgrade 删除顺序坑多，收益不及成本）。

**D3 · 是否现在接行情消费者 — ✅ 已拍板：仅存配置 + 提供 `get_quote_api_base_url()` 读取入口**
- 选定：本方案只做「配置存储 + 管理员 CRUD + 权限门控」骨架，并落地 `get_quote_api_base_url() -> str`（优先 DB，回退 env）供未来行情客户端消费。
- 否决：顺带写最小行情 Client（超出「配置模块」范围，引入网络/限流/解析风险；当前后端无任何行情代码，半成品 Client 不如干净骨架 + 明确读取接口）。
- 后续：完整 AKShare / 行情引擎接入单独立 Phase，届时直接调用 `get_quote_api_base_url()` 即可拿到管理员配的地址。

**D4 · 首个管理员如何产生 — ✅ 已拍板：环境变量 `BOOTSTRAP_ADMIN_EMAIL` + 一次性 `backend/scripts/bootstrap_admin.py`**（见 §4 脚本行）

---

## 10. 实施步骤（可整体派给团队）

1. 后端：枚举 + `User.role` + `require_admin` + JWT 写 role（B1/B4 闭环）
2. 后端：迁移（users.role + system_configs + 种子）
3. 后端：`SystemConfig` 模型/服务/admin 路由 + 注册到 main
4. 后端：bootstrap_admin 脚本 + 测试
5. 前端：types + auth.store + useIsAdmin + useSystemConfig + admin.api
6. 前端：admin 页表单 + 侧边栏条件项 + `/admin` 路由 + 测试
7. 文档回填（PRD/ARCHITECTURE）
8. 回归：后端 pytest + 前端 vitest 全绿；`tsc --noEmit` 0 错

---

## 11. 风险与回退

- **迁移风险**：`users.role` 加列需对存量数据回填 `server_default='user'`；Alembic 走 `compare_type=True` 自检精度。回退：迁移 `downgrade` 删列（单列为可逆，风险低）。
- **授权绕过风险**：严禁仅靠 JWT `role` claim 做后端授权 —— 必须 `require_admin` 查库（见 D1）。
- **普通用户误触风险**：前端 `enabled: isAdmin` 守卫 + 条件渲染双重保险；即使前端被绕过，后端 `require_admin` 仍是最终防线。
- **范围蔓延风险**：明确不本方案内接行情引擎（见 D3），避免把「配置模块」做成「行情系统」。
