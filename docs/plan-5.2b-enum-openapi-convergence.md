# §5.2b 枚举独立 Schema + 后端字段补齐 + lib/types 收敛（可行性分析）

> 状态：**分析中（已补全收敛项，待用户确认范围执行）**。用户指令："补充后端 schema 字段缺失项并让 OpenAPI 生成独立 schema，同时把 lib/types.ts 收敛为纯前后端契约常量聚合层……能不能分析下"。
> 依据：实际读码核实（2026-08-09），非凭记忆。
> 关联：`docs/plan-5.2-shared-types-retirement.md`（已执行，策略 A）。

---

## 0. 分析结论速览

| 项 | 可行性 | 关键发现 |
|----|--------|----------|
| (1) 补齐后端缺字段 | ✅ 可行，纯 schema 暴露，**无需迁移** | ORM 模型已有 `portfolio_id` / `user_id` / `TimestampMixin`(`created_at`+`updated_at`)，DTO 仅未 expose |
| (2) OpenAPI 生成独立 enum schema | ✅ 可行，但**有隐藏依赖** | 当前 DTO 把枚举字段写成 `str`，OpenAPI 里**根本没有 enum**（非"内联"而是被抹平）；需先把 DTO 字段类型改为枚举类型，再加 openapi 后处理把内联 enum 提升为命名 schema |
| (3) 实体=后端镜像+前端补字段；枚举/错误码/金额工具 as const | ✅ 可行 | 与现状一致，只是把"手写镜像"换成"re-export" |
| (4) lib/types.ts 仅留契约常量 | ✅ 可行，但有边界 | 实体类型要移出（re-export 自 `types/api.ts`）；`NavSeriesPoint`/`XirrSeriesPoint` 是 number 视图类型，不属"常量"，需另置 |

**两个被纠正的前提（读码后）**：
- ❌ "导入 DTO 未生成独立 schema（内联为字符串字面量）" → **部分纠正**：导入**请求** `ImportCommitReq` 确实是命名 schema（`openapi.json:5175`），但导入**响应**体（`ImportPreviewResult`/`ImportCommitResult`/`RecalcSummary`/`ImportRowError`）在 `openapi.json` 中**查无命名 schema**——后端以松散 dict 返回、未暴露为命名 schema。故导入响应类型属前端独有，**不能** re-export，需留 `lib/types.ts`（详见 §3.(5)）。
- ❌ "枚举内联为字符串字面量" → **核实：当前 OpenAPI 里根本没有 enum**（grep `"enum":` 零命中）。原因：`schemas_resp.py` 全把所有枚举字段声明成 `str`（如 `CashflowOut.type: str`）。所谓"内联"是误判，真实情况是**枚举信息在响应 DTO 层被丢弃**。

---

## 1. 当前契约落差（lib/types.ts 实体视图模型 vs 后端 DTO）

| 前端实体（lib/types.ts） | 后端 DTO | 缺失字段（后端需补） |
|---|---|---|
| `CashFlow` (`id,portfolioId,date,type,amount,note,createdAt,updatedAt`) | `CashflowOut` (`id,date,type,amount,note,createdAt`) | **`portfolioId`, `updatedAt`** |
| `Portfolio` (`id,userId,name,description,baseDate\|null,currency,archivedAt,createdAt,updatedAt`) | `PortfolioOut` (`id,name,description,baseDate,currency,archivedAt,createdAt,updatedAt`) | **`userId`**；`baseDate` 后端 `date` 必填，前端 `string\|null` → 需改 `Optional[date]` |
| `AssetSnapshot` (`id,portfolioId,date,...,source,valuationFlag,note,recordedAt,createdAt,updatedAt`) | `SnapshotOut` (`id,date,...,source,valuationFlag,note,recordedAt,derivedTotalAsset`) | **`portfolioId`, `createdAt`, `updatedAt`** |
| `UserPublic` | `UserPublicOut` | 无（仅 `name` 可空性微差，编译无碍） |

> 注：前端 `Security` / `Trade` / `Dividend` / `Preference` 等实体**未**在 lib/types.ts 手写，直接来自 `types/api.ts`（`components['schemas']['SecurityOut']` 等）。所以真正的"手写镜像"只有以上 4 个 + 2 个 series 视图类型。

---

