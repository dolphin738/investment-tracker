# 接口分类改版方案：固定 2 类 + 废弃 `InterfacePurpose`

> 文档初版：2026-08-15
> 修订（可行性评估 + 按代码现实修正）：2026-08-16
> 二次复核（priority 论断纠正 + 种子迁移 key 列消解）：2026-08-16
> 决策：接口分类固定为「证券列表」「证券行情」2 类，分类即用途，`InterfacePurpose` 废弃
> 相关代码：模型、服务、路由、前端全部涉及

---

## 〇、可行性评估与修订记录（2026-08-16）

### 结论
**方案可实行。** 核心思路（把"分类 + 用途"两套维度合并为固定 2 类、路由改按 `category_id`）与代码现实一致。但原方案部分细节是"凭设想写的"，已用 **codebase-memory MCP** 核对真实代码，需按代码现实修正后落地。二次复核纠正了 priority 链误判、消解了种子迁移 key 列隐患，见下表修正⑤ / 修正④。

### 用户补充
1. **无需考虑存量数据** → 迁移段大幅简化：删 `purpose` 列 + `DROP TYPE interfacepurpose`；加 `system` 列；`DELETE` 全部旧分类（接口 `category_id` 因 `ON DELETE SET NULL` 自动置空）；`INSERT` 2 个固定 system 分类。**完全跳过原 §2.1 step2「旧类归并」逻辑**（那是给存量数据准备的）。

### 已用 codebase-memory MCP 核实的真实情况（对照原方案条款）
| 原方案假设 | 代码现实（已核实） | 结论 |
| --- | --- | --- |
| 2.1 `InterfaceCategory` 加 `system` 列 | 模型当前**无 `system` 列**（仅 id/label/icon/sort_order） | 需新增迁移 ✓ |
| 2.1 预置分类"缩减为 2 条" | 种子迁移 `d3e4f5a6b7c8` 用 `gen_random_uuid()` 插 7 类；`key` 列在 `f5a6b7c8d9e0` 已删除，迁移链执行后 schema 与模型一致，**不会报错** | ✓（无需修种子迁移） |
| 一注"无 priority 字段" | **错误**：`QuoteInterface.priority` 字段存在（模型 L63、迁移 g6b7c8d9e0f1），`fallback_fetch` 已按 priority 升序做降级链（market_data_sync L314-316 / L777-779），正是需求 3 要求的行为 | ⚠️ 见修正⑤ |
| 2.1 删 `purpose` 列 | `purpose` 是 `SA_ENUM(InterfacePurpose, name="InterfacePurpose")` **原生 PG 枚举**，`server_default=QUOTE` | 迁移须 `DROP TYPE` ✓ |
| 2.2 `sync_security_masters` 按 `purpose==MASTER_LIST` | 已确认（L762），改为 `category_id==固定ID` 可行 | ✓ |
| 2.2 `sync_portfolio_prices` 遍历 distinct category | 已确认（L725-731 遍历所有 enabled 分类调 `fallback_fetch`）→ 改为只查 `cat_quote` 单调用**可行，且顺手修掉当前"主数据分类也被当行情源"的潜在 bug** | ✓（更优） |
| 3.3 前端移除「用途」Select | 前端确有 `PURPOSE_OPTIONS`(L63)、`FormState.purpose`(L103)、下拉(L360-369)；`quote-interface.api.ts` 的 `QuoteInterface`/`Create`/`Update` 类型均含 `purpose` | 移除是真实改动 ✓ |

### 必须修正的点（已并入下方各节）
1. 迁移在"无需存量数据"下大幅简化（见 §2.1 修订）。
2. 固定 ID 用**显式固定 UUID + 代码常量**，不靠 `gen_random_uuid()`（`key` 列已由后续迁移删除，模型不依赖它；固定 UUID 便于代码硬编码路由，不受重建影响）。
3. **别动 `make_token`/`import_commit` 里的 `purpose`**——那是数据导入 JWT 的 claim（`purpose="dt_import"`），与接口用途无关，删除时会误伤。本方案只删 `QuoteInterface.purpose`。
4. 种子迁移 `d3e4f5a6b7c8` 的 `key` 列不一致**无需处理**：`key` 列由 `f5a6b7c8d9e0` 正常删除，迁移链顺序执行后 schema 与模型一致，新鲜库不会报错。reform 迁移不引用 `key`（用固定 UUID 路由）。
5. 前端 categoryId 下拉"自然只剩 2 项"成立，但 §3.1 移除新增/删除按钮需配套：后端 `InterfaceCategoryService.delete` 当前无 `system` 守卫，要加 `system==true → 400`；`create` 加同名校验。
6. 测试要改：`test_stock_master_and_resolve.py` 多处 `purpose="MASTER_LIST"` 需改为置 `category_id=MASTER_LIST_CAT_ID`（fixture 改造）。
7. **修正⑤**：§一注"无 priority 字段"是**误判**——`priority` 字段与 fallback 降级链已存在，方案**保留** priority 机制（不做任何新增/删除），仅把选分类从 `purpose` 改为固定 `category_id`。见下方 §一注修订。

