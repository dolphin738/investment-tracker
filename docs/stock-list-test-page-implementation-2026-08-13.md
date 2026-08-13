# 「股票列表和测试」分页 + §10 录入证券搜索 — 实现交付总结

> 日期：2026-08-13 · 依据：`docs/stock-list-test-page-design.md`（设计已全部拍板，11 项决策）
> 状态：**前端 502/502 用例通过、tsc --noEmit 零错误；后端 187 通过 / 1 失败（环境性）**；4 个提交（未 push）

## TL;DR

按设计文档执行完毕：后端前置依赖（T1/T1a/T7 后端）此前后端会话已实现，本会话补上**前端 T2–T6（核心分页）与 T7–T9（录入证券搜索）**，并对一处设计矛盾做了实现期修正（masters 端点鉴权放宽）。全链路测试通过，按特性拆分为 4 个 Conventional Commits。

## 交付概览

| 项 | 结果 |
|----|------|
| 后端测试 | 187 通过 / 1 失败（`test_defect1_url_avatar_clears_old_file`，沙箱无回收站导致 safe-delete fail-closed，**与本特性无关**；本特性 `test_stock_master_and_resolve.py` 10/10） |
| 前端类型检查 | `tsc --noEmit` 通过 |
| 前端测试 | 47 文件 / 502 用例全部通过（含 3 个重写测试） |
| 已知问题 | 0（特性范围内） |

## 提交清单（作者 senior-dev，均未 push）

| 提交 | 内容 |
|------|------|
| `c86f576` feat(backend) | Securities/QuoteInterface 模型扩展 + SecurityType/InterfacePurpose 枚举 + 迁移 `i8d9e0f1g2h3` + pypinyin 依赖 |
| `ffa4ed6` feat(backend) | 主数据同步（配置驱动）/ 分页列表 / 单接口测试 / resolve 端点 + 测试 |
| `78c0df5` feat(frontend) | 「股票列表和测试」分页：左 `StockListPanel`（分页+搜索+同步）、右 `InterfaceTestPanel`（参数编辑+执行+raw/parsed 展示）、左右联动 |
| `93a5a44` feat(frontend) | 录入买卖改为证券搜索：`SecuritySearchCombobox` + resolve 懒实例化 + 移除「新建标的」+ 文案 + 3 测试重写 |

## 关键文件（新增/修改）

- 后端：`models/{security,quote_interface,enums}.py`、`services/market_data_sync.py`（`sync_security_masters`/`sync_all_security_masters`/`test_single_interface`）、`services/security.py`（`resolve`）、`modules/{admin,data}/router.py`、`serializers.py`、`schemas.py`、`alembic/versions/i8d9e0f1g2h3_*.py`、`tests/test_stock_master_and_resolve.py`
- 前端新增：`api/security-master.api.ts`、`hooks/use-security-master.ts`、`hooks/use-interface-test.ts`、`features/admin/stock-list-test-section.tsx`、`components/security/security-search-combobox.tsx`
- 前端修改：`api/quote-interface.api.ts`（+`testInterface`）、`api/security.api.ts`（+`resolveSecurity`）、`hooks/use-securities.ts`（+`useResolveSecurity`）、`features/security-trade/security-trade-form.tsx`、`pages/admin.tsx`、`pages/HoldingsPage.tsx`、`features/security-income/dividend-fee-form.tsx` + 3 测试

## 实现期决策（对设计的两处修正，均已落实）

1. **masters 端点鉴权放宽**：`GET /api/admin/securities/masters` 由 `require_admin` → `get_current_user`。原因：§10 录入界面（所有登录用户）复用该端点搜索；主数据行是系统级公共字典（portfolio_id IS NULL），无用户隐私泄露。同步/测试端点仍仅限管理员。原测试 `test_list_security_masters_requires_admin`（断言非管理员 403）相应改为 `...allows_any_logged_in_user`（断言 200）。
2. **Combobox 零新增依赖**：`SecuritySearchCombobox` 以 Input + 内联下拉实现（设计稿建议 cmdk Command+Popover，属建议非硬性）；功能契约一致：键入即防抖搜索（`masters?q=` 匹配 code/name/拼音首字母）、候选含交易所/类型、选中回调主数据行。

## 下一步建议

1. 前端启动联调：`web` 目录 `npm run dev`（:5173）→ 管理员登录 → 「系统管理 → 金融数据接口 → 股票列表和测试」标签验证左栏分页/搜索/同步与右栏接口测试。
2. 后端如需手动联调主数据：先到「接口分类管理/接口API来源」新建 `purpose=MASTER_LIST` 接口（如 AKShare `stock_info_a_code_name`），再在左栏点「同步」。
3. 录入买卖界面验证：搜索代码/名称/拼音首字母 → 选中 → resolve 自动创建组合标的 → 分红/快照下拉立即可见。
4. push 走 `dev-scripts/push-all.ps1` 或提供 `CNB_TOKEN` 代推。
5. 沙箱环境无法验证回收站删除：`test_defect1_url_avatar_clears_old_file` 需在本机（有回收站）环境回归确认。
