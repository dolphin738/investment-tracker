# 报价接口响应字段可配置化（response_fields）— 方案设计

- 状态：已定稿·待实施
- 日期：2026-09-11
- 范围：admin 管理端「金融数据接口页」的接口配置与响应解析链路（`QuoteInterface` 模型 → 响应解析 → 前端配置表单 → 试调面板）
- 作者 role：架构师

---

## 一、背景与问题

现有 `QuoteInterface` 用 4 个**硬编码语义列**表达响应字段（`resp_code_field` / `resp_price_field` / `resp_name_field` / `resp_exchange_field`），无法适配各接口不同的响应结构；想新增一种语义就要加列，并改动所有消费点。

真正的问题不是「字段不够多」，而是**语义与取值耦合**：

- 6 个消费点实际只消费 5 个语义（`code` / `name` / `exchange` / `price` / `date`）。
- 其余字段（公告标题、分红方案、网址等）代码根本不需要，却因模型没地方放而挤不进来。

因此方案的核心是**把「语义（slot）」与「取值（source 路径）」解耦**，并让配置从「固定列」变为「可增删的映射表」。

---

## 二、现状代码事实

以下事实为方案基础，逐条带 `file:line`。

### 2.1 模型与协议字段

**F1 — 4 个硬编码语义列（`String(64)`）**

- 位置：`backend/app/models/quote_interface.py:74-97`
- 内容：`resp_code_field`（默认 `code`）/ `resp_price_field`（默认 `price`）/ `resp_name_field`（默认 `name`）/ `resp_exchange_field`

**F2 — `response_parse` JSON**

- 位置：`backend/app/models/quote_interface.py:98-111`
- 结构：`{format, encoding, sep, line_regex, code_param, code_prefix}`

**F3 —「第二真相」：`resp_date_field` 藏在 `response_parse` 内**

- 位置：`backend/app/services/market_daily_price_sync.py:168`
- 补充：同处 `:169-170` 读 `resp_code_field` / `resp_price_field`；`:246,253` 调 `_row_get`
- 含义：日期语义不在模型列里，而是既有的一处「第二真相」

**F4 —「隐式真相」：中文列名兜底（至少 5 处，方案须收敛）**

- 位置 A：`backend/app/services/dividend_sync.py:100-113`
- 内容 A：`_code_of` 除 `resp_code_field` 外还回退中文列名「代码」（`_FALLBACK_CODE_FIELD`）
- 位置 B：`backend/app/services/dividend_notice_scan.py:57-58`
- 内容 B：公告扫描硬编码 `_COL_NOTICE_CODE="代码"`、`_COL_NOTICE_TITLE="公告标题"`——与 A 同类「中文列名兜底」，且 `_COL_NOTICE_CODE` 直连 `code` 槽、`_COL_NOTICE_TITLE` 为展示字段
- 推论：除 F3 的 `resp_date_field` 外，**「中文列名兜底」至少还有 2 处**（A/B），方案「3 处真相」应改为「至少 5 处」；这些硬编码列名须全部纳入 `response_fields` 收敛范围，否则分红/公告扫描仍绕开统一解析

**F5 — 唯一取值收口 `_row_get`**

- 位置：`backend/app/services/market_data_sync.py:258-274`
- 语义：dict 行取顶层 key；数组行取整数位置下标（`field` 为纯数字时）
- 限制：**不支持点号路径、不支持 `a[0]`**；全仓无 jsonpath / `split('.')` 类路径解析

**F6 — `_normalize_rows` 信封解包**

- 位置：`backend/app/services/market_data_sync.py:432-446`
- 内容：把 `data` / `list` / `items` / `result` 四个信封键解包到行层
- 推论：新增 source 路径语法一般只需 1~2 层深度

**F7 — SDK 分支 `_fetch_sdk_raw`**

- 位置：`backend/app/services/market_data_sync.py:582-629`
- 内容：akshare 懒导入（`:610-611`），DataFrame 经 `df.to_dict("records")`（`:620-621`）拍平成 `list[dict]`，**DataFrame 列名成为顶层 key**
- 风险：MultiIndex 列会产出 tuple key，前端 FastAPI 序列化会失败；拍平处未见展平逻辑

**F8 — `_parse_text_split` 文本解析**