> 实施提示：开发库迁移仍按约定需用户 `alembic upgrade head` 生效（沙箱不改动开发库；测试库由 conftest 自动升级）。

---

## 一、概览

### 现状问题
当前接口有**分类**（`InterfaceCategory`，自由配置，种子迁移预置 7 类）和**用途**（`InterfacePurpose: QUOTE / MASTER_LIST`）两套独立维度，运行时按 `category_id`（行情 fallback）或 `purpose`（主数据同步）分别选源，冗余且不直观。

### 改版后模型
| 分类 | 固定 id（显式常量） | 用途 | 运行时行为 |
| --- | --- | --- | --- |
| **证券列表** | `MASTER_LIST_CAT_ID = "1"` | 主数据拉取 | 对该分类调用，取到数据后去重 upsert 到 securities 目录表 |
| **证券行情** | `QUOTE_CAT_ID = "2"` | 价格行情 | 对该分类调用 `fallback_fetch` |

> 注：原方案"按 priority 依次调用（优先链）"**保留**——`QuoteInterface.priority` 字段已存在（模型 L63、迁移 g6b7c8d9e0f1），`fallback_fetch` 已按 `priority` 升序做降级链（market_data_sync L314-316 / L777-779）。这正是需求 3 要求的行为：取到非空数据即停，无响应/空数据换下一个 priority。本方案**不新增也不删除 priority**，仅把"选哪个分类"从 `purpose` 改为固定 `category_id`。

分类即用途，不再需要独立 `InterfacePurpose` 枚举。

---

## 二、后端改动（按代码现实修订）

### 2.1 模型 (model)

**InterfaceCategory** — 新增 `system` 固定标识（当前模型无该列，需迁移加）

```python
# backend/app/models/interface_category.py
class InterfaceCategory(Base, TimestampMixin):
    __tablename__ = "quote_provider_interface_categories"

    id: Mapped[str] = pk_uuid()
    label: Mapped[str] = mapped_column(String(128), nullable=False)
    icon: Mapped[Optional[str]] = mapped_column(String(64), nullable=True)
    sort_order: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    system: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=False, server_default=false(),
        comment="系统内置分类（不可删除，不可新增同名）",
    )
```

**QuoteInterface** — 删除 `purpose` 列与 `InterfacePurpose` 引用（保留 `asset_class`）

```python
# backend/app/models/quote_interface.py
# 删除：purpose: Mapped[InterfacePurpose]  ← 整列移除（含 SA_ENUM 原生 PG 枚举）
# 保留：asset_class（主数据同步时按资产类别过滤仍需要）
```

**迁移**（一条新 migration：`xxx_reform_2_categories.py`）—— 按"无需存量数据"简化：

1. `quote_provider_interface_categories` 新增 `system` 列（Boolean，default false）
2. `DELETE FROM quote_provider_interface_categories`——清空旧 7 类（无存量数据，跳过旧类归并）
   - 受影响接口 `category_id` 因 FK `ON DELETE SET NULL` 自动置空（**实施时需确认 FK 行为**；若级联则先置 NULL 再删分类）
3. `INSERT` 2 个固定 system 分类（**显式固定 id（数字 1/2），不依赖 `key` 列、不用 `gen_random_uuid()`**）：
   - `id='1'`, `label='证券列表'`, `system=true`
   - `id='2'`, `label='证券行情'`, `system=true`
4. 删除 `quote_provider_interfaces.purpose` 列（`ALTER TABLE ... DROP COLUMN purpose`）
5. `DROP TYPE interfacepurpose`（PG 枚举类型清理）

