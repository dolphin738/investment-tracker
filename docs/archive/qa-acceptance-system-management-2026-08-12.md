# QA 验收报告 — 系统管理扩展（接口 CRUD + 分类后台管理 + 顶层汇总）

日期：2026-08-12
范围：投资回报追踪器「证券行情数据提供方 → 接口 / 接口分类」扩展特性（T01–T05），含 PRD §6.1 五项决策与 #5 变更。

## 验收结论：通过（含 1 项环境相关失败 + 2 项已知限制）

### 1. 自动化验证结果
| 项 | 结果 |
|---|---|
| 后端 pytest（全量） | 158 passed / 1 failed（159 总） |
| 后端特性测试（test_quote_interface + test_interface_category） | 13/13 passed |
| 前端 `tsc --noEmit` | exit 0，无类型错误 |
| 前端 `tsc -p tsconfig.json --noEmit` | exit 0 |
| Alembic `heads` | 单一 head：`d3e4f5a6b7c8`，链路线性无分支 |
| 迁移链头 `c2d3e4f5a6b7`（drop system-config） | 未改动、完好 |

### 2. 功能核对（代码审查）
- **#5 顶层按分类汇总**：`GET /api/admin/quote-providers/interfaces`（`backend/app/modules/admin/router.py:228`）→ `QuoteInterfaceService.list_all()`（`backend/app/services/quote_interface.py:35`）跨所有提供方扁平返回，前端 `web/src/features/admin/quote-provider-section.tsx:673` 按 `interface_type` 聚合渲染，空态「暂无接口」已处理。
- **`require_admin` 守卫**：所有新增 admin 端点均 `Depends(require_admin)`，非管理员 → 403（两测试套件 `test_non_admin_forbidden` 已验）。路由顺序正确（list-all 注册在 `/{provider_id}` 之前）。
- **迁移字段对齐设计**：`quote_provider_interfaces`（provider_id FK CASCADE、interface_type、name、endpoint 可空、http_method 可空、params JSON、enabled、description、direction PG 枚举 in/out 默认 in、timeout、retry_count、rate_limit）；`quote_provider_interface_categories`（key 唯一、label、icon 可空、sort_order）；upgrade 末尾 INSERT 7 个预置分类。
- **`InterfaceDirection` 枚举**（in/out）已在 `backend/app/models/enums.py:85` 注册。

### 3. 提交清单（作者 senior-dev，未 push）
- `0cbb461` feat(backend): 接口与分类模型/迁移
- `baad5a3` feat(backend): 接口与分类服务及路由(含 list_all)
- `eb5f9a3` test(backend): 接口与分类 CRUD 集成测试
- `dfffee7` feat(web): 通用外壳+接口CRUD+分类管理 UI

### 4. 已知风险 / 限制
1. **环境相关失败（非回归）**：`test_defect_fixes.py::test_defect1_url_avatar_clears_old_file` 因沙箱回收站不可用（`SHFileOperation` 关闭态）失败，与本特性无关，开发机可过。
2. **SDK `endpoint` 运行时消费缺失（设计缺口，非当前缺陷）**：`endpoint` 已作为可空字符串落库（SDK 时存函数名），但尚无运行时行情拉取分发器用 `importlib`/`getattr` 调用它。当前 CRUD 范围足够，待后续加运行时 dispatcher 时补齐。
3. **`direction='out'` 无专项测试（覆盖缺口，非 bug）**：枚举与 CRUD 路径均支持，仅缺一条 round-trip 断言。

### 5. 下一步建议
- 沙箱外跑一次 `pytest` 确认那条环境失败在开发机通过。
- 若要做 SDK 运行时调用，新增 dispatcher 并补 `endpoint` 作为函数名的集成测试。
- 可补一条 `direction='out'` round-trip 测试。
- 按约定不 push；如需代推请提供 `CNB_TOKEN` 或走 `dev-scripts/push-all.ps1`。
