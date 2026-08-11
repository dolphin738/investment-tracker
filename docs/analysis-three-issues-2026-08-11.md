# 三项产品功能问题：根因分析与实现指令（2026-08-11）

> 面向代码开发助手（software-engineer）的清晰指令已据此下发并执行，本文记录分析结论与落地差异。

## ① 出入金管理页「类型筛选器」（存入/取出）点击无效

### 根因（已定位，关键结论）
**不是前端事件绑定或状态处理缺陷，而是后端缺失 `types` 过滤。**

前端链路完全正确，全链路都正确携带了类型参数：
- `transactions.tsx` 复选框 `onChange → handleToggleType(t)` 写入 URL `types=BUY`；
- `parseTransactionSearchParams` → `types` 数组；
- `<CashflowList types={types} />` → `useTransactions` → `listTransactions` 发送 `?types=BUY`（`transaction.api.ts` 已对 `types` 做逗号 join）。

但后端 `app/modules/data/router.py:68` 的 `list_cashflows` 端点**只声明** `startDate/endDate/page/pageSize`，**未声明 `types` 参数**，FastAPI 直接忽略前端传入的 `types`；且 `CashflowService.list_stmt`（`app/services/cashflow.py:27`）只按日期过滤。结果：无论前端怎么选，服务端都返回全部记录。

### 已执行的实现指令（后端 2 处 + 测试）
1. `router.py` `list_cashflows`：
   - 导入 `Query` 与 `CashFlowType`；
   - 新增 `types: Optional[str] = Query(None, description="逗号分隔类型过滤，如 BUY 或 BUY,SELL；非法值忽略")`；
   - 按白名单 `(BUY, SELL)` 解析为枚举列表后传给 `list_stmt`。
2. `cashflow.py` `list_stmt`：新增 `types: list[CashFlowType] | None = None`，非空时 `stmt = stmt.where(CashFlow.type.in_(types))`（空列表/None = 全部，与「不勾选=全部」一致）。
3. 新增 `tests/test_cashflow_type_filter.py`：覆盖 `BUY` / `SELL` / `BUY,SELL` / 无参=全部 / 非法值 `FOO` 被忽略五类场景。

### 验证
- 后端 pytest：类型筛选测试 2/2 通过；cashflow 相关回归（test_api_phase4_modules / crud_recalculation / defect_fixes / future_date_validation）均通过，唯一失败为 sandbox 回收站不可用的**已知环境**问题（头像文件清理，与本次无关）。
- 提交：`e6d04a7`。

---

## ② 按钮布局：「录入现金余额」移至「录入出入金」左侧并水平并排

### 现状 → 目标
- **现状**：`录入出入金` 在页头右上角（独立 `<Button>`）；`录入现金余额` 在「现金余额」页签的「当前余额」行右侧（独立 `<Button>`）。两者分散在两处。
- **目标**：在页头右侧做按钮组——`录入现金余额`（左）+ `录入出入金`（右），水平并排、共用同一规格（主色 + sm + Plus），视觉对齐、操作便捷。

### 已执行的实现指令（`web/src/pages/transactions.tsx`）
1. 页头右侧原独立「录入出入金」`<Button>` 替换为按钮组容器：
   ```tsx
   <div className="flex items-center gap-2">
     <Button onClick={openCreateBalance} variant={ENTRY_BUTTON_VARIANT} size={ENTRY_BUTTON_SIZE}>
       <Plus className={ENTRY_BUTTON_ICON_CLASS} />{ENTRY_BUTTON_LABELS.cashBalance}
     </Button>
     <Button onClick={() => setOpen(true)} variant={ENTRY_BUTTON_VARIANT} size={ENTRY_BUTTON_SIZE}>
       <Plus className={ENTRY_BUTTON_ICON_CLASS} />{ENTRY_BUTTON_LABELS.cashFlow}
     </Button>
   </div>
   ```
2. 删除「现金余额」页签「当前余额」行里的「录入现金余额」`<Button>`（入口统一到页头），空态文案改为引导至右上角「录入现金余额」。
3. `openCreateBalance` 现仅被页头与 FLOW-P0-06 软提示引用，无 unused 告警。