- 位置：`backend/app/services/market_data_sync.py:541-580`
- 控件：`sep` 在 `:556`、`line_regex` 在 `:557`、`re.finditer` 在 `:565-579`
- 语义：2 组（group1=带前缀代码、group2=内容）；仅 1 组时 code 回退
- 行键：字符串下标 `"0"` / `"1"`…，并**注入 `_code` 键**（带前缀代码）

### 2.2 消费点、端点与既有校验

**F9 — 六个消费点**（明细见 2.4）

**F10 — 试调端点**

- 路由：`POST /api/admin/quote-interfaces/{interface_id}/test` — `backend/app/modules/admin/router.py:831-842`
- 请求体：`InterfaceTestRequest`（`{params, codes}`）— `backend/app/modules/admin/router.py:631-635`
- 处理函数：`MarketDataSyncService.test_single_interface` — `backend/app/services/market_data_sync.py:1227-1269`
- 内容：与正式同步共用 `_call_interface_raw`，产出 `parsed`

**F11 — 既有校验先例**

- 位置：`backend/app/services/quote_interface.py:36-53`
- 内容：`_validate_response_parse` 对 `line_regex` 做 ReDoS 校验（超长/非法正则直接 400）

### 2.3 前端与工程量

**F12 — `QuoteInterfaceDialog.vue`（577 行）**

- 位置：`web/src/modules/admin/components/QuoteInterfaceDialog.vue`
- 结构：4 个页签（基本信息 / 字段映射 / 响应解析 / 高级设置）
- 「字段映射」页签 `:365-408` 是 4 个纯文本 `Input`，**无任何按分类条件渲染**
- 全组件 `v-if` 仅 3 处：`:425` 按 `rpFormat`、`:500` 参数空提示、`:571` loading
- `response_parse` 被拆成 6 个子控件、由 `buildResponseParse()`（`:49-62`）拼回对象
- `params` 为键值对增删行（`:503-519`）；校验为手写、仅两项（`:219-226`）
- 引入方：`ProviderInterfaces.vue:43,196`

**F13 — 前端类型 `quote-interface.api.ts`**

- 位置：`web/src/api/quote-interface.api.ts`
- `QuoteInterface`（`:24-56`）：`resp_code_field:42` / `resp_price_field:44` / `resp_name_field:46` / `resp_exchange_field:48` / `response_parse:51`
- `QuoteInterfaceCreate`（`:59-78`）、`QuoteInterfaceUpdate`（`:81-100`）
- 另有一份 OpenAPI 生成物 `web/src/types/api.ts`（须重跑生成，否则漂移）

**F14 — 测试面板 `InterfaceTestPanel.vue`**

- 位置：`web/src/modules/admin/components/InterfaceTestPanel.vue:427-448`
- 内容：响应渲染为**固定两列（代码/价格）**，遍历 `result.parsed`（契约 `Record<string,string>`）
- 参数提示：`ENDPOINT_PARAM_HINTS` 定义在 `:84-95`，消费逻辑 `:251-256`

**F15 — 工程量约束**

- 位置：`AGENTS.md` §4、`scripts/check_line_budget.py`
- 内容：`QuoteInterfaceDialog.vue` 577 行**已超**「单文件 ≤400 行」人工约定，逼近 800 行硬闸门

### 2.4 六个消费点明细（F9 展开）

| 编号 | 消费点 | 位置 |
| --- | --- | --- |
| F9.1 | `_parse_price_rows` | `backend/app/services/market_data_sync.py:643-658` |
| F9.2 | `_parse_test_rows` | `backend/app/services/market_data_sync.py:660-672` |
| F9.3 | `_prepare_master_rows`（取字段在 `:1111-1113`、取值在 `:1117` / `:1121` / `:1128`） | `backend/app/services/market_data_sync.py:1103-1160` |
| F9.4 | `market_daily_price_sync.py:169-170` + `:246,253` | `backend/app/services/market_daily_price_sync.py` |
| F9.5 | `dividend_sync.py:100-113` | `backend/app/services/dividend_sync.py` |
| F9.6 | `dividend_notice_scan.py:333,356` | `backend/app/services/dividend_notice_scan.py` |

---

## 三、方案总览

**四层解耦**，按此顺序成章：

