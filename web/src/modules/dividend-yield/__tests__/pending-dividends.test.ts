/**
 * modules/dividend-yield/__tests__/pending-dividends.test.ts
 * — lib/pending-dividends.ts 纯函数单测（§4 收口：建议值格式三处统一）
 *
 * 守护 `formatSuggestionPreview`：Table 报告期列 / AssignDialog 候选区 / BatchDialog
 * 批量预览三处共用该函数（owner 裁决以批量预览口径「600519 2022Q4 特别分配」为准）。
 * 若有人绕开它手拼格式，此用例至少锁住函数自身的契约。
 */
import { describe, expect, it } from 'vitest';
import { formatSuggestionPreview } from '../lib/pending-dividends';
import type { PeriodCandidate } from '../lib/suggest-report-period';

function candidate(
  over: Partial<PeriodCandidate> = {},
): PeriodCandidate {
  return {
    reportYear: 2022,
    reportQuarter: 4,
    periodType: 'SPECIAL',
    approximate: false,
    ...over,
  };
}

describe('formatSuggestionPreview（建议值统一格式 §4）', () => {
  it('基础格式：code 年Q季 类型标签（600519 2022Q4 特别分配）', () => {
    expect(formatSuggestionPreview('600519', candidate())).toBe(
      '600519 2022Q4 特别分配',
    );
  });

  it('code 缺失回落「未知代码」；空串/空白同径（不出现 undefined/NaN）', () => {
    expect(formatSuggestionPreview(null, candidate())).toContain('未知代码');
    expect(formatSuggestionPreview('  ', candidate())).toContain('未知代码');
    expect(formatSuggestionPreview('', candidate())).toMatch(/^未知代码 2022Q4/);
  });

  it('approximate=true（除权日推定备选）追加粗略后缀；false 不带', () => {
    expect(formatSuggestionPreview('600900', candidate({ approximate: true }))).toBe(
      '600900 2022Q4 特别分配（除权日推定，粗略）',
    );
    expect(
      formatSuggestionPreview('600900', candidate({ approximate: false })),
    ).not.toContain('粗略');
  });

  it('类型标签映射：ANNUAL → 年度（年报）；未知类型兜底「其他」', () => {
    expect(
      formatSuggestionPreview('600519', candidate({ periodType: 'ANNUAL' })),
    ).toBe('600519 2022Q4 年度（年报）');
    const rogue = candidate({ periodType: 'NOPE' as never });
    expect(formatSuggestionPreview('600519', rogue)).toContain('其他');
  });
});