## 2. 隐藏依赖（最关键，决定 Part 2 是否真有效）

要让 OpenAPI 携带枚举并生成命名 schema，必须**两步**：

1. **改 DTO 字段类型**：把 `schemas_resp.py` / `schemas.py` 里的枚举字段从 `str` 改为真实枚举类型。
   - `CashflowOut.type: CashFlowType`（当前 `str`）
   - `SecurityOut.type: SecurityType`、`TradeOut.side: SecuritySide`
   - `SnapshotOut.source: SnapshotSource`、`valuationFlag: SnapshotValuation`
   - `DividendOut.type: DividendType`
   - `PreferenceOut` 各枚举字段（`defaultGranularity`/`aggregation`/`theme`/`costBasisView` 等）同理
   - **线格式不变**：pydantic 把枚举序列化为值字符串（"BUY"），与现 `str` 完全一致；`EnvelopeJSONResponse` 运行时跳过 response_model 校验，仅影响 OpenAPI 文档 → **零运行时风险**。
2. **加 openapi 后处理**：在 `main.py:_custom_openapi()` 里，把内联 `{"enum":[...]}` 提升为 `components.schemas['CashFlowType']` 并替换为 `$ref`。

### 后处理命名策略（推荐：按枚举值匹配，确定性最强）
在 `_custom_openapi()` 注入一个注册表（来自 `models/enums.py` 的 6 个枚举 + 其它如有）：
- 遍历所有 schema 属性的 `enum` 列表，与注册表枚举的 `list(values)` 比对；命中则创建命名 schema 并以 `$ref` 替换。
- 优点：不依赖 pydantic 给内联 enum 设的 `title`（经验上 title 常是字段名 "Type" 而非枚举类名，靠 title 不可靠）；值匹配稳定、与枚举类名解耦。
- 兜底：若值冲突，再结合 `title` 决胜。

> 验证前置：改完 DTO 字段类型后先 `python backend/scripts/gen_openapi.py` 并 grep `"enum":`，确认内联 enum 已出现且 `title` 形态，再定稿后处理（title 可用则更简单，不可用则走值匹配）。

---

## 3. 四项要求的落地映射

### (1) 补齐后端缺字段（schema 层，无迁移）
- `CashflowOut`: `+ portfolioId: str`、`+ updatedAt: datetime`（模型 `TimestampMixin` 已提供）
- `SnapshotOut`: `+ portfolioId: str`、`+ createdAt: datetime`、`+ updatedAt: datetime`
- `PortfolioOut`: `+ userId: str`；`baseDate: date` → `baseDate: Optional[date] = None`（对齐模型 `base_date: date | None` 的真实可空性）
- 可选（一致性）：给 `SecurityOut`/`TradeOut`/`DividendOut`/`PriceOut`/`CashBalanceOut` 也补 `createdAt`/`updatedAt`，改善生成类型。

### (2) OpenAPI 独立 enum schema
- 见 §2 两步。导入 DTO 已命名，**无需额外动作**（纠正前提）。
- `gen-api-types.py` 已原生处理 `$ref`（line 30）与 `enum`（line 42）——命名 schema 出现后，实体字段会自动变成 `components['schemas']['CashFlowType']` 引用，**转换脚本零改动**。

### (3) 实体=后端镜像；枚举/错误码/金额工具 as const
- 枚举（`CashFlowType` 等 6 个后端枚举 + `QueryGranularity`/`NavMetric`/`ExportType`/`ImportType`/`ImportErrorCode`/`FreshnessKind`/`AggregationMethod` **前端独有枚举**）：保持 `as const`（运行时需遍历成员做下拉）。后端枚举在 `types/api.ts` 同时生成命名 union 类型，供"字段类型"使用，二者值一致。
- 错误码 `BUSINESS_ERROR_CODE`：**有后端孪生** `core/enums.py:11 class BusinessErrorCode(IntEnum)`（值 1001–1009/2000/3001/5000 已逐对一致）。P2 将其暴露为命名 schema 后，前端改为 re-export `components['schemas']['BusinessErrorCode']`，移出手写 `as const`。
- 金额工具（`isMoneyString`/`computeNetAmount`/`sumMoney`/`toNumberOrNull` 等）：纯前端函数，保持 lib 工具，**不**进 `types/api.ts`。

