# 业务功能代码级对比报告：app/ (NestJS) vs investment_return_tracker/ (Python/FastAPI)

> **范围与方法声明**
> - 对比双方（均为本地源码，非文档）：
>   - A = `D:/sync/obsidian_wiki/w_wiki/04_Projects/AI Coding/app/packages/backend/src`（NestJS + Prisma）
>   - B = `D:/sync/obsidian_wiki/w_wiki/04_Projects/AI Coding/investment_return_tracker/backend/app`（FastAPI + SQLAlchemy 2.0 async）
> - **本报告所有结论均来自可执行代码**（controller/router 路由、service 方法体、Prisma schema / SQLAlchemy model、DTO/Pydantic schema、统一信封机制）。**未读取任何 `docs/` 文档，未将代码注释作为事实来源**——注释仅用于定位符号，结论以实际控制流为准。
> - 枚举取值、精度、错误码、校验规则等均以代码中实际出现的为准。

---

## 1. 模块覆盖总览矩阵

| 业务模块                                                        | A (NestJS)                               | B (Python)                                                | 覆盖状态                           |
| ----------------------------------------------------------- | ---------------------------------------- | --------------------------------------------------------- | ------------------------------ |
| 鉴权 / 账户（注册/登录/改密/改邮/注销/JWT/软删/恢复）                           | ✅                                        | ✅                                                         | 完全重叠（JWT 载荷细节差异，见 §3.1）        |
| 定时清理（软删账户物理清除 / 孤儿头像）                                       | ✅（应用内 `@Cron` 4AM）                       | ✅（外部触发 `/api/internal/cleanup/*`）                         | 功能重叠，触发方式不同                    |
| 投资组合（CRUD/归档/清空数据/设默认）                                      | ✅                                        | ✅                                                         | 重叠（清空数据范围差异，见 §3.2）            |
| 组合级重算入口                                                     | ✅ `POST /portfolios/:id/recalculate`     | ✅（在 calculation 模块，`/portfolios/:id/recalculate[-range]`） | 功能对等，路由归属不同                    |
| 出入金 / 现金流                                                   | ✅                                        | ✅                                                         | 重叠（B 独有 M1 首笔校验；A 独有日期不为未来）    |
| 证券标的                                                        | ✅                                        | ✅                                                         | 完全重叠                           |
| 证券买卖                                                        | ✅                                        | ✅                                                         | 重叠（成本口径 / 卖出硬校验一致）             |
| 标的最新价                                                       | ✅                                        | ✅                                                         | 重叠（B 缺失日期不为未来校验）               |
| 现金余额                                                        | ✅                                        | ✅                                                         | 重叠（B 缺失日期不为未来校验）               |
| 总资产快照 / 净值（MANUAL/DERIVED）                                  | ✅                                        | ✅                                                         | 完全重叠（B 多 `prune_zero_orphans`） |
| XIRR / 收益率计算                                                | ✅（自实现 Newton-Raphson）                    | ✅（委托 `pyxirr`）                                            | 功能重叠，算法实现不同                    |
| 持仓推导（只读）                                                    | ✅                                        | ✅                                                         | 完全重叠                           |
| 分红                                                          | ✅                                        | ✅                                                         | 完全重叠（净额口径一致）                   |
| 用户偏好                                                        | ✅                                        | ✅                                                         | 重叠（B 多 2 个字段）                  |
| 头像上传                                                        | ✅                                        | ✅                                                         | 完全重叠                           |
| 数据导入 / 导出                                                   | ✅（导出 7 类 / 导入 3 类）                       | ✅（导出 7 类 / 导入 3 类）                                        | 重叠（B 导入补 M1 校验）                |
| 聚合 / 概览查询（overview/summary/comparison/drawdown/xirr/nav 序列） | ✅                                        | ✅                                                         | 完全重叠                           |
| 账户统计 `GET /account/stats`                                   | ✅                                        | ✅                                                         | 完全重叠                           |
| 健康 / 契约冒烟                                                   | ✅                                        | ✅                                                         | 重叠（B 多 Decimal 信封验证端点）         |
| 前端页面（web）                                                   | ✅（React + React Router + TanStack Query） | ✅（React/TS/Vite/ECharts）                                  | 功能点重叠（路由一一对应）                  |