> **修正④（已消解）**：种子迁移 `d3e4f5a6b7c8` 虽曾含 `key` 列引用，但 `key` 列已由后续迁移 `f5a6b7c8d9e0` 正常删除，迁移链顺序执行后 schema 与模型一致，**新鲜库不会报错，无需修复种子迁移**。reform 迁移不引用 `key` 列，用固定 UUID 路由。

### 2.2 服务 (service)

**InterfaceCategoryService**
| 方法 | 改版后 |
| --- | --- |
| `list()` | 不变 |
| `get()` / `get_or_none()` | 不变 |
| `create()` | 检查不可创建与已有 `system=true` 分类同名的分类（同名校验） |
| `update()` | 不变（可改 label/icon/sort_order） |
| `delete()` | **新增 `system==true → 400` 守卫**（原无，需补） |

**MarketDataSyncService**
| 方法 | 变化 |
| --- | --- |
| `sync_security_masters(asset_class)` | 筛选条件从 `purpose==MASTER_LIST` 改为 `category_id == MASTER_LIST_CAT_ID`；`asset_class` 筛选保留 |
| `sync_all_security_masters()` | 同上，改为按 `category_id==MASTER_LIST_CAT_ID` 过滤 |
| `sync_portfolio_prices(portfolio_id)` | 不再遍历 ALL categories，只查 `category_id == QUOTE_CAT_ID` 的接口，对该分类调用 `fallback_fetch`（顺带修掉当前"主数据分类也被当行情源"的潜在 bug） |
| `fallback_fetch(category_id, codes)` | **逻辑不变**（已按 priority 降级链），调用方改为只传 `QUOTE_CAT_ID` |

改动示例：

```python
# backend/app/services/market_data_sync.py
MASTER_LIST_CAT_ID = "1"
QUOTE_CAT_ID       = "2"

# sync_security_masters：旧 QuoteInterface.purpose == InterfacePurpose.MASTER_LIST
#                       新 QuoteInterface.category_id == MASTER_LIST_CAT_ID
# sync_portfolio_prices：旧遍历 distinct category_id；新只查 QUOTE_CAT_ID
```

> **修正③**：切勿删除 `make_token` / `import_commit` 中的 `purpose` 字段——那是数据导入 JWT 的 claim（`purpose="dt_import"`），与接口用途无关，误删会破坏导入鉴权。本方案只删 `QuoteInterface.purpose`。

### 2.3 路由 (router)

**InterfaceCategory 路由**（`/api/admin/interface-categories`）
| 端点 | 变化 |
| --- | --- |
| `GET @list` | 不变 |
| `GET /{id}` | 不变 |
| `POST @create` | 新增 `system` 字段校验：不可创建 `label` 与已有 system 分类同名 |
| `PATCH /{id}` | 不变 |
| `DELETE /{id}` | 新增校验：`system==true` 返回 400 |

**QuoteInterface 路由**（`/api/admin/quote-providers/{provider_id}/interfaces`）
| 变化 |
| --- |
| `QuoteInterfaceCreate` 移除 `purpose` 字段 |
| `QuoteInterfaceUpdate` 移除 `purpose` 字段 |
| `QuoteInterfaceOut` 移除 `purpose` 字段 |

---

## 三、前端改动

> 以下文件名均经 glob 核实真实存在。

### 3.1 接口分类管理（`interface-category-section.tsx`）
- 移除「新增分类」按钮
- 移除每行的「删除」按钮
- 列表仅展示 2 行（证券列表 / 证券行情），不可删除、不可新增
- 编辑按钮保留（可改名称/图标/排序）
- **配套**：后端 `delete` 已加 `system==true→400` 守卫（见 §2.2），前端可省略二次确认但保留后端兜底

### 3.2 接口分类对话框（`interface-category-dialog.tsx`）
- 移除「新增分类」模式（`editing==null` 时不可打开）
- 只保留编辑模式

### 3.3 接口新增/编辑对话框（`quote-interface-dialog.tsx`）
- 「基本信息」页签中移除**「用途」** Select 字段（移除 `PURPOSE_OPTIONS`、`FormState.purpose` 及相关 JSX）
- 接口分类 `categoryId` 的 Select 下拉只显示 2 个固定选项：证券列表 / 证券行情（数据来自 `GET /api/admin/interface-categories`，因系统仅 2 条自然只剩 2 项）