### (4) lib/types.ts 收敛为纯契约常量
- 移出实体接口 → 改为 re-export 别名：
  ```ts
  import type { components } from '@/types/api';
  export type CashFlow = components['schemas']['CashflowOut'];
  export type Portfolio = components['schemas']['PortfolioOut'];
  export type AssetSnapshot = components['schemas']['SnapshotOut'];
  export type UserPublic = components['schemas']['UserPublicOut'];
  ```
- `NavSeriesPoint` / `XirrSeriesPoint`（number 视图类型，非常量）移到 `web/src/types/series.ts`，更新 2 处引用（`api/query.api.ts`、`hooks/use-query-data.ts` 等）。
- 保留（真·前端独有）：金额工具（`isMoneyString`/`computeNetAmount`/`sumMoney`）、`toNumberOrNull`、前端独有枚举（`QueryGranularity`/`AggregationMethod`/`NavMetric`/`FreshnessKind`）、视图类型（`NavSeriesPoint`/`XirrSeriesPoint`→`types/series.ts`、`FreshnessReason`/`FreshnessInfo`）、导入响应体形态（`ImportPreviewResult` 等）、信封泛型 `ApiResponse<T>`。
- **移出（re-export，确凿后端孪生，一审漏标）**：`Paginated<T>`（←`schemas_resp.Paginated`）、`BUSINESS_ERROR_CODE`（←`BusinessErrorCode`）、`ACCOUNT_RETENTION_DAYS`（←`core` 常量 `=30`）。详见 §3.(5)。
- `~60` 处 `@/lib/types` 引用**无需改**（re-export 别名维持同名导出）。

### (5) 补充收敛项（一审漏标，已读码核实）

对 `lib/types.ts` 全量导出逐一定位后端现状，新增以下收敛结论（2026-08-09 二审）：

**① 确凿可 re-export 的后端孪生（一审计划漏标）**
| 前端符号 | 后端真相源 | 动作 |
|---|---|---|
| `Paginated<T>` | `schemas_resp.py:22 class Paginated(BaseModel, Generic[T])` | re-export；泛型，`gen-api-types` 原生支持 |
| `BUSINESS_ERROR_CODE` | `core/enums.py:11 class BusinessErrorCode(IntEnum)` | P2 暴露为命名 schema 后 re-export（值 1001–1009/2000/3001/5000 已一致） |
| `ACCOUNT_RETENTION_DAYS` | `core/enums.py:56` / `core/config.py:39` 均 `= 30` | re-export；`ACCOUNT_RETENTION_MS` 为前端派生常量，留前端 |
| `DividendType` | `models/enums.py` 已有（CASH/STOCK_DIVIDEND） | 后端有、前端未用 → P2 后直接 re-export（属"补用"非"搬"） |

**② 可选提升为后端枚举（当前后端用字符串字面量散落，未进 OpenAPI）**
- `ExportType`（7 类）/ `ImportType`（3 类）/ `ImportErrorCode`（9 个）：属领域概念，可提升为 `models/enums.py` 枚举享受单源；不提升则保持 `as const` 也合理（见 §7 决策点 5）。

**③ 真·前端独有，搬不动（必须留 `lib/types.ts`）**
- 纯前端工具（后端用 `Decimal`，无对应）：`MONEY_RE` / `MoneyOptions` / `isMoneyString` / `computeNetAmount` / `sumMoney` / `toNumberOrNull`
- 前端查询/视图枚举（无后端枚举类）：`QueryGranularity` / `AggregationMethod` / `NavMetric` / `FreshnessKind`
- 前端展示聚合类型：`FreshnessReason` / `FreshnessInfo`、`NavSeriesPoint` / `XirrSeriesPoint`（→ `types/series.ts`）
- 导入响应体形态（后端返回松散 dict，未暴露命名 schema）：`ImportPreviewResult` / `ImportCommitResult` / `RecalcSummary` / `ImportRowError` / `ImportRow` / `AccountPendingDeletionData`
- 信封泛型 `ApiResponse<T>`（后端信封是真相源，但泛型生成不干净，保留本地别名）

---

## 4. 风险与决策点