| 层 | 内容 |
| --- | --- |
| 1. 契约层 | slot 白名单 + 按分类必填契约，单一 schema 端点驱动前端渲染 |
| 2. 配置层 | `response_fields` JSON 字段映射表，旧列走 Expand→Contract 收敛 |
| 3. 解析层 | `resolve_fields()` 编译取数器 → `_row_get` 唯一收口 |
| 4. 消费层 | 主数据 / 价格 / 分红 / 公告 + 试调命中率校验 |

---

## 四、字段配置结构

`response_fields` 为 JSON 数组，元素结构如下。

Python 类型示意：

```python
class ResponseFieldSpec(TypedDict, total=False):
    key: str          # 必填：逻辑名，^[a-z][a-z0-9_]{0,63}$，接口内唯一
    label: str        # 可选：中文展示名
    slot: str         # 可选：语义槽位，闭集白名单；缺省 = 仅展示（不参与同步）
    source: str       # 必填：取值路径
    type: str         # string | number | decimal | date | bool，默认 string
    required: bool    # 默认 false：缺失该字段的行是否丢弃
    scale: int        # 仅 decimal：0~8
    unit: str         # none | yuan | wan | pct，默认 none
    date_format: str  # 仅 date
```

字段属性说明：

| 属性 | 含义 | 约束 |
| --- | --- | --- |
| `key` | 逻辑名 | 必填，`^[a-z][a-z0-9_]{0,63}$`（**已含下划线**，故 `key:"_code"` 合法），接口内唯一；`source:"_code"` 指 text_split 注入的特殊键（边界 7），与 `key` 命名空间独立 |
| `label` | 中文展示名 | 可选 |
| `slot` | 语义槽位 | 可选；**闭集白名单**，缺省 = 仅展示（不参与同步） |
| `source` | 取值路径 | 必填 |
| `type` | 值类型 | `string` / `number` / `decimal` / `date` / `bool`，默认 `string` |
| `required` | 缺失该字段的行是否丢弃 | 默认 `false` |
| `scale` | 小数位 | 仅 `decimal`，0~8 |
| `unit` | 单位 | `none` / `yuan` / `wan` / `pct`，默认 `none` |
| `date_format` | 日期格式 | 仅 `date` |

JSON 示例：

```json
[
  {"key": "code",  "label": "代码",   "slot": "code",  "source": "code",       "type": "string",  "required": true},
  {"key": "name",  "label": "名称",   "slot": "name",  "source": "name",       "type": "string"},
  {"key": "price", "label": "最新价", "slot": "price", "source": "data.last",  "type": "decimal", "scale": 2, "unit": "yuan"},
  {"key": "date",  "label": "日期",   "slot": "date",  "source": "trade_date", "type": "date", "date_format": "%Y-%m-%d"},
  {"key": "notice_title", "label": "公告标题", "source": "title", "type": "string"}
]
```

### 4.1 slot 闭集白名单（仅 5 个）与同步用途契约

每个 slot 背后必须有代码消费者。**同步用途不是用户 CRUD 的「分类」，而是 4 个硬编码 purpose 常量**（代码事实 `backend/app/services/market_data_sync.py:81-84`）：

| purpose 常量 | 值 | 含义 | 消费点 |
| --- | --- | --- | --- |
| `MASTER_LIST_CAT_ID` | `"1"` | 主数据（证券基本信息） | F9.3 `_prepare_master_rows` |
| `QUOTE_CAT_ID` | `"2"` | 价格 / 日线 | F9.1 `_parse_price_rows`、F9.4 `market_daily_price_sync` |
| `DIVIDEND_LIST_CAT_ID` | `"3"` | 分红列表 | F9.5 `dividend_sync._code_of` |
| `NOTICE_CAT_ID` | `"4"` | 公告扫描 | F9.6 `dividend_notice_scan` |