### 3.4 按分类汇总面板（`quote-provider-section.tsx`，`InterfacesByCategoryOverview`）
- 分组逻辑不变（按 `category_id`），自然只有 2 个分组
- 若某分类无接口，显示「暂无接口」占位

### 3.5 股票列表和测试页（`stock-list-test-section.tsx`）
- 接口测试面板接口选择下拉仍按全部接口显示，无需改
- 主数据同步来源展示（`used`）不变

### 3.6 类型定义（API 层）
- `quote-interface.api.ts` 移除 `purpose` 字段类型（`QuoteInterface` / `QuoteInterfaceCreate` / `QuoteInterfaceUpdate` 三处）
- `interface-category.api.ts` 新增 `system?: boolean` 字段（表结构加列）

---

## 四、改动对照表

| 文件 | 改动级别 | 说明 |
| --- | --- | --- |
| `backend/app/models/interface_category.py` | 修改 | 加 `system` 列 |
| `backend/app/models/quote_interface.py` | 删除 | 移除 `purpose` 列、`InterfacePurpose` 引用 |
| `backend/app/models/enums.py` | 删除 | 移除 `InterfacePurpose` 枚举 |
| `backend/app/services/interface_category.py` | 修改 | create 同名校验 / delete 加 system 守卫 |
| `backend/app/services/market_data_sync.py` | 修改 | 主数据同步改 `category_id` 过滤；行情同步固定 `QUOTE_CAT_ID`；新增 2 个 UUID 常量 |
| `backend/app/modules/admin/router.py` | 修改 | 删 purpose schema 字段；分类路由加 system 校验 |
| `backend/alembic/versions/xxx_reform_2_categories.py` | 新增 | 迁移：system 列 + 清空旧类 + INSERT 2 固定类 + 删 purpose + DROP TYPE |
| `web/src/features/admin/interface-category-section.tsx` | 修改 | 移除新增/删除，只显示 2 行 |
| `web/src/features/admin/interface-category-dialog.tsx` | 修改 | 只保留编辑模式 |
| `web/src/features/admin/quote-interface-dialog.tsx` | 修改 | 移除用途字段；分类下拉只显示 2 类 |
| `web/src/features/admin/quote-provider-section.tsx` | 轻微 | 汇总面板自然只有 2 分组 |
| `web/src/api/quote-interface.api.ts` | 修改 | 移除 `purpose` 类型 |
| `web/src/api/interface-category.api.ts` | 修改 | 加 `system` 类型 |
| `backend/tests/test_stock_master_and_resolve.py` | 修改 | `purpose="MASTER_LIST"` → `category_id=MASTER_LIST_CAT_ID`（fixture 改造） |

---

## 五、边界情况（按"无需存量数据"修订）

- **无旧分类归并逻辑**：因无需存量数据，删 `purpose` 后直接清空旧分类、插入 2 固定类，跳过原 step2 的全部映射规则。
- **未分类接口**（`category_id IS NULL`）：删旧分类后置空的接口不参与主数据同步和行情 fallback，**首次运行前需在 UI 把接口归入 2 类之一**（如腾讯行情接口归「证券行情」、小熊同学列表接口归「证券列表」）。
- **多提供方同名接口**：同分类内按现有 `fallback_fetch` 遍历顺序（**priority 降级链已实现**），去重在 `(asset_class, code)` 唯一约束层面，不影响。
- **system 分类保护**：`delete` 后端返回 400 兜底；`rename` 不影响运行时（选源用 `category_id` 硬编码，不是 label）。

---

## 六、待决策（已在本修订中解决）

- ~~迁移时旧分类的 `purpose` 是否已有数据？按 label 还是 `purpose` 归入新 2 类？~~
  → **已消解**：用户明确"无需考虑存量数据"，直接清空旧类、插 2 固定类，无归并问题。
- ~~`cat_master_list` / `cat_quote` 用固定 UUID 还是自动生成后查取？~~
  → **已决定**：用**显式固定 UUID 常量**（见 §一 / §2.2），避免 `gen_random_uuid()` 随机性，便于代码硬编码路由。

---

## 七、建议实施顺序（落地时）

