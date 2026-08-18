/**
 * modules/analysis/features/dimension.ts — toDimensionQueryParams 单测（移植自 React 版）
 *
 * 验证点：
 * 1. `toDimensionQueryParams` 必须剥离仅用于 UI 回显的 `quick` 字段 —— 否则后端
 *    ValidationPipe(forbidNonWhitelisted) 会因多出 `quick` 键返回 400。
 * 2. granularity/startDate/endDate/aggregation 原样保留。
 * 3. quick 为 undefined 也不出现在结果中。
 */

import { describe, expect, it } from 'vitest';
import {
  toDimensionQueryParams,
  type DimensionSwitcherValue,
} from '@/modules/analysis/features/dimension';

const BASE_VALUE: DimensionSwitcherValue = {
  granularity: 'month',
  startDate: '',
  endDate: '',
  aggregation: 'last',
  quick: '',
};

describe('toDimensionQueryParams — 剥离 quick 防后端 400', () => {
  it('返回结果不含 quick 字段', () => {
    const value: DimensionSwitcherValue = { ...BASE_VALUE, quick: '1y' };
    const params = toDimensionQueryParams(value);
    expect('quick' in params).toBe(false);
  });

  it('granularity/startDate/endDate/aggregation 原样保留', () => {
    const value: DimensionSwitcherValue = {
      granularity: 'week',
      startDate: '2024-01-01',
      endDate: '2024-12-31',
      aggregation: 'avg',
      quick: '3m',
    };
    expect(toDimensionQueryParams(value)).toEqual({
      granularity: 'week',
      startDate: '2024-01-01',
      endDate: '2024-12-31',
      aggregation: 'avg',
    });
  });

  it('quick 为 undefined 也不出现在结果中', () => {
    const params = toDimensionQueryParams({ ...BASE_VALUE });
    expect(Object.keys(params).sort()).toEqual([
      'aggregation',
      'endDate',
      'granularity',
      'startDate',
    ]);
  });
});
