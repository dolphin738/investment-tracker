/**
 * features/cashflow/query-params.ts — 出入金筛选 URL query 编解码纯函数
 *
 * FLOW-P0-02 验收2：筛选/排序/分页写入 URL query，刷新/分享后保持。
 * 参数名对齐后端 CashFlowQueryDto 白名单（Part E-2），避免 forbidNonWhitelisted 400：
 *   startDate / endDate / types / sortBy / sortOrder / page / pageSize
 *
 * 语义约定（Part E-1）：
 * - `types` 多选，空数组（全不勾）= 全部 → 不写入 URL
 * - 勾选一个 = 仅该类；勾选两个 = 全部
 * - `pageSize` 仅接受 20/50/100，非法回落默认 20
 */
import type { TransactionQuery } from '@/api/types';

/** 类型多选可选值（存入 BUY / 取出 SELL） */
export const TRANSACTION_TYPE_OPTIONS = ['BUY', 'SELL'] as const;
export type TransactionTypeOption = (typeof TRANSACTION_TYPE_OPTIONS)[number];

/** 分页大小选项（FLOW-P0-02 验收2） */
export const PAGE_SIZE_OPTIONS = [20, 50, 100] as const;
export const DEFAULT_PAGE_SIZE = 20;

/** 排序选项（F5 已获批：sortBy=date|amount + sortOrder=asc|desc） */
export const SORT_OPTIONS = [
  { value: 'date:desc', sortBy: 'date', sortOrder: 'desc', label: '日期 · 新→旧' },
  { value: 'date:asc', sortBy: 'date', sortOrder: 'asc', label: '日期 · 旧→新' },
  { value: 'amount:desc', sortBy: 'amount', sortOrder: 'desc', label: '金额 · 高→低' },
  { value: 'amount:asc', sortBy: 'amount', sortOrder: 'asc', label: '金额 · 低→高' },
] as const;

/** 解析 URL 的 types 参数（逗号分隔）→ 多选数组；缺失/非法 → 全部（[]） */
export function parseTypesParam(raw: string | null): TransactionTypeOption[] {
  if (!raw) return [];
  return raw.split(',').filter((v): v is TransactionTypeOption =>
    (TRANSACTION_TYPE_OPTIONS as readonly string[]).includes(v),
  );
}

/** 多选数组 → URL types 参数；空数组（全部）→ null（不写入 URL） */
export function typesToParam(types: readonly TransactionTypeOption[]): string | null {
  return types.length > 0 ? types.join(',') : null;
}

/** 解析 URL pageSize：仅接受 20/50/100，非法回落默认 20 */
export function parsePageSizeParam(raw: string | null): number {
  if (raw === null) return DEFAULT_PAGE_SIZE;
  const n = Number(raw);
  return (PAGE_SIZE_OPTIONS as readonly number[]).includes(n) ? n : DEFAULT_PAGE_SIZE;
}

/** 解析 URL page：正整数有效，非法回落 1 */
export function parsePageParam(raw: string | null): number {
  if (raw === null) return 1;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 1 ? n : 1;
}

/** 解析 URL sortBy / sortOrder：非法回落 date / desc */
export function parseSortParam(
  rawBy: string | null,
  rawOrder: string | null,
): { sortBy: NonNullable<TransactionQuery['sortBy']>; sortOrder: NonNullable<TransactionQuery['sortOrder']> } {
  const sortBy = rawBy === 'amount' ? 'amount' : 'date';
  const sortOrder = rawOrder === 'asc' ? 'asc' : 'desc';
  return { sortBy, sortOrder };
}

/** 从 URLSearchParams 解码完整筛选条件（供出入金页初始化读取） */
export function parseTransactionSearchParams(sp: URLSearchParams): {
  types: TransactionTypeOption[];
  startDate: string;
  endDate: string;
  sortBy: NonNullable<TransactionQuery['sortBy']>;
  sortOrder: NonNullable<TransactionQuery['sortOrder']>;
  page: number;
  pageSize: number;
} {
  const { sortBy, sortOrder } = parseSortParam(sp.get('sortBy'), sp.get('sortOrder'));
  return {
    types: parseTypesParam(sp.get('types')),
    startDate: sp.get('startDate') ?? '',
    endDate: sp.get('endDate') ?? '',
    sortBy,
    sortOrder,
    page: parsePageParam(sp.get('page')),
    pageSize: parsePageSizeParam(sp.get('pageSize')),
  };
}