1. 后端：模型（interface_category 加 system / quote_interface 删 purpose / enums 删 InterfacePurpose）+ 常量
2. 后端：迁移（system 列 + 清空旧类 + 插 2 固定类 + 删 purpose + DROP TYPE）（种子迁移 `key` 列无需修复）
3. 后端：服务路由（InterfaceCategoryService 守卫、MarketDataSyncService 改 category_id、路由 schema 去 purpose）
4. 前端：去 purpose + 锁 2 类（`quote-interface-dialog` / `interface-category-*` / api 类型）
5. 测试：`test_stock_master_and_resolve.py` fixture 改造 + 跑 pytest / tsc / vitest
6. 最后由用户 `alembic upgrade head` 应用迁移（开发库）

---

## 八、落地记录（2026-08-15 实施完成）

### 实际产出

| 项 | 结果 |
| --- | --- |
| 改版迁移 | `backend/alembic/versions/o3d4e5f6a7b8_reform_2_categories.py`（`down_revision=n2c3d4e5f6g7`，现为 head） |
| 固定分类 id | `00000000-…-0001` 证券列表 / `00000000-…-0002` 证券行情，常量在 `market_data_sync.py` |
| 后端验证 | pytest **221 passed** |
| 前端验证 | `tsc --noEmit` 通过；vitest **502 passed / 47 files** |

### 实施中偏离方案的补充改动

1. **`InterfaceCategoryOut` 补 `system` 字段**：方案只写了模型加 `system` 列，漏了响应 schema。
   不补则前端拿不到该字段（TS 声明的 `system?: boolean` 会永远是 `undefined`），系统分类无法在 UI 标识。
2. **系统分类守卫收敛到 service 层**：初版在 router 与 `InterfaceCategoryService` 双写了
   「同名系统分类不可创建 / 系统分类不可删除」校验，已删掉 router 侧重复逻辑，保留 service 为单一事实来源
   （覆盖非 HTTP 调用方，避免两处逻辑漂移）。新增测试
   `test_system_category_cannot_be_deleted` / `test_create_category_with_system_label_rejected` 覆盖。
3. **分类板块文案与 badge**：`interface-category-section.tsx` 已无新增/删除入口，但 CardDescription
   仍写「删除分类不影响已有接口」，改为说明固定 2 类；并给 `system` 分类加「系统内置」badge。

### 顺带修掉的既有缺陷（与本改版无关，但阻塞测试）

- **`k0f1a2b3c4d5_split_security_model.py`（ADR-003 拆表迁移）无法执行**：`portfolio_securities.type`
  列用 `sa.Enum(SecurityType, …, create_type=False)` 定义，在 `op.create_table()` 场景下仍会发出
  `CREATE TYPE "SecurityType"`，而该类型早在基线迁移已建 → `DuplicateObjectError: type "SecurityType" already exists`，
  迁移链断在 `k0`，测试库 bootstrap（conftest 跑 `alembic upgrade head`）全数失败（42 errors）。
  改为兄弟迁移 `i8`/`j9` 已验证的写法 `postgresql.ENUM(SecurityType, name="SecurityType", create_type=False)`
  （`upgrade()` 与 `downgrade()` 两处）后恢复。
  排查干扰项：表象错误先报在 `n2` 的 `ALTER TYPE … RENAME VALUE 'FUND'`，那是反复失败留下的脏测试库导致的下游症状，非根因。
- **`o3` 迁移 `op.execute()` 传参方式错误**：`op.execute(text(...), {params})` 会抛
  `TypeError: execute() takes 2 positional arguments but 3 were given`（`op.execute` 只接受单个 SQL 表达式）。
  改为 `text(...).bindparams(...)`。同时 `downgrade()` 恢复 `purpose` 列的枚举改 `create_type=False`
  （类型在上一步已显式 `CREATE TYPE`，否则重复创建）。

### 用户待执行

- 开发库迁移**未应用**（约定：开发库不由 AI 改动）。需手动执行：
  `cd backend && ./.venv/Scripts/python.exe -m alembic upgrade head`
- 迁移会**清空旧 7 个分类**，原先归类的接口 `category_id` 因 FK `ON DELETE SET NULL` 被置空。
  升级后须在管理端把每个接口重新归入「证券列表」或「证券行情」，否则主数据同步与行情 fallback 都取不到接口。