> ⚠️ 用户在前端 CRUD 的「接口分类」是**另一轴（纯展示分类）**，与上面的同步用途 purpose 不是一回事；纯展示分类无同步用途 → 无必填契约（见 §5.2）。原方案 §4.1 / §6 把分类写成 cat1/cat2/**cat3** 是**错误前提**——同步用途是 4 个且含分红/公告，cat3 不存在于同步用途中。

各 slot 的必填契约按 **4 个同步用途** 枚举（单一真相，供 §6 `SLOT_CONTRACT` 使用）：

| slot | 必填用途（其余用途可选） | 当前来源 |
| --- | --- | --- |
| `code` | **全部 4 个用途均必填** | `resp_code_field` / `_FALLBACK_CODE_FIELD` / `_COL_NOTICE_CODE` |
| `name` | `MASTER_LIST` | `resp_name_field` |
| `exchange` | `MASTER_LIST`（缺失可兜底，见下） | `resp_exchange_field` |
| `price` | `QUOTE` | `resp_price_field` |
| `date` | `QUOTE`（日线） | `response_parse.resp_date_field` |

**扩展 slot 必须先有消费者**——这是**有意设的约束**；否则白名单会退化成「随便填」。

### 4.2 `source` 路径语法（在 `_row_get` 内扩展，向后兼容）

| 写法 | 语义 | 状态 |
| --- | --- | --- |
| `code` | dict 顶层 key | 现状，不变 |
| `0` / `1` | **数组行**位置下标 | 现状，不变 |
| `a.b` | 逐层 dict 取值 | 新增 |
| `items[0].code` | 数组下标用方括号 | 新增（消除与字面 key `"0"` 的歧义） |
| `a\.b` | 字面含点的 key | 新增（akshare 列名常见，如 `2024.06`） |

因 `_normalize_rows` 已解包信封键（F6），实际深度通常 1~2 层，**不需要完整 jsonpath**。

**4.2.1 路径 DSL 转义脆弱性（修订建议）**：字符串路径里 `\` 既是 JSON 转义又是路径转义（如 `a\.b`），双重含义极易出错；akshare 列名含 `.` 是常态，会高频踩坑。建议把 `source` 改为**结构化段数组**而非字符串：

```json
{"key": "price", "slot": "price", "source": ["data", "last"], "type": "decimal"}
{"key": "code",  "slot": "code",  "source": [{"index": 0}], "type": "string"}
{"key": "code_lit", "slot": "code", "source": ["2024.06"], "type": "string"}
```

- 段数组天然消灭转义：`"2024.06"` 是字面 key，无需 `\.`；数组下标用 `{"index": N}` 段。
- 段数组可**预编译**为访问器闭包（见 §5「编译一次」），比解析字符串更稳。
- 若坚持保留字符串语法，须显式文档化「`\.` 仅路径转义、JSON 层先 `\\` 转义」的双层规则，并在 Pydantic 校验里禁止未转义的裸点歧义。

---

## 五、数据存储与迁移

新增 `response_fields` JSON 列（nullable）。迁移走 **Expand → Contract 三阶段**：

| 阶段 | 新列 | 旧 4 列 + `resp_date_field` | 读侧 | 回滚性 |
| --- | --- | --- | --- | --- |
| **P1 扩展** | 新增列，新写入落此 | **双写**：每次 admin 保存同时写 `response_fields`（新真相）与旧 4 列 + `response_parse.resp_date_field`（回滚镜像，只读）；读侧始终以 JSON 为准 | `resolve_fields()`（JSON 优先，空则由旧列合成，仅覆盖历史行） | 可回滚 |
| **P2 切换** | 唯一写入口 | 停止写入 | 同 P1 | 需从 JSON 反投影回填才能回滚 |
| **P3 收缩** | 唯一 | Alembic 删列 + 清理 `_FALLBACK_CODE_FIELD` | 仅 JSON | 不可回滚（迁移前备份） |

`resolve_fields(itf: QuoteInterface) -> list[CompiledField]` 为**唯一读入口**，6 个消费点全部改走它。

关键约束：**编译一次、循环复用**——同步要跑数千行，禁止在行循环内解析路径字符串。`resolve_fields()` 返回的 `CompiledField` 必须固化**编译后的访问器闭包**（预解析的段数组或函数），而非原 `source` 字符串；行循环只调用闭包。

### 5.1 P2 准入门槛（用户已采纳，勿放宽）

| 编号 | 门槛 |
| --- | --- |
| ① | 存量接口 `response_fields` **100% 回填**（从旧 4 列 + `response_parse.resp_date_field` + F4 的中文列名兜底常量生成），**含分红/公告用途接口**（原方案漏列）。落点：一次性数据迁移（alembic 或 `backend/scripts` 一次性脚本），**幂等**（按 `interface_id` upsert，重跑安全）；回填后置断言：对每条存量接口，`resolve_fields()` 输出 == 旧列 / `_FALLBACK_CODE_FIELD` / `_COL_NOTICE_*` 提取结果（逐行等价） |
| ② | `MASTER_LIST`(主数据) / `QUOTE`(日线价格) / 分红+公告扫描 **三条链路各成功执行 ≥1 次**（理由：三条链路触发频率差两个数量级，`QUOTE` 每交易日跑、`MASTER_LIST` 可能两周没人碰，只看日历会得到「假信心」） |
| ③ | 期间零 P1 相关缺陷 |
| ④ | 时间下限 **≥2 周（≈10 个交易日）**；上限 **≤1 个季度**（迟删的代价大于早删——双写期旧列会被误读为真相） |
| ⑤ | 加速通道：**影子对账**（对同一批真实响应，分别用旧 4 列与 `response_fields` 两条路径解析，逐行比对 `{code,name,exchange,price,date}`，差异为 0 即证明等价）→ 可压缩到 3~5 个交易日 |
| ⑥ | **护栏提前到 P1**：加断言保证旧列名（`resp_code_field` 等 4 列 + `resp_date_field` + F4 的中文列名兜底）**只允许出现在** `resolve_fields()` 与回填迁移中，防止双写退化成「容忍漂移」。实现用 import-linter 契约或编码期断言（grep/测试），P1 即生效，勿等 P2 冻结旧列后才发现散读点 |

另注：P3 删列是普通 `DROP COLUMN`，不涉及 PG 枚举，无 `ALTER TYPE ... DROP VALUE` 那类坑。

### 5.2 展示字段（无 slot）不落库——用户已确认

纯配置，仅服务试调面板展示；6 个消费点忽略；不参与同步用途契约校验。澄清：此处「纯展示分类」指**用户 CRUD 的展示分类**（无同步用途 → 无必填），**不是**同步用途 purpose（见 §4.1 的 4 个常量 `MASTER_LIST/QUOTE/DIVIDEND_LIST/NOTICE`）。原方案把两者混为一谈（误称「cat3 纯展示」）是错误前提——同步用途是 4 个且均含必填，展示分类才是「零同步干扰」。

---

## 六、校验设计（三层）

| 层 | 位置 | 失败行为 |
| --- | --- | --- |
| 静态 schema | Pydantic（与 `_validate_response_parse` 同级，`backend/app/services/quote_interface.py:36-53` 是既有先例） | 400 拒绝 |
| 分类契约 | `SLOT_CONTRACT` 常量表（**按 4 个同步用途 purpose 枚举必填**，见 §4.1） | 400 拒绝 |
| 运行时试调 | 复用 `POST /api/admin/quote-interfaces/{id}/test`（`backend/app/modules/admin/router.py:831` → `backend/app/services/market_data_sync.py:1227`） | 仅告警，不阻断保存 |

**`SLOT_CONTRACT` 定义（按 4 个同步用途 purpose，单一真相）**：

```python
SLOT_CONTRACT = {
    "1": {"code"},                  # MASTER_LIST_CAT_ID 主数据
    "2": {"code", "price", "date"}, # QUOTE_CAT_ID 价格/日线
    "3": {"code"},                  # DIVIDEND_LIST_CAT_ID 分红列表
    "4": {"code"},                  # NOTICE_CAT_ID 公告扫描
}
```

- `exchange` / `name` **不进必填**（有兜底：`exchange` 缺失按代码前缀推断 F9.3；`name` 缺失仅展示退化）——若契约强制 `required=true` 会改行为（缺失即丢行 vs 推断），故契约只强制**无兜底**的槽（`code` / `price` / `date`）。这与字段级 `required` 语义独立：admin 仍可将 `exchange` 标 `required` 表达「期望有」，但契约层不强制。
- 一个 `NOTICE` 用途接口若没配 `code` 槽，契约表有对应行 → **正确拒绝非法配置**（原方案只列 cat1/cat2，会让分红/公告接口绕过必填校验）。

**静态规则**：

- `key` 唯一
- `slot` 不可重复（同接口不能有两个 `code`）
- `source` 非空且路径段数 ≤5
- `scale` 仅 `decimal` 且 0~8

**契约单源供给**：新增 `GET /api/admin/quote-interfaces/response-field-schema`，返回 `{slots, types, units, contracts}`，前端渲染全靠它——新增 slot 只改后端一处。

**「试调不阻断保存」是刻意设计**：数据源恰好不可用不应阻止管理员保存配置；但前端必须把命中率不达标显示为显式标记，不能静默放过。

---

## 七、前端表单动态渲染

改造「字段映射」页签（`web/src/modules/admin/components/QuoteInterfaceDialog.vue:365-408`），从 4 个平铺 Input 变为**可增删行的映射表格**：

列：`[展示名] [slot 下拉] [source 路径] [类型] [必填] [高级] [删除]`

四层动态性：

| 层 | 机制 |
| --- | --- |
| 1. slot 下拉选项 | ← 契约端点（不硬编码） |
| 2. 按分类条件渲染 | ← `contracts[form.categoryId].required`（表头打 `*`、页签红点）——这是「新增接口时灵活适配」的 UX 落点 |
| 3. source 实时校验 | ← 前端复用同一套路径解析器，输入框旁即时提示 |
| 4. 一键预填 | ← 从试调 `raw` 首行提取顶层 key 生成字段行，并按中文列名猜 slot（`代码→code`、`名称/简称→name`、`最新价/收盘→price`、`market/exchange→exchange`、`日期→date`）。流程：先试调 → 一键生成映射 → 人工校正 |

payload 新增 `buildResponseFields(form)`，与现有 `buildResponseParse()`（`web/src/modules/admin/components/QuoteInterfaceDialog.vue:49-62`）并列，保持「全空返回 `null`」既有约定。

**必须先抽组件**：`QuoteInterfaceDialog.vue` 现 577 行，已超 `AGENTS.md` §4 的 400 行约定、逼近 800 行硬闸门，应抽 `InterfaceFieldMappingTable.vue`。

---

## 八、边界情况清单

| 编号 | 边界情况 | 处理 |
| --- | --- | --- |
| 1 | akshare 列名含点与点号路径冲突 | 强制 `\.` 转义，不做静默双策略 |
| 2 | dict 行的字面 key `"0"` vs 数组行下标 `0` | 保持现状语义，数组下标改用 `[0]` |
| 3 | NaN / `pd.NA` | 显式判定为 `None`，**绝不可当 0**；用 `pd.isna` 而非 try-except 兜底 |
| 4 | MultiIndex 列（SDK） | `to_dict("records")` 产 tuple key，需显式**拒绝并给可读错误**（与边界 5「宁可错得明显」一致，静默展平会掩盖数据问题）；若确需支持，单独立项，不在本方案隐式展平 |
| 5 | 单位（元/万元/手/%） | 必须显式声明 `unit`；未声明不做任何换算（宁可错得明显，不要错得隐蔽） |
| 6 | `required=true` 命中失败 | 定为整行丢弃 + 计数，与既有 `consecutive_failures` / `alerted` 机制衔接，不是给默认值 |
| 7 | text_split 注入的 `_code` 特殊键 | 必须允许 `source: "_code"`，并写进文档与预填提示 |
| 8 | 数组行做展示字段 | 无 key 可提取，预填须识别并提示填位置下标 |
| 9 | 改映射不回填历史 | 只影响后续同步，UI 必须明说 |
| 10 | 接口换同步用途（如 `MASTER_LIST`→`NOTICE`） | 按新用途契约（`SLOT_CONTRACT`）重校验，不允许留下「该用途接口没有必填槽」的非法态（如 `NOTICE` 缺 `code`） |
| 11 | `parsed` 契约是破坏性变更 | `InterfaceTestPanel.vue:427-448` 固定两列 + `Record<string,string>` 需改为「行数组 + 逐槽位命中」，连带改 `_parse_test_rows`（`backend/app/services/market_data_sync.py:660-672`）与前端类型（`web/src/api/quote-interface.api.ts:175-186`），**并波及 e2e**（实施时须 `grep -rl "parsed"` 锁定 `web/src/**/*.test.ts` / `web/src/**/*.spec.ts` 中引用 `InterfaceTestPanel` / `parsed` 的用例，逐个迁移，禁止整目录跳过） |
| 12 | 生成类型漂移 | `web/src/types/api.ts` 是 OpenAPI 生成物，须重跑生成；新增 TS 类型若仅字符串引用会被 knip 判 unused（见 `AGENTS.md` §3 knip 陷阱） |
| 13 | 历史数据兼容 | `resolve_fields()` 的旧列合成分支必须同时覆盖 `response_parse.resp_date_field` |
| 14 | 性能 | 路径必须预编译，禁止行循环内解析路径字符串 |

---

## 九、落地顺序与验收

| 步骤 | 内容 |
| --- | --- |
| 1. P1-后端 | 加 `response_fields` 列 + `ResponseFieldSpec` 校验 + `resolve_fields()` + 6 个消费点改走它（**行为等价，先不加新能力**）；旧列双写 |
| 2. P1-后端 | 扩展 `_row_get` 路径语法 + 试调接口输出逐槽位命中率 |
| 3. P1-前端 | 抽 `InterfaceFieldMappingTable.vue`、接契约端点、按分类必填提示、一键预填 |
| 4. 闸门 | `python scripts/pre_commit_gate.py` + `uv run pytest` + `pnpm run lint` + `pnpm test` |
| 5. P2/P3 | 按第 5 节准入门槛推进 |

**测试矩阵（必做，防回归）**：

| 测试 | 覆盖 |
| --- | --- |
| `resolve_fields` 路径语法单测 | 顶层 key / 数组下标 / `a.b` / `a\.b` / 段数组（若采纳 §4.2.1）各形态 |
| 回填等价性 | 存量接口回填后 `resolve_fields()` 输出 == 旧列 / `_FALLBACK_CODE_FIELD` / `_COL_NOTICE_*` 提取（golden） |
| 影子对账 | 同批响应旧路径 vs `response_fields` 逐行 `{code,name,exchange,price,date}` 差异 0 |
| 6 消费点行为等价 | 各用途（主数据/价格/分红/公告）golden 用例，改前后输出一致 |
| 契约 400 用例 | 缺必填槽（按 4 用途）正确拒绝；展示分类不强制 |
| 边界 | NaN / 单位 / MultiIndex / 字面 `"0"` 各边界单测 |

**提交纪律**：Conventional Commits 按特性拆分，作者 `senior-dev <dev@local>`，**agent 不主动 push**。

---

## 十、待明确事项

1. 旧 4 列的回滚窗口长度由第 5 节准入门槛决定，具体日期待 P1 上线后按交易日推。
2. codebase-memory 服务端存在两个同名指向同一 root 的项目（`investment-return-tracker` 6352 节点 / 路径派生名 6366 节点），用户已指示暂缓处理。

---

## 十一、修订记录

- **2026-09-11（CodeReviewExpert 审查后修订）**：采纳 12 条审查意见，关键修正：
  - 🔴 阻断：`§4.1` / `§6` 分类契约由「cat1/cat2/cat3」改为 **4 个同步用途 purpose 常量**（`MASTER_LIST_CAT_ID="1"` / `QUOTE_CAT_ID="2"` / `DIVIDEND_LIST_CAT_ID="3"` / `NOTICE_CAT_ID="4"`），补全分红/公告必填；澄清用户 CRUD 展示分类是另一轴（非同步用途）。
  - 🟡 F4 扩为「至少 5 处隐式真相」，纳入 `dividend_notice_scan.py:57-58` 的 `_COL_NOTICE_CODE` / `_COL_NOTICE_TITLE`。
  - 🟡 `source` 建议改结构化段数组（§4.2.1），消灭 `\.` 双层转义。
  - 🟡 P1 双写措辞修正为「同时写新真相与回滚镜像」；护栏⑥提前到 P1。
  - 🟡 门槛①补落点 / 幂等 / 回填等价断言；`required` 与兜底冲突说明（§4.1 / §6：仅无兜底槽强制必填）。
  - 🟡 新增测试矩阵（§9）；边界 4 改「显式拒绝」；边界 11 点名 e2e 迁移方式。
  - 💭 `key` 正则已含下划线（`key:"_code"` 合法）澄清；编译一次固化访问器闭包澄清。