### 验证
- 前端 `tsc --noEmit` 零报错；`cashflow` 相关 vitest 8/8 通过。
- 提交：`b5c49ee`。

---

## ③ 模块融合可行性：设置「组合管理」 vs 账户「我的组合」

### 两模块现状（基于实际代码）
| 维度 | 设置页「组合管理」(`pages/settings.tsx:796`) | 账户页「我的组合」(`pages/AccountPage.tsx:389`) |
|---|---|---|
| 定位 | 组合的**完整管理后台**（CRUD） | 组合的**只读业绩视图** + 快捷切换 |
| 列 | 名称 / 描述 / 成立日 / 币种 / 操作 | 名称 / 成立日 / 币种 / 最新总资产 / 净值 / 当年% / 更新日 |
| 操作 | 设为默认(★) / 编辑(✎) / 归档 / 删除 | 点击行 → 切换组合并跳概览；右上 `[+新建组合]` |
| 数据源 | `usePortfolios()`（基础字段） | 组合 summary（含 totalAsset / cumulativeNav / 当年收益等计算字段） |
| 设计意图 | 配置入口（`/settings` 全站唯一修改入口） | 个人概览（App.tsx 注释：`/account` 受保护、**只读**） |

### 重合度评估
- **高重合**：两者都列举组合、都提供「新建」、都支持切换当前组合（设置用 `setCurrentPortfolio`，账户用 `handleOpenPortfolio`→跳概览）。列表表格与「新建」按钮存在重复实现。
- **低重合**：设置侧是**管理动作**（编辑/归档/删除/默认），账户侧是**性能展示**（总资产/净值/当年%）与**进入入口**。这是两者无法简单互换的本质差异。

### 是否建议合并？→ **建议「部分统一」，而非生硬二合一**
**推荐方案**：以「设置 → 组合管理」为**唯一管理平面**，升级为统一表格，新增性能列（最新总资产/净值/当年%）与管理操作列（默认/编辑/归档/删除）于一表；账户页「我的组合」退化为**轻量快捷切换器**（保留行点击跳转 + 新建入口，或干脆移除、由统一模块承接）。

**预期收益**
1. 单一数据源与单一管理入口，消除「新建按钮 + 列表 + 切换逻辑」的重复实现与行为分歧。
2. 用户在一处即可完成「看业绩 + 管配置」，减少在设置/账户间反复跳转。
3. 账户页「我的组合」当前缺少编辑/删除，用户却往往在此想管理——合并后消除该预期落差。

**潜在风险**
1. **违背账户页「只读」设计契约**：App.tsx 明确 `/account` 为只读。把删除/归档等高危操作放进账户页会破坏该约束；故建议管理动作保留在设置页，账户页只做查看/切换。
2. **性能成本上移**：账户 summary 含净值/收益等重计算；若并入设置页需在该页额外拉取计算字段，增加设置页加载负担。
3. **信息架构混淆**：设置=配置、账户=个人概览，把管理 CRUD 混入概览会模糊两页职责边界。
4. **迁移风险**：现有两个列表的切换语义不同（设置=设当前、账户=跳概览），合并需统一导航意图，避免破坏用户既有心智。

### 给代码开发助手的指令（待用户拍板后执行）
- **不立即实施**：本项为分析结论，需用户确认「部分统一」方案后再立任务。
- 若批准：以 `settings.tsx` 的「组合管理」为基座，复用 `AccountPage` 的 summary 查询补齐性能列，新增管理操作列；`AccountPage` 的「我的组合」卡片改为指向设置页的轻量入口或保留只读快捷切换。
- 涉及 `usePortfolios` / 组合 summary hook 的数据聚合，注意分页与归档组合（归档仅在设置页可见）的展示差异。

---

## 提交汇总（本批）
| commit | 内容 |
|---|---|
| `e6d04a7` | fix(backend): 出入金列表支持 types 类型过滤（修复类型筛选器无效） |
| `b5c49ee` | fix(web): 出入金页录入按钮并排，录入现金余额移至录入出入金左侧 |

未 push（按约定改动完自动提交但不 push）。③为分析项，未落地代码。