| 风险 | 等级 | 说明 |
|---|---|---|
| openapi 后处理是新增自定义基础设施 | 中 | 需测试；今后加枚举要同步注册表（值匹配自动覆盖，影响小） |
| 改 DTO 字段类型为枚举 | 低 | 线格式不变，仅 OpenAPI 文档变化；需跑后端 schema 测试确认序列化无回归 |
| `baseDate` 改可空 | 低 | 对齐 DB 真实可空性；前端本就按可空用，反而更稳 |
| 前端独有枚举（QueryGranularity 等）仍无后端源 | 预期 | 合理双源：这些是前端查询/契约概念，保持 `as const`，不强行后端化 |
| 4 个预存失败测试（`security-type-shared.test.tsx`） | 无关 | 校验下拉含 `CASH`，与枚举命名无关，仍预存；建议单独排查 |
| `QueryGranularity` 漂移 | 中 | 后端 `_GRANULARITIES=["day","week","month","quarter","year"]`（`preference.py:24`）含 `quarter`，前端 `QueryGranularity` 无此成员。前端独有枚举不会 re-export，但属契约不一致，P3 须对齐（前端补 `QUARTER` 或后端确认不支持） |
| 导入响应体非命名 schema | 预期 | `ImportPreviewResult` 等后端以松散 dict 返回，re-export 不可行，保持前端手写（见 §3.(5)） |

---

## 5. 推荐执行方案（分阶段，执行前需用户确认范围）

**P1 后端字段补齐（无迁移）**
- 编辑 `schemas_resp.py`：补 `portfolioId`/`userId`/`createdAt`/`updatedAt`；`PortfolioOut.baseDate`→`Optional`。
- 跑后端测试（`pytest`，schema/序列化）确认零回归。

**P2 OpenAPI 枚举独立化**
- 改 `schemas_resp.py` + `schemas.py` 枚举字段类型 → 真实枚举。
- `main.py:_custom_openapi()` 加枚举提升后处理（值匹配注册表）。
- `gen_openapi.py` 重新生成 `docs/openapi.json`，grep 校验命名 schema 出现。
- 后端加测试：断言 `openapi.json` 含 `components.schemas.CashFlowType` 且被 `$ref`。

**P3 前端收敛**
- `npm run generate:api` 重生成 `types/api.ts`。
- 重构 `lib/types.ts`：实体 + `Paginated` + `BUSINESS_ERROR_CODE` + `ACCOUNT_RETENTION_DAYS` + `DividendType` 改 re-export 别名；`NavSeriesPoint`/`XirrSeriesPoint` 移到 `types/series.ts`；前端独有枚举/工具/视图类型/导入响应体保留。
- `npm run lint`(tsc) / `npm run build` / `npm test` 全绿（或仅剩 4 预存失败）。

**P4 文档 + 提交**
- 更新 `ARCHITECTURE.md §5.2` 记录"枚举已独立 schema、lib/types 已收敛为常量聚合层"。
- 分阶段 commit（前端可随 P3 一并，或独立 chore）。

---

## 6. 工作量估算
- 后端：约 3 文件（`schemas_resp.py`、`schemas.py`、`main.py` 后处理），~1 个聚焦会话。
- 前端：约 2–3 文件（`lib/types.ts` 重构、`types/series.ts` 新建、`types/api.ts` 重生成），~0.5 会话。
- 测试：后端 schema/枚举测试 + 前端 typecheck，~0.5 会话。
- 合计约 **2 个聚焦会话**，无迁移、无破坏性线格式变化。

---

## 7. 待用户确认
1. `updatedAt` 范围：仅补前端视图模型真正需要的（`CashFlow`/`AssetSnapshot`），还是**所有** `*Out` 实体 DTO 都补（更一致，推荐哪种）？
2. 枚举字段类型改造（P2）是否一并做？还是本期只做字段补齐（P1）+ lib/types 收敛（P3），枚举独立化留待后续？
3. 4 个预存前端失败测试是否并入本次排查，还是保持独立 task？
4. 确认后是否直接执行（沿用主会话自执行 + TaskCreate，不起多智能体团队）？
5. 可选提升枚举（`ExportType`/`ImportType`/`ImportErrorCode`）是否一并提升为后端 `models/enums.py` 枚举（更彻底单源，但需改后端 + 重生成 OpenAPI），还是保持前端 `as const`？
6. `QueryGranularity` 漂移（`quarter`）：前端补 `QUARTER` 成员，还是后端移除 `quarter` 支持？
