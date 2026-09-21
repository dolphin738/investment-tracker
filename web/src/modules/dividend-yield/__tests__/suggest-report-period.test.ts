/**
 * modules/dividend-yield/__tests__/suggest-report-period.test.ts
 * — 前端「建议报告期」纯函数 7 条真样本回归（设计 §5.3.5）
 *
 * 样本取自真实公告（非编造）：主候选来自公告日、备选来自除权日 −2 季（标记 approximate）。
 * 后端永不判定报告期，本纯函数是前端唯一算法真源。
 */
import { describe, expect, it } from 'vitest';
import {
  inferPeriodType,
  isOutsideRetention,
  isValidQuarter,
  legalQuarters,
  maxReportYear,
  retentionMinYear,
  suggestReportPeriod,
} from '../lib/suggest-report-period';

describe('suggestReportPeriod — 7 条真样本回归', () => {
  it('600519 特别分红：ann 2022-12-21 / ex 2022-12-27 → 主 2022Q4 SPECIAL，备 2022Q2（approximate）', () => {
    const c = suggestReportPeriod({
      dividendLabel: '特别分红',
      announcementDate: '2022-12-21',
      exDividendDate: '2022-12-27',
    });
    expect(c[0]).toMatchObject({
      reportYear: 2022,
      reportQuarter: 4,
      periodType: 'SPECIAL',
      approximate: false,
    });
    expect(c[1]).toMatchObject({
      reportYear: 2022,
      reportQuarter: 2,
      periodType: 'SPECIAL',
      approximate: true,
    });
  });

  it('600519 特别分红：ann 2023-12-14 / ex 2023-12-20 → 主 2023Q4 SPECIAL，备 2023Q2', () => {
    const c = suggestReportPeriod({
      dividendLabel: '特别分红',
      announcementDate: '2023-12-14',
      exDividendDate: '2023-12-20',
    });
    expect(c[0]).toMatchObject({ reportYear: 2023, reportQuarter: 4, approximate: false });
    expect(c[1]).toMatchObject({ reportYear: 2023, reportQuarter: 2, approximate: true });
  });

  it('300770 特别分红：仅 ex 2024-11-26（无 ann）→ 无主候选，备 2024Q2', () => {
    const c = suggestReportPeriod({
      dividendLabel: '特别分红',
      announcementDate: null,
      exDividendDate: '2024-11-26',
    });
    expect(c).toHaveLength(1);
    expect(c[0]).toMatchObject({ reportYear: 2024, reportQuarter: 2, approximate: true });
  });

  it('601828 特别分红：仅 ex 2023-07-24（无 ann）→ 备 2023Q1', () => {
    const c = suggestReportPeriod({
      dividendLabel: '特别分红',
      announcementDate: null,
      exDividendDate: '2023-07-24',
    });
    expect(c[0]).toMatchObject({ reportYear: 2023, reportQuarter: 1, approximate: true });
  });

  it('300750 年度分红：仅 ex 2024-04-30 → 备 2023Q4 ANNUAL（−2 季跨年后吸附到 Q4）', () => {
    const c = suggestReportPeriod({
      dividendLabel: '年度分红',
      announcementDate: null,
      exDividendDate: '2024-04-30',
    });
    expect(c[0]).toMatchObject({
      reportYear: 2023,
      reportQuarter: 4,
      periodType: 'ANNUAL',
      approximate: true,
    });
  });

  it('601088 年度分红：仅 ex 2017-07-10 → 备 2017Q4 ANNUAL', () => {
    const c = suggestReportPeriod({
      dividendLabel: '年度分红',
      announcementDate: null,
      exDividendDate: '2017-07-10',
    });
    expect(c[0]).toMatchObject({ reportYear: 2017, reportQuarter: 4, periodType: 'ANNUAL' });
  });

  it('600900 股改分红：ex 空、ann 空 → []（无候选，须人工）', () => {
    const c = suggestReportPeriod({
      dividendLabel: '股改分红',
      announcementDate: null,
      exDividendDate: null,
    });
    expect(c).toEqual([]);
  });
});

describe('inferPeriodType — 标签 → 类型', () => {
  it('年度 / 中期 / 季度 / 特别 → 对应类型', () => {
    expect(inferPeriodType('年度分红')).toBe('ANNUAL');
    expect(inferPeriodType('2024年中期权益分派')).toBe('INTERIM');
    expect(inferPeriodType('季度分红')).toBe('QUARTERLY');
    expect(inferPeriodType('特别分红')).toBe('SPECIAL');
  });

  it('股改 / 重整转增 / 空 / 未知 → OTHER', () => {
    expect(inferPeriodType('股改分红')).toBe('OTHER');
    expect(inferPeriodType('重整转增')).toBe('OTHER');
    expect(inferPeriodType('')).toBe('OTHER');
    expect(inferPeriodType(null)).toBe('OTHER');
  });
});

describe('合法季度格与留存窗', () => {
  it('ANNUAL=[4] / INTERIM=[2] / QUARTERLY=[1,3] / SPECIAL=[1,2,3,4]', () => {
    expect(legalQuarters('ANNUAL')).toEqual([4]);
    expect(legalQuarters('INTERIM')).toEqual([2]);
    expect(legalQuarters('QUARTERLY')).toEqual([1, 3]);
    expect(legalQuarters('SPECIAL')).toEqual([1, 2, 3, 4]);
    expect(isValidQuarter('ANNUAL', 4)).toBe(true);
    expect(isValidQuarter('ANNUAL', 1)).toBe(false);
    expect(isValidQuarter('QUARTERLY', 3)).toBe(true);
    expect(isValidQuarter('QUARTERLY', 2)).toBe(false);
  });

  it('留存窗下界 = 当前年 − 年数 + 1；窗外判定为「早于下界」', () => {
    expect(retentionMinYear(2025, 5)).toBe(2021);
    expect(isOutsideRetention(2020, 2025, 5)).toBe(true);
    expect(isOutsideRetention(2021, 2025, 5)).toBe(false);
    // 年数可配（D-4）：3 年窗下界更晚
    expect(retentionMinYear(2025, 3)).toBe(2023);
    expect(isOutsideRetention(2022, 2025, 3)).toBe(true);
  });

  it('报告年上界 = 当前年 + 1', () => {
    expect(maxReportYear(2025)).toBe(2026);
  });
});
