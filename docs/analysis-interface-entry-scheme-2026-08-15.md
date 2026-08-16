# 金融数据源接口录入方案分析：多提供方 API 差异与 `response_parse` 协议

> 文档更新：2026-08-15
> 适用范围：多提供方证券行情数据提供方 →「新增接口」录入模型与响应解析逻辑
> 相关代码：
> - 接口模型：`backend/app/models/quote_interface.py`
> - 响应解析：`backend/app/services/market_data_sync.py`
> - 录入对话框：`web/src/features/admin/quote-interface-dialog.tsx`
> - 接口设置示例：`docs/quote-provider-setup-examples.md`

---

## 一、3 个提供方 API 方式差异

| 维度 | 小熊同学 autostock.cn | 东方财富 | 腾讯财经 qt.gtimg.cn |
| --- | --- | --- | --- |
| 请求 | HTTPS GET | HTTPS GET | HTTPS GET（`/q?code=...`） |
| 响应格式 | 标准 JSON 信封 `{code,message,data:[...]}`，部分接口返回数组行 | 标准 JSON，字段名各异 | 非 JSON 纯文本 `v_sz000001="51~平安银行~000001~..."` |
| 编码 | UTF-8 | UTF-8 | GBK（否则中文乱码） |
| 字段定位 | dict 字段名 / 数组下标（`'0'`/`'1'`） | dict 字段名 | 波浪号分隔 + 下标（fields[1]=名称, [2]=代码, [3]=价格） |

### 1. 小熊同学（autostock.cn）
- Base URL：`https://api.autostock.cn/v1`
- 响应一般为标准 JSON 信封 `{code, message, traceId, meta, data:[{...}]}`；
- 部分接口（如 `/stock/all`）返回数组行 `[["sz301141","中科磁业"],...]`，需把 `resp_code_field` / `resp_name_field` 配置为整数下标 `'0'` / `'1'`。

### 2. 东方财富
- 标准 JSON 响应，字段名与其它源不同，用 `resp_code_field` / `resp_price_field` / `resp_name_field` / `resp_exchange_field` 做字段映射。

### 3. 腾讯财经（qt.gtimg.cn）
- 请求：`https://qt.gtimg.cn/q=`，代码前需带市场前缀（`sh`/`sz`/`hk`/`us`），批量用逗号拼接（如 `sz000001,sh600519`）；
- 响应：非标准 JSON，以波浪号 `~` 分隔的纯文本，形如 `v_sz000001="51~平安银行~000001~..."`；
- 编码：必须用 GBK 解码，否则中文乱码；
- 字段：`split('~')` 后按下标取值（fields[1]=名称, [2]=代码, [3]=当前价, [4]=昨收, ...）；
- 频率：收费免费但高频易封 IP，建议间隔 100ms 以上。

---

## 二、当前录入方案的瓶颈

当前方案用四个字段做字段映射，能覆盖小熊（JSON dict / 数组行）和东财（JSON dict）：

- `resp_code_field`：响应中证券代码字段
- `resp_price_field`：响应中价格字段
- `resp_name_field`：响应中证券名称字段
- `resp_exchange_field`：响应中交易所字段

但**响应格式解析被硬编码为 JSON**：

- `market_data_sync.py` 的 HTTPS 调用固定 `resp.json()`，无法处理 GBK 编码 + 非 JSON 文本；
- `_normalize_rows` 只识别 dict / list JSON，识别不了 `v_xxx="..."~` 分隔文本。

**结论：当前录入方案无法接入腾讯财经这类文本接口，需扩展「响应解析协议」。**

---

## 三、推荐方案：接口级 `response_parse` 协议

核心思路：把「响应格式解析」从硬编码解耦为接口级可配置，但所有格式最终归一成统一的「行模型」（dict 行 / 数组行），复用现有 `resp_*` 字段取值，不改变既有解析逻辑。

### 模型扩展

在 `QuoteInterface` 上新增一个 JSON 字段 `response_parse`（可空，向后兼容，无需表结构重建）：

```json
{
  "format": "json" | "text_split",
  "encoding": "utf-8" | "gbk",
  "sep": "~",
  "line_regex": "v_\\w+=\"(.*)\""
}
```

| 字段 | 可选值 | 默认 | 说明 |
| --- | --- | --- | --- |
| `format` | `json` / `text_split` | `json` | JSON 默认；文本分隔 |
| `encoding` | `utf-8` / `gbk` 等 | `utf-8` | 响应解码编码 |
| `sep` | 任意字符串 | 无 | 文本分隔符（`format=text_split` 时） |
| `line_regex` | 正则 | 无 | 文本行提取正则，去掉 `v_xxx="` 前缀 |

### 各提供方接入示例

- **JSON 接口**（小熊 / 东财）：`format=json`，走现有 `resp.json()` + `_normalize_rows`，完全不变；
- **文本接口**（腾讯财经）：`format=text_split` + `encoding=gbk` + `sep=~` + `line_regex`，新增 `_parse_text_split()` 把每行转成数组行 `[51, 平安银行, 000001, ...]`，再复用 `_row_get` 的下标取值（`resp_name_field='1'`、`resp_code_field='2'`、`resp_price_field='3'`）。

### 改动面（落地时）

| 文件 | 改动 |
| --- | --- |
| `backend/app/models/quote_interface.py` | 新增 `response_parse` 字段 + 序列化 |
| `backend/app/services/market_data_sync.py` | HTTPS `_do()` 按 `format` 分派，新增 `_parse_text_split()` |
| `web/src/features/admin/quote-interface-dialog.tsx` | 新增「响应格式」配置区 |
| `web/src/api/quote-interface.api.ts` | 类型补充 |

字段映射、测试面板、主数据同步全部复用现有逻辑，无需改动。

---

## 四、落地影响

- 不涉及表结构重建（JSON 字段可空，向后兼容）；
- 既有 JSON 接口行为不变；
- 新增文本接口能力，覆盖腾讯财经这类非标准响应源。

---

## 五、待决策 / 后续

- 是否按 `response_parse` 协议完整实现，或最小化只加 `text_split` 支持；
- 腾讯财经响应字段完整映射（fields[31] 涨跌额、[32] 涨跌幅、[33] 最高、[34] 最低、[36] 成交量、[37] 成交额、[45] 总市值）待接入时补充说明。