**结论**：两项目在业务功能上**高度同构**——所有核心金融模块在两套代码中都存在且语义一致。差异集中在：(1) 少量业务规则一方缺失（§4.1 / §4.2）；(2) 个别算法/触发机制的实现替换（§4.3）；(3) 偏好字段、清除范围等细节增量。

---

## 2. 全局基础设施对比

| 维度 | A (NestJS) | B (Python) |
|---|---|---|
| 统一响应信封 | `ResponseInterceptor` → `{code:0, data, message:'ok'}`；已有信封则透传 | `EnvelopeRoute` 包裹 endpoint → `{code:0, data, message:'ok'}`；`/docs`、`/openapi.json` 跳过 |
| 异常信封 / 业务码 | `HttpExceptionFilter`；码 1001/1002/1003/1004/1006/1007/1008/1009/2000/3001/5000 | `BusinessException` + 4 个 handler；同套码（位置见各模块） |
| 金额精度 | Prisma `Decimal`；跨网序列化为 **string**；金额 `18,2` / 数量价格 `18,6` / 净值 `12,6` / XIRR `20,8` | `Decimal`→**字符串** wire（`DecimalStr`）；DB `Numeric(18,2/18,6)`；NAV 量化 6 位、XIRR 量化 8 位 |
| 鉴权守卫 | 全局 `APP_GUARD` JWT；`@Public()` 跳过 | `get_current_user` 依赖（JWT HS256，payload 含 `sub,email`） |
| 时区 | `todayInAppTz()` UTC+8 当日午夜 | `today_app_tz()` UTC+8 当前日期 |
| 数据隔离范式 | `verifyOwnership(userId, portfolioId)` 先校验再过滤子表 | `get_scoped(model,id,portfolio_id)` 归属 404（不泄露存在性） |

---

## 3. 逐模块详细对比

### 3.1 鉴权 / 账户
| 端点 / 行为 | A | B | 差异 |
|---|---|---|---|
| 注册 | `POST /auth/register`（bcrypt cost=10，邮箱唯一冲突→1003） | `POST /auth/register`（bcrypt cost=10，邮箱冲突→1003） | 无 |
| 登录 | `POST /auth/login`（顺序：邮箱不存在→1001；密码错→1001；软删未过期→1007+remainingDays；超期→1001） | `POST /auth/login`（密码错→1001；软删非空→1007/1009） | A 登录顺序更严格（防枚举） |
| 自助恢复 | `POST /auth/account/restore`（deletedAt 非空才恢复；未注销→1008；超期→1009/Gone） | `POST /auth/account/restore`（未注销→1008；超期→1009/410） | 无实质差异 |
| 资料 | `GET/ PATCH /auth/profile`（PATCH 三态：undefined 不改 / null 清空 / 有值更新；avatar 站内相对或 http(s) 外链；phone 国内正则） | `GET /auth/profile`、`GET /auth/me`、`PATCH /auth/profile`（avatar 变化时删旧文件） | B 无 phone/bio 字段与正则；A 有 `phone`/`bio` |
| 改密 / 改邮 | `PATCH /auth/password`、`PATCH /auth/email`（当前密码错→1004；新旧相同→2000；占用→1003） | 同（1004/2000/1003） | 无 |
| 注销 | `DELETE /auth/account`（软删 `deletedAt=now()`，保留 30 天，邮箱仍占唯一索引） | 同（软删，30 天可恢复） | 无 |
| JWT 载荷 | `{sub, email}` | `{sub, email, iat, exp}` | B 显式带 iat/exp（标准字段，兼容） |
| 定时清理 | `@Cron(EVERY_DAY_AT_4AM)` 应用内执行 `purgeSoftDeletedUsers()` | `POST /api/internal/cleanup/accounts`（X-Internal-Token 保护）；另 `sweep_orphan_avatars` | **触发方式不同**：A 应用内 cron；B 外部调度触发 |

