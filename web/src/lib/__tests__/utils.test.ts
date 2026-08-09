/**
 * lib/__tests__/utils.test.ts — formatAmountChange / computeManualDiffStats 单测
 *
 * 覆盖 PRD §7.3 差异列（SNAP-P0-04b ⑥）与差异提示条统计（SNAP-P0-07 ⑥）口径：
 * - formatAmountChange：`+9,000.00 (+3.20%)` / `-1,000.00 (-0.36%)`；
 *   任一为 null / 非有限数 / base=0 → '-'
 * - computeManualDiffStats：仅 MANUAL 计入 N；|差异率| > 1% 计入 M；边界 =1% 不计；
 *   系统值缺失 / 为 0 / 手工值非有限数 → 不计 M
 */

import { describe, expect, it } from 'vitest';
import { computeManualDiffStats, formatAmountChange } from '@/lib/utils';

describe('formatAmountChange — 差异金额 + 差异%', () => {
  it('正值：+9,000.00 (+3.20%)', () => {
    expect(formatAmountChange(290000, 281000)).toBe('+¥9,000.00 (+3.20%)');
  });

  it('正值（不同比率）：+2,000.00 (+2.00%) 带 + 号', () => {
    expect(formatAmountChange(102000, 100000)).toBe('+¥2,000.00 (+2.00%)');
  });

  it('负值：-1,000.00 (-0.36%)', () => {
    expect(formatAmountChange(280000, 281000)).toBe('¥-1,000.00 (-0.36%)');
  });

  it('无差异：0.00 (0.00%)', () => {
    expect(formatAmountChange(281000, 281000)).toBe('¥0.00 (0.00%)');
  });

  it('Decimal 字符串输入与 number 等价', () => {
    expect(formatAmountChange('290000.00', '281000.00')).toBe('+¥9,000.00 (+3.20%)');
  });

  it('任一为 null / 空串 → -', () => {
    expect(formatAmountChange(null, 281000)).toBe('-');
    expect(formatAmountChange(290000, null)).toBe('-');
    expect(formatAmountChange(undefined, 281000)).toBe('-');
    expect(formatAmountChange('', 281000)).toBe('-');
  });

  it('base 为 0 / 非有限数 → -（避免除零）', () => {
    expect(formatAmountChange(290000, 0)).toBe('-');
    expect(formatAmountChange(Number.NaN, 281000)).toBe('-');
    expect(formatAmountChange(290000, Number.NaN)).toBe('-');
  });
});

describe('computeManualDiffStats — 差异提示条 N/M 统计', () => {
  const systemMap = new Map<string, number>([
    ['2026-07-31', 281000],
    ['2026-07-30', 100000],
  ]);

  it('无手工记录 → N=0, M=0', () => {
    const stats = computeManualDiffStats(
      [
        { date: '2026-07-31', totalAsset: '281000.00', source: 'DERIVED' },
        { date: '2026-07-30', totalAsset: '100000.00', source: 'DERIVED' },
      ],
      systemMap,
    );
    expect(stats).toEqual({ manualCount: 0, diffOverThresholdCount: 0 });
  });

  it('手工记录：差异 3.2% 计入 M，差异 0.5% 不计入', () => {
    const stats = computeManualDiffStats(
      [
        { date: '2026-07-31', totalAsset: '290000.00', source: 'MANUAL' },
        { date: '2026-07-30', totalAsset: '100500.00', source: 'MANUAL' },
      ],
      systemMap,
    );
    expect(stats).toEqual({ manualCount: 2, diffOverThresholdCount: 1 });
  });

  it('边界：差异恰好 1% 不计入（阈值 >1%）', () => {
    const stats = computeManualDiffStats(
      [{ date: '2026-07-30', totalAsset: '101000.00', source: 'MANUAL' }],
      systemMap,
    );
    expect(stats).toEqual({ manualCount: 1, diffOverThresholdCount: 0 });
  });

  it('系统值缺失 / 为 0 / 手工值非有限数 → 不计 M 但仍计 N', () => {
    const stats = computeManualDiffStats(
      [
        { date: '2020-01-01', totalAsset: '50000.00', source: 'MANUAL' }, // 无系统值
        { date: '2026-07-30', totalAsset: 'not-a-number', source: 'MANUAL' }, // 手工值非法
      ],
      systemMap,
    );
    expect(stats).toEqual({ manualCount: 2, diffOverThresholdCount: 0 });
  });

  it('systemValueMap 为 null/undefined → 仅计 N', () => {
    expect(computeManualDiffStats(
      [{ date: '2026-07-31', totalAsset: '290000.00', source: 'MANUAL' }],
      null,
    )).toEqual({ manualCount: 1, diffOverThresholdCount: 0 });
  });
});
