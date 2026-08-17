/**
 * features/cashflow/query-params.test.ts — 出入金筛选 URL query 编解码（FLOW-P0-02）
 *
 * 覆盖「类型多选语义」与「URL query 同步」的纯函数部分：
 * - types 空数组 = 全部（不写入 URL）
 * - 多选往返一致（types=BUY,SELL 逗号分隔，Part E-2）
 * - 非法值过滤（防注入）
 * - pageSize 仅接受 20/50/100；page / sort 非法回落
 */

import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PAGE_SIZE,
  parsePageParam,
  parsePageSizeParam,
  parseSortParam,
  parseTransactionSearchParams,
  parseTypesParam,
  typesToParam,
} from '../query-params';

describe('query-params — 出入金筛选 URL query 编解码', () => {
  it('types 空数组（全不勾）= 全部：不写入 URL，解析回空数组', () => {
    expect(typesToParam([])).toBeNull();
    expect(parseTypesParam(null)).toEqual([]);
  });

  it('types 多选编码为逗号分隔，解析往返一致', () => {
    expect(typesToParam(['BUY', 'SELL'])).toBe('BUY,SELL');
    expect(typesToParam(['BUY'])).toBe('BUY');
    expect(parseTypesParam('BUY,SELL')).toEqual(['BUY', 'SELL']);
    expect(parseTypesParam('BUY')).toEqual(['BUY']);
  });

  it('非法 types 值被过滤（防注入）', () => {
    expect(parseTypesParam('BUY,HACK,SELL')).toEqual(['BUY', 'SELL']);
    expect(parseTypesParam('')).toEqual([]);
  });

  it('pageSize 仅接受 20/50/100，非法回落默认 20', () => {
    expect(parsePageSizeParam('20')).toBe(20);
    expect(parsePageSizeParam('50')).toBe(50);
    expect(parsePageSizeParam('100')).toBe(100);
    expect(parsePageSizeParam('30')).toBe(DEFAULT_PAGE_SIZE);
    expect(parsePageSizeParam(null)).toBe(DEFAULT_PAGE_SIZE);
  });

  it('page 解析：正整数有效，非法回落 1', () => {
    expect(parsePageParam('3')).toBe(3);
    expect(parsePageParam('0')).toBe(1);
    expect(parsePageParam('abc')).toBe(1);
    expect(parsePageParam(null)).toBe(1);
  });

  it('sort 解析：非法回落 date/desc', () => {
    expect(parseSortParam('amount', 'asc')).toEqual({ sortBy: 'amount', sortOrder: 'asc' });
    expect(parseSortParam(null, null)).toEqual({ sortBy: 'date', sortOrder: 'desc' });
    expect(parseSortParam('hack', 'up')).toEqual({ sortBy: 'date', sortOrder: 'desc' });
  });

  it('整体解码：从 URLSearchParams 还原完整筛选条件', () => {
    const sp = new URLSearchParams(
      'types=BUY,SELL&startDate=2024-01-01&endDate=2024-12-31&sortBy=amount&sortOrder=asc&page=2&pageSize=50',
    );
    expect(parseTransactionSearchParams(sp)).toEqual({
      types: ['BUY', 'SELL'],
      startDate: '2024-01-01',
      endDate: '2024-12-31',
      sortBy: 'amount',
      sortOrder: 'asc',
      page: 2,
      pageSize: 50,
    });
  });

  it('空 URL：全部回落默认值（全不勾=全部 / date desc / 第 1 页 / 20 条）', () => {
    expect(parseTransactionSearchParams(new URLSearchParams())).toEqual({
      types: [],
      startDate: '',
      endDate: '',
      sortBy: 'date',
      sortOrder: 'desc',
      page: 1,
      pageSize: DEFAULT_PAGE_SIZE,
    });
  });
});