### 3.2 投资组合
| 行为           | A                                                                                                                       | B                                                                                                                                                   | 差异                                                           |
| ------------ | ----------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| 列表 / 详情      | `GET /portfolios`（createdAt desc）、`GET /:id`                                                                            | 同（createdAt desc，无分页）                                                                                                                               | 无                                                            |
| 创建           | `POST /portfolios`（**currency 强制 'CNY'**）                                                                               | `POST /portfolios`（currency 仅存储，**无强制、无 FX**）                                                                                                       | A 强制单币种；B 存值不校验                                              |
| 改            | `PATCH /:id`（**仅 name/description**）                                                                                    | 同（仅 name/description）                                                                                                                               | 无                                                            |
| 删除           | 级联删；若默认组合→置空                                                                                                            | 级联删（FK CASCADE + passive_deletes）                                                                                                                   | 无                                                            |
| 清空数据         | `DELETE /:id/data`：事务删 cashflows/trades/prices/cashBalances/snapshots/dailyNav/dailyXirr/**dividends**，保留组合与 securities | `DELETE /:id/data`：删 DailyXirr/DailyNav/AssetSnapshot/CashFlow/SecurityTrade/SecurityPrice/CashBalance 共 7 表，**不含 securities 也不含 dividend_records** | **差异**：A 清 dividends，B 不清 dividend_records（两者都不清 securities） |
| 归档           | `PATCH /:id/archive`（归档时若默认组合→置空）                                                                                       | 同（归档同时清空偏好默认组合）                                                                                                                                     | 无                                                            |
| 设默认          | —                                                                                                                       | `PATCH /:id/default`（**toggle**：再次点击取消）                                                                                                             | B 多一个独立 toggle 端点；A 通过 preference 设                          |
| 成立日 baseDate | `CalculationService.ensureBaseDate`：首次买入（首笔 CashFlow.type=BUY）设定，**设置后不可改**                                             | `compute_range` **动态更新** = 最早事件日（min(cashflow 最早, snapshot 最早)），随重算生效，可空                                                                            | **差异**：A 一次性锁定；B 每次重算回算                                      |

### 3.3 出入金 / 现金流
| 项 | A | B | 差异 |
|---|---|---|---|
| 语义 | `CashFlowType` BUY=存入（XIRR 负流）/ SELL=取出（正流） | 同（BUY 负 / SELL 正，由 calculation 按 sign 处理） | 无 |
| amount | `>0`（`@Min(0.01)`，≤1e15） | `>0`（≤0→2000） | 无 |
| **首笔必须存入 (M1)** | **无此校验** | `cashflow.py:74`：SELL 且 DB 无该组合任何 CashFlow→2000；导入复用 `assert_first_must_be_deposit` | **B 独有规则** |
| **日期不为未来** | `validateDateNotFuture`（date > 当日 23:59:59.999 → 400） | **无校验**（靠重算终点 `until=today` 自然排除未来事件，但未来日期会被写入库） | **A 独有规则（B 缺失）** |
| 写触发重算 | POST/PATCH/DELETE → `recalculateRange` | POST/PATCH → `recalculateRange`；DELETE → `recalculateRange` + `prune_zero_orphans` + `recalculateNavRange` | B 在 delete 末尾补独立 NAV 重算（防断链） |
| 响应 `recalculation` | POST/PATCH 内嵌 `CashFlow`；DELETE 独立返回 | 同（`RecalculationMeta{fromDate,affectedDays,skippedManualDays}`） | 无 |

### 3.4 证券标的
| 项 | A | B | 差异 |
|---|---|---|---|
| 唯一约束 | `(portfolioId, code)` 唯一，重复→409 | `uq_securities_portfolio_code` 同 | 无 |
| 删除级联 | Cascade 删 trades/prices/dividends | FK CASCADE 删 trades/prices/dividends | 无 |
| 触发重算 | 不依赖计算模块 | delete 收集 trade_dates，有成交日→`recalculateRange(force_dates=trade_dates)`；无则返 null | 无实质差异（A 未明说，语义一致） |

### 3.5 证券买卖
| 项 | A | B | 差异 |
|---|---|---|---|
| 成本口径 | `costPrice`=**含费单价**（INC-03）；买入 `costTotal += qty*costPrice`；移动加权 avgCost；卖出 qty-=q，avgCost 不变 | `cost_price`（alias costPrice，含费单价）；`finance_core/holding.py` 推导 `cost_total += q*cost_price`；`fee_total` 仅展示存储，非 cost_price 之和 | 完全一致 |
| 费用 | `feeTotal = commission+stampTax+other`（三项独立存储，不回冲成本） | 同（feeTotal 仅展示） | 无 |
| 卖出硬校验 | `validateSellQuantity`：回放截至前日持仓再减当日已有卖出；`holding < quantity`→400 | `_assert_sell_ok`：当前持仓 + **未来日期 SELL 回放**，确保插入后不导致任一未来日持仓为负 | B 额外防"未来日超卖"（更严） |
| 日期不为未来 | 有校验 | **无** | A 独有（见 §3.3） |
| 触发重算 | create/patch/delete → `recalculateRange` | create/patch/delete → `recalculateRange` + delete 末尾 prune+recalcNavRange | 同 §3.3 模式 |

### 3.6 标的最新价
| 项        | A                                  | B                                                                         | 差异   |
| -------- | ---------------------------------- | ------------------------------------------------------------------------- | ---- |
| upsert 键 | `(securityId, asOf)`（删旧+建新保证单值）    | `(portfolio_id, security_id, as_of)`（存在覆盖 price）                          | 无    |
| price>0  | ✅                                  | ✅                                                                         | 无    |
| 日期不为未来   | 有校验                                | **无**                                                                     | A 独有 |
| 触发重算     | create/delete → `recalculateRange` | create/patch/delete → `recalculateRange` + delete 末尾 prune+recalcNavRange | 同模式  |

### 3.7 现金余额
| 项 | A | B | 差异 |
|---|---|---|---|
| upsert 键 | `(portfolioId, asOf)`，amount≥0 | `(portfolio_id, as_of)`；校验 **>0**（≤0→2000，非 ≥0） | **细节差异**：A 允许 =0；B 要求严格 >0 |
| 独立零联动 | ✅（不自动改余额） | ✅（方案 B 口径，不自动改余额） | 无 |
| 日期不为未来 | 有校验 | **无** | A 独有 |
| 触发重算 | create/delete → `recalculateRange` | 同模式 | 无 |

### 3.8 总资产快照 / 净值（MANUAL vs DERIVED）
| 函数 / 语义              | A（`valuation/asset-valuation.service.ts`）                                                | B（`services/asset_valuation.py`）                                                     | 差异                          |
| -------------------- | ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ | --------------------------- |
| `computeDerived`     | 纯计算不落库：`total = marketValue + cashBalance`；无价→回退 avgCost flag=COST_BASED；cash=≤date 最后一条 | 同（`HoldingService.derive` 得市值 + `_latest_cash_balance(d)`，缺则 0 flag=CARRIED_FORWARD） | 接近（B 现金缺失标 CARRIED_FORWARD） |
| `persistDerived`     | 若当日 MANUAL 则跳过，否则 upsert DERIVED                                                         | 同（遇 MANUAL 跳过返回 1，统计 skippedManualDays）                                              | 无                           |
| `upsertManual`       | 无条件覆盖，source=MANUAL, flag=MANUAL_INPUT                                                   | 同                                                                                    | 无                           |
| `deleteRecord`       | 事务删 snapshot+nav+xirr；若事件日则回填 DERIVED                                                    | 同（防幽灵 prevNav）                                                                       | 无                           |
| `resetToDerived`     | computeDerived→upsert 覆盖，source 置回 DERIVED                                               | 同                                                                                    | 无                           |
| `prune_zero_orphans` | （A 在 recalculateRange 内"清孤儿 DERIVED"步骤）                                                  | **独立函数**：删 0 值孤儿 DERIVED；**调用方须其后显式 `recalculateNavRange`**                          | B 显式拆出，且要求调用方补重算（Step5 收敛）  |
| 每日唯一                 | `@@unique([portfolioId, date])` 不含 source                                                | `uq_asset_snapshots_portfolio_date` 同                                                | 无                           |
| 写触发重算                | create/patch/delete/reset → `recalculateNavRange`（T5）                                    | 同（create/patch/delete/reset → `recalculateNavRange`）                                 | 无                           |

### 3.9 XIRR / 收益率计算
| 项 | A | B | 差异 |
|---|---|---|---|
| XIRR 实现 | **自实现 Newton-Raphson**（`finance-core/src/xirr.ts`：初始 r=0.1，maxIter=100，tol=1e-7，rate≤-0.999 钳制；现金流<2/全同号/全同日→null） | **委托 `pyxirr.xirr`**（`finance_core/xirr.py`，guess=0.1，ACT/365）；同样边界返回 None；量程保护防 NUMERIC(20,8) 溢出 | **算法实现替换**：A 自实现；B 用 Rust 扩展包 |
| NAV 单位份额法 | `computeNav`：期末口径；成立日（无 prev）unitNav=cumNav=yearNav=1.0, shares=买入额之和；非成立日 `unitNav = (total - buy + sell)/prevShares`；跨年首日 base=prev.cumNav | `compute_daily_nav`：逻辑一致（成立日=1.0；非成立日 `(snapshot_total - day_buy + day_sell)/prev.shares`；分子或 shares=0 沿用 prev 防除零；跨年 base=prev.cumNav） | 完全一致 |
| 编排 `recalculateRange` | ①删区间 DERIVED ②逐事件日 persistDerived ②.5 清孤儿 ③ `recalculateNavRange` | 同（①删 DERIVED ②persistDerived 遇 MANUAL 跳过统计 skipped ③recalculateNavRange）；`force_dates` 并入事件日 | 无实质差异 |
| `recalculateNavRange` | 取快照 date≥start 去重集合，**升序逐日** triggerCalculation（前日依赖不可并行） | 同（仅计算层 NAV/XIRR 级联，skippedManualDays=0） | 无 |
| 事件日集合 | 出入金∪买卖∪价格(asOf)∪现金(asOf)∪今日 | 同（trade.date/cashflow.date/price.as_of/cashbalance.as_of；区间有事件→until=today） | 无 |
| 区间终点 | 缺省 `todayInAppTz()` | 缺省 `today_app_tz()`（故未来事件不进重建） | 无 |

### 3.10 持仓推导（只读）
| 项 | A（`holding-derivation.service.ts`） | B（`services/holding.py` + `finance_core/holding.py`） | 差异 |
|---|---|---|---|
| 回放 | 按 `(date, createdAt)` 升序回放 SecurityTrade（仅 2 次查库） | 同（按 `(date,created_at)` 升序） | 无 |
| 移动加权 | BUY:`costTotal += q*costPrice`，avgCost=costTotal/qty；SELL:qty-=q，avgCost 不变，costTotal=qty*avgCost，清仓归零 | 同 | 无 |
| 无价回退 | 无现价→回退 avgCost，flag=COST_BASED | 同（price=None→avgCost，is_cost_based=True） | 无 |
| 端点 | `GET /holdings`（date?/securityId?/includeClosed?/types?） | `GET /holdings`（asOf?/securityId?/includeClosed?/types?） | 无 |

### 3.11 分红
| 项 | A | B | 差异 |
|---|---|---|---|
| 净额口径 | `netAmount = amount - tax` 恒≥0；tax 缺省 0；响应 amount/tax/netAmount 均 toFixed(2) | `net = amount - tax`（**运行时计算，不存 DB**）；`amount - tax < 0`→2000 | 接近（B 不落库 netAmount 列） |
| 类型 | `DividendType` CASH / STOCK_DIVIDEND（红利再投仅记录） | 同 | 无 |
| 参与收益计算 | **不参与**（不进 CashFlow、不触发引擎） | 同（不写 CashFlow、不触发重算） | 无 |
| 二级归属 | portfolio 归属 + security 归属防跨组合 | 同（`get_scoped(Security, securityId, portfolio_id)`） | 无 |
| 日期不为未来 | 有校验 | **无** | A 独有 |

### 3.12 用户偏好
| 字段                    | A                                                                                                                                                                                                                                                                                                                   | B                                              | 差异            |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- | ------------- |
| 共有核心字段                | defaultPortfolioId, defaultGranularity(day/week/month/year), defaultDateRange(1w/1m/3m/6m/1y/ytd/all), aggregation(last/avg), weekStartsOn(0/1), navDecimals(1-8), xirrDecimals(1-6), theme(light/dark/system), staleDays(1-30), showLiquidated, cashHintOnCashflow, cashHintOnTrade, amountThousands, amountAbbrev | 同（上述全部）                                        | 无             |
| **B 独有字段**            | —                                                                                                                                                                                                                                                                                                                   | `costBasisView`、`dashboardLayout`(JSON)        | **B 多 2 个字段** |
| defaultPortfolioId 校验 | 只接受本人未归档组合                                                                                                                                                                                                                                                                                                          | 同（非 null→校验 Portfolio.id 且 user_id 匹配，否则 2000） | 无             |
| 自愈                    | GET 首次自动建默认；defaultPortfolioId 不存在/归档→置空                                                                                                                                                                                                                                                                            | `get_or_create` 建默认；PATCH 允许显式 null 取消         | 无             |

### 3.13 头像上传
| 项 | A | B | 差异 |
|---|---|---|---|
| 端点 | `POST /api/upload/avatar`（非 portfolio 下） | 同 | 无 |
| 校验 | 文件存在→1006；MIME∈{jpeg,png,webp}→1006；**魔数嗅探**真实字节→1006；≤2MB→1006 | 同（魔数 `ffd8ff`/`89504e47`/RIFF..WEBP + MIME 双重；≤2MB→1006） | 无 |
| 落盘 | `<UPLOAD_DIR>/avatar/<uuid>.<ext>`；URL `/api/uploads/avatar/<uuid>.<ext>` | 同（`storage/local_disk.py`，扩展名由魔数推导，绝不用原名；三重防路径穿越） | 无 |
| 删旧 | fire-and-forget 删旧文件 | `storage.remove(old_avatar)` best-effort + 安全闸门 `can_remove` | 无 |
| 响应 | 业务对象（`{url,user}`）裸返回（绕过信封，修正过登录态丢失） | 手工信封 `{code:0,data:{url,user},message:'ok'}`（`_is_envelope` 透传） | 机制略异，结果一致 |

### 3.14 数据导入 / 导出
| 项 | A | B | 差异 |
|---|---|---|---|
| 导出 7 类 | SECURITIES / SECURITY_TRADES / CASH_FLOWS / CASH_BALANCES / SECURITY_PRICES / ASSET_SNAPSHOTS / NAV_SERIES | 同（enum `ExportType` 完全一致） | 无 |
| 导入 3 类 | SECURITY_TRADES / CASH_FLOWS / ASSET_SNAPSHOTS | 同 | 无 |
| 导出绕过信封 | 文件直出（`Content-Disposition: attachment`，UTF-8 BOM CSV 或 XLSX） | 同（返回 `Response`，text/csv 带 BOM / xlsx） | 无 |
| preview / commit | preview 不写库签发 token；commit 单事务写入→事务外 1 次 `recalculateNavRange` | 同（preview 签 10 分钟 JWT；commit 单事务 + 单次重算） | 无 |
| 限额 | 5MB / 10000 行 | 同（ALLOWED_EXT/.xlsx/.xls；≤5MB；≤10000 行） | 无 |
| **导入校验 M1** | （A 的 CASH_FLOWS 导入未明说首笔校验） | **补 M1**：cashFlows 走 `CashflowService.bulk_create`→`assert_first_must_be_deposit`；securityTrades 走 `TradeService.bulk_create`→`_check_no_oversell` | **B 在导入路径也强制 M1 / 防超卖**（更严） |
| 跨组合安全 | 导出/预览/提交校验 portfolioId 归属，文件内 portfolioId 列忽略 | 同 | 无 |

### 3.15 聚合 / 概览查询
| 端点 / 能力 | A | B | 差异 |
|---|---|---|---|
| 组合摘要 `GET /portfolios/summary` | ✅（含 cumulativeNav/yearReturnRate/xirr/netInvested/floatingProfit） | ✅（`PortfolioSummaryRow`） | 无 |
| 多组合对比 `GET /portfolios/comparison` | ✅（maxDrawdown=null 因性能） | ✅（maxDrawdown 恒 null） | 无 |
| 单组合概要 `GET /portfolios/:id/summary` | ✅（maxDrawdown 恒 null v1） | ✅（maxDrawdown 恒 null） | 无 |
| 概览 `GET /portfolios/:id/overview` | ✅（最新总资产/累计/当年 XIRR/净投入/累计收益率/当年收益率/latestDate/latestSource/holdingsSummary/最近5笔/freshness） | ✅（字段一致；freshness 取各持仓最新价 MIN MAX(as_of) 滞后超 staleDays 或现金滞后→reasons） | 无 |
| freshness 新鲜度 | ✅（O-6：行情滞后超 staleDays 或现金滞后→isStale+reasons，增强失败降级仍 200） | ✅（同逻辑，行情维度=各持仓最新价 MAX(as_of) 最小值；现金维度=最新现金 as_of） | 无 |
| xirr / nav 序列 | `GET /xirr`、`/xirr/latest`、`/xirr/history`、`/nav`、`/nav/latest`、`/nav/history`（granularity day/week/month/year × aggregation last/avg） | 同（calculation router，metric∈{cumulative,year,both}） | 无 |
| 最大回撤 `GET /metrics/drawdown` | ✅（`dd = nav/peak - 1`） | ✅（同） | 无 |
| 账户统计 `GET /account/stats` | ✅（portfolioCount/cashflowCount/tradeCount/snapshotDays/recordDays/firstDate/lastDate） | ✅（同；字段已由 transactionCount 改名 cashflowCount） | 无 |

### 3.16 其他（前端）
- A 前端（`app/packages/web`）：React + React Router + TanStack Query；路由 `/login /register /(Dashboard) /holdings /cashflows /snapshots /analysis/xirr /analysis/nav /account /settings`，features 子模块与后端一一对应（含分红录入、CSV/xlsx 导入导出模板、头像上传）。
- B 前端（`investment_return_tracker/web`）：React/TS/Vite/ECharts；11 页面 / 13 feature 模块 / 5 个 ECharts 图表，功能点与 A 后端各模块对应。
- **结论**：前端功能点重叠，均覆盖登录注册、Dashboard、持仓、出入金、快照、XIRR/净值分析、账户、设置（改密/改邮/偏好/头像/导入导出）。

---

## 4. 功能覆盖差异总结

### 4.1 A 有 / B 缺失（Python 待补）
| # | 缺失项 | A 实现位置 | B 现状 | 影响 |
|---|---|---|---|---|
| D1 | **日期不为未来校验** | cashflow/trade/price/cashbalance/snapshot 各自 `validateDateNotFuture`（date > 当日 23:59:59.999 → 400） | B grep 确认**无任何 future-date 校验**；未来日期会被写入库，仅因重算终点 `until=today` 不进当前重算 | 数据完整性缺口：用户可录入未来日期的出入金/交易/价格/余额/快照，**B 应补** |
| D2 | 登录防枚举顺序 | A 登录严格顺序（邮箱不存在→1001；密码错→1001；软删→1007） | B 密码错→1001、软删→1007/1009，但缺"邮箱不存在单独分支"的等价处理（B 统一 1001） | 低（B 已统一返回 1001，不泄露，差异仅在是否先判软删） |

### 4.2 B 有 / A 缺失（Python 增量）
| #   | 增量项                                      | B 实现位置                                                      | A 现状                           | 说明                         |
| --- | ---------------------------------------- | ----------------------------------------------------------- | ------------------------------ | -------------------------- |
| E1  | **首笔必须存入 (M1)**                          | `cashflow.py:74` + `assert_first_must_be_deposit`（导入复用）     | A 无此校验                         | B 业务独有规则（防「先取出后存入」破坏现金流起点） |
| E2  | 导入路径补 M1 + 防超卖                           | `data_transfer.py` bulk_create 复用 Cashflow/Trade service 校验 | A 导入未明说首笔/超卖校验                 | B 导入与在线录入同源校验（更严）          |
| E3  | 偏好字段 `costBasisView` / `dashboardLayout` | `models/user.py` `UserPreference`                           | A 无                            | B 偏好更丰富（成本基础视图 / 仪表盘布局）    |
| E4  | 卖出校验含"未来日不转负"                            | `_assert_sell_ok` 回放未来日期 SELL                               | A `validateSellQuantity` 仅截至前日 | B 防未来日超卖（更严）               |
| E5  | 现金余额严格 >0                                | `schemas.py:_amount_positive`（≤0→2000）                      | A amount≥0（允许 0）               | 细节口径差异                     |

### 4.3 两者都有但实现/触发不同
| #   | 维度           | A                                  | B                                                                    |
| --- | ------------ | ---------------------------------- | -------------------------------------------------------------------- |
| F1  | XIRR 算法      | 自实现 Newton-Raphson（`finance-core`） | 委托 `pyxirr`（Rust 扩展，无外部依赖）                                           |
| F2  | 成立日 baseDate | 首次买入一次性设定，设置后不可改                   | 每次重算动态回算=最早事件日，可空                                                    |
| F3  | 定时清理触发       | 应用内 `@Cron` 每日 4AM                 | 外部调度 `POST /api/internal/cleanup/accounts`（X-Internal-Token）+ 孤儿头像扫描 |
| F4  | 清空数据范围       | 删 8 类含 `dividends`                 | 删 7 类**不含 `dividend_records`**（两者都不清 securities）                     |
| F5  | 组合 currency  | 创建时强制 'CNY'                        | 仅存储，无强制/FX                                                           |
| F6  | 快照孤儿清理       | 内嵌于 recalculateRange 步骤            | 独立 `prune_zero_orphans`，且要求调用方其后显式 `recalculateNavRange`（单向依赖收敛）     |
| F7  | 头像响应信封       | 裸返回（绕过拦截器）                         | 手工信封（透传机制）                                                           |

---

## 5. 完全重叠部分（核心同构）

以下能力在两套代码中**语义、端点、规则、精度均一致**，属于真正的业务重叠：

1. **统一信封 `{code,data,message}`** + 业务错误码体系（1001/1002/1003/1004/1006/1007/1008/1009/2000/3001/5000）。
2. **金额 Decimal→string 序列化** + 精度（18,2 / 18,6 / 12,6 / 20,8）。
3. **枚举取值完全一致**：`CashFlowType{BUY,SELL}`、`SecurityType{STOCK,FUND,BOND,OTHER,CASH}`、`SecuritySide{BUY_SEC,SELL_SEC}`、`SnapshotSource{DERIVED,MANUAL}`、`SnapshotValuation{EXACT,CARRIED_FORWARD,COST_BASED,MANUAL_INPUT}`、`DividendType{CASH,STOCK_DIVIDEND}`。
4. **MANUAL/DERIVED 快照双轨** + `computeDerived/persistDerived/upsertManual/deleteRecord/resetToDerived` 五函数语义一致 + 每日唯一约束。
5. **NAV 单位份额法**（期末口径、成立日=1.0、移动加权、跨年 base 重置）逻辑一致。
6. **持仓推导**（移动加权平均、无价回退 avgCost、SELL 不减 avgCost）。
7. **卖出硬校验防超卖**（至少"当前持仓不转负"一致）。
8. **成本基础口径**：`costPrice`=含费单价，费用不回冲成本，仅展示。
9. **导出 7 类 / 导入 3 类**（类别、绕过信封、preview/commit 事务、5MB/10000 行限额、跨组合安全）。
10. **头像上传**（2MB / 魔数嗅探 / `/api/uploads/avatar/<uuid>.<ext>` / 删旧）。
11. **偏好核心字段**（14 个共有字段 + 自愈 + defaultPortfolioId 归属校验）。
12. **聚合/概览**（overview + freshness + drawdown + xirr/nav 序列 + summary + comparison + account/stats）。
13. **软删除 30 天保留 + 归档**机制。
14. **重算编排链路**（T1-T4 `recalculateRange` 删DERIVED+重建+级联；T5 `recalculateNavRange` 仅计算层；事件日集合口径一致）。
15. **前端功能点**（登录/ Dashboard / 持仓 / 出入金 / 快照 / XIRR·净值分析 / 账户 / 设置）一一对应。

---

## 6. 结论

两套系统**业务功能高度同构**——B（Python/FastAPI）是 A（NestJS/Prisma）的功能等价重写，核心金融模块、计算口径、枚举、精度、信封契约、导出导入类别、聚合查询全部对齐。**差异属于"增量 + 少量缺口 + 实现替换"三类**：

- **B 应补的缺口（建议）**：D1 日期不为未来校验（A 在 5 类写操作均有，B 完全缺失，属数据完整性风险）。
- **B 相对 A 的增量（合理保留）**：M1 首笔存入、导入同源校验、更严的卖出未来日校验、偏好增量字段、现金严格 >0。
- **实现替换（已决策）**：XIRR 改 `pyxirr`（B 决策）、baseDate 动态回算、定时清理改外部触发、清空数据不含分红、孤儿清理显式收敛——这些是有意的设计选择，非遗漏。

> 报告基于两代码库全量源码（A: `app/packages/backend/src`；B: `investment_return_tracker/backend/app`）核查，未引用任何文档或注释文字。
