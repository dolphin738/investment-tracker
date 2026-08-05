/**
 * Data Transfer（CSV 导入 / 导出）类型定义
 *
 * 对应后端 `data-transfer` 模块（T05 实现，T01 先落契约供前后端同时开工）：
 * - `GET  /api/portfolios/:portfolioId/export?type=...`     导出 CSV
 * - `GET  /api/data-transfer/template?type=...`             下载导入模板
 * - `POST /api/portfolios/:portfolioId/import/preview`      预览（**不落库**）
 * - `POST /api/portfolios/:portfolioId/import/commit`       提交（事务 + 单次重算）
 *
 * 🔴 约定（详见增量设计 §7.7）：
 * - CSV 编码 UTF-8，导出**必须前置 BOM `\uFEFF`**（Excel 兼容）。
 * - 表头使用英文字段名，与 API 字段一致，保证「导出 → 修改 → 导入」闭环。
 * - 所有 Decimal 一律以**字符串**读写，绝不经过 `Number()`（防精度丢失）。
 * - 日期一律 `YYYY-MM-DD`。
 */

// ============================================================
// 导出
// ============================================================

/** 可导出的数据类别（7 类） */
export const ExportType = {
  /** 标的主数据 */
  SECURITIES: 'securities',
  /** 证券买卖流水 */
  SECURITY_TRADES: 'securityTrades',
  /** 出入金流水 */
  CASH_FLOWS: 'cashFlows',
  /** 现金余额记录 */
  CASH_BALANCES: 'cashBalances',
  /** 证券价格记录 */
  SECURITY_PRICES: 'securityPrices',
  /** 资产快照 */
  ASSET_SNAPSHOTS: 'assetSnapshots',
  /** 净值序列 */
  NAV_SERIES: 'navSeries',
} as const;

/** 可导出的数据类别 */
export type ExportType = (typeof ExportType)[keyof typeof ExportType];

/** 全部导出类别（供前端渲染多选项 / 后端做白名单校验） */
export const EXPORT_TYPES: readonly ExportType[] = Object.values(ExportType);

// ============================================================
// 导入
// ============================================================

/** 可导入的数据类别（3 类） */
export const ImportType = {
  /** 证券买卖流水 */
  SECURITY_TRADES: 'securityTrades',
  /** 出入金流水 */
  CASH_FLOWS: 'cashFlows',
  /** 资产快照 */
  ASSET_SNAPSHOTS: 'assetSnapshots',
} as const;

/** 可导入的数据类别 */
export type ImportType = (typeof ImportType)[keyof typeof ImportType];

/** 全部导入类别（供前端渲染下拉 / 后端做白名单校验） */
export const IMPORT_TYPES: readonly ImportType[] = Object.values(ImportType);

/** 导入错误码（详见增量设计 §7.8） */
export const ImportErrorCode = {
  INVALID_FILE_TYPE: 'INVALID_FILE_TYPE',
  FILE_TOO_LARGE: 'FILE_TOO_LARGE',
  TOO_MANY_ROWS: 'TOO_MANY_ROWS',
  MISSING_REQUIRED_COLUMN: 'MISSING_REQUIRED_COLUMN',
  INVALID_DATE_FORMAT: 'INVALID_DATE_FORMAT',
  INVALID_DECIMAL_PRECISION: 'INVALID_DECIMAL_PRECISION',
  INVALID_ENUM_VALUE: 'INVALID_ENUM_VALUE',
  SECURITY_NOT_FOUND: 'SECURITY_NOT_FOUND',
  DUPLICATE_SNAPSHOT_DATE: 'DUPLICATE_SNAPSHOT_DATE',
} as const;

/** 导入错误码 */
export type ImportErrorCode =
  (typeof ImportErrorCode)[keyof typeof ImportErrorCode];

/** 单元格 / 行级错误（行号以 CSV 数据行为准，表头为第 0 行） */
export interface ImportRowError {
  /** 原始 CSV 行号（1 起，不含表头） */
  row: number;
  /** 出错字段名；整行级错误为 null */
  field: string | null;
  /** 错误码 */
  code: ImportErrorCode;
  /** 已本地化的错误说明 */
  message: string;
}

/** CSV 导入行的通用形态：字段名 → 原始字符串（Decimal 不转 number） */
export type ImportRow = Record<string, string>;

/** 预览结果（阶段一，**绝不写库**） */
export interface ImportPreviewResult {
  /** 导入类别 */
  type: ImportType;
  /** 解析出的总行数（不含表头） */
  totalRows: number;
  /** 校验通过的行数 */
  validRows: number;
  /** 前 10 条有效行样例（供 UI 表格预览） */
  sample: ImportRow[];
  /** **全量**行级错误（可导出为错误 CSV） */
  errors: ImportRowError[];
  /** 全部有效行中的最小日期 YYYY-MM-DD；无有效行 → null（提交后重算起点） */
  minDate: string | null;
  /** 预览令牌：commit 阶段回传，供后端做一致性校验 */
  token: string;
}

/** 单次重算摘要（🔴 全流程仅 1 次） */
export interface RecalcSummary {
  /** 重算起始日 YYYY-MM-DD */
  fromDate: string;
  /** 重算截止日 YYYY-MM-DD（= 今天） */
  toDate: string;
  /** 实际重算天数 */
  recalculatedDays: number;
}

/** 提交结果（阶段二） */
export interface ImportCommitResult {
  /** 新增行数 */
  inserted: number;
  /** 更新行数（仅 assetSnapshots upsert 命中已有记录时 > 0） */
  updated: number;
  /** 跳过行数 */
  skipped: number;
  /** 写入阶段仍失败的行 */
  failed: ImportRowError[];
  /** 重算摘要；未触发重算（0 有效行）→ null */
  recalculated: RecalcSummary | null;
}
