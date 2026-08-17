/**
 * modules/overview/features/asset-metrics.ts — 概览页 8 指标构造口径单测（移植自 React 版）
 *
 * 覆盖：
 * 1. 🔴 `formatAmountOrEmpty` 对 `0` / `'0'` 的保护 —— 必须格式化为 ¥0.00
 * 2. `null` / `undefined` / `''` → 「暂无数据」
 * 3. 8 项的顺序、key、title、group 分组
 * 4. 「当前总资产」全表只出现 1 次（融合去重核心）
 * 5. trend 方向口径（收益率 ≥0 up / 净值 ≥1 up / 金额恒 neutral）
 * 6. 千分位 / 小数位偏好透传
 */

import { describe, expect, it } from 'vitest';
import {
  buildOverviewMetrics,
  EMPTY_AMOUNT_TEXT,
  formatAmountOrEmpty,
  type BuildOverviewMetricsInput,
  type OverviewMetric,
} from '@/modules/overview/features/asset-metrics';

function pick(metrics: OverviewMetric[], key: string): OverviewMetric {
  const m = metrics.find((x) => x.key === key);
  if (!m) throw new Error(`未找到指标 ${key}`);
  return m;
}

const FULL_INPUT: BuildOverviewMetricsInput = {
  totalAsset: '123456.78',
  latestDate: '2026-06-15',
  latestSource: 'DERIVED',
  marketValue: '100000.00',
  cashBalance: '23456.78',
  cashAsOf: '2026-06-01',
  netInvested: '100000.00',
  totalReturnRate: '0.23450000',
  yearReturnRate: '0.05000000',
  xirr: '0.0821',
  cumulativeNav: '1.234500',
  yearNav: '1.050000',
  format: { thousands: true, abbreviate: false },
  navDecimals: 4,
  xirrDecimals: 2,
};

describe('formatAmountOrEmpty — 空值保护（fusion 分支修复回归）', () => {
  it('数字 0 是合法金额，必须格式化为 ¥0.00 而非「暂无数据」', () => {
    expect(formatAmountOrEmpty(0)).toBe('¥0.00');
    expect(formatAmountOrEmpty(0)).not.toBe(EMPTY_AMOUNT_TEXT);
  });

  it('字符串 "0" / "0.00" 同样是合法金额', () => {
    expect(formatAmountOrEmpty('0')).toBe('¥0.00');
    expect(formatAmountOrEmpty('0.00')).toBe('¥0.00');
  });

  it('null / undefined / 空串 → 占位文案', () => {
    expect(formatAmountOrEmpty(null)).toBe(EMPTY_AMOUNT_TEXT);
    expect(formatAmountOrEmpty(undefined)).toBe(EMPTY_AMOUNT_TEXT);
    expect(formatAmountOrEmpty('')).toBe(EMPTY_AMOUNT_TEXT);
  });

  it('负数照常格式化', () => {
    expect(formatAmountOrEmpty(-1234.5, { thousands: false })).toBe('¥-1234.50');
  });

  it('千分位 / 缩写偏好透传给 formatCurrency', () => {
    expect(formatAmountOrEmpty(1234567.89, { thousands: true })).toBe(
      '¥1,234,567.89',
    );
    expect(formatAmountOrEmpty(1234567.89, { thousands: false })).toBe(
      '¥1234567.89',
    );
    expect(formatAmountOrEmpty(1234567.89, { abbreviate: true })).toBe('¥123.46万');
  });
});

describe('buildOverviewMetrics — 结构与顺序', () => {
  it('固定产出 8 项，顺序为「资产构成 4 + 收益表现 4」', () => {
    const metrics = buildOverviewMetrics(FULL_INPUT);
    expect(metrics).toHaveLength(8);
    expect(metrics.map((m) => m.key)).toEqual([
      'total-asset',
      'market-value',
      'cash-balance',
      'net-invested',
      'total-return-rate',
      'year-return-rate',
      'xirr',
      'cumulative-nav',
    ]);
    expect(metrics.slice(0, 4).every((m) => m.group === 'asset')).toBe(true);
    expect(metrics.slice(4).every((m) => m.group === 'return')).toBe(true);
  });

  it('标题与设计稿一致，且「当前总资产」只出现 1 次（去重核心）', () => {
    const titles = buildOverviewMetrics(FULL_INPUT).map((m) => m.title);
    expect(titles).toEqual([
      '当前总资产',
      '持仓市值',
      '现金余额',
      '净投入',
      '累计收益率',
      '当年收益率',
      '年化 XIRR',
      '累计净值',
    ]);
    expect(titles.filter((t) => t === '当前总资产')).toHaveLength(1);
  });

  it('key 唯一（可直接用作渲染 key）', () => {
    const keys = buildOverviewMetrics(FULL_INPUT).map((m) => m.key);
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe('buildOverviewMetrics — 数值与空态', () => {
  it('完整入参 → 金额/比率/净值均按偏好格式化', () => {
    const metrics = buildOverviewMetrics(FULL_INPUT);
    expect(pick(metrics, 'total-asset').value).toBe('¥123,456.78');
    expect(pick(metrics, 'market-value').value).toBe('¥100,000.00');
    expect(pick(metrics, 'cash-balance').value).toBe('¥23,456.78');
    expect(pick(metrics, 'net-invested').value).toBe('¥100,000.00');
    expect(pick(metrics, 'total-return-rate').value).toBe('23.45%');
    expect(pick(metrics, 'year-return-rate').value).toBe('5.00%');
    expect(pick(metrics, 'xirr').value).toBe('8.21%');
    expect(pick(metrics, 'cumulative-nav').value).toBe('1.2345');
  });

  it('金额为 0 的三张卡（总资产/现金/净投入）显示 ¥0.00', () => {
    const metrics = buildOverviewMetrics({
      totalAsset: 0,
      cashBalance: '0',
      netInvested: 0,
    });
    expect(pick(metrics, 'total-asset').value).toBe('¥0.00');
    expect(pick(metrics, 'cash-balance').value).toBe('¥0.00');
    expect(pick(metrics, 'net-invested').value).toBe('¥0.00');
  });

  it('空入参 → 金额类全部「暂无数据」，比率类回落 "-"', () => {
    const metrics = buildOverviewMetrics({});
    expect(pick(metrics, 'total-asset').value).toBe(EMPTY_AMOUNT_TEXT);
    expect(pick(metrics, 'market-value').value).toBe(EMPTY_AMOUNT_TEXT);
    expect(pick(metrics, 'cash-balance').value).toBe(EMPTY_AMOUNT_TEXT);
    expect(pick(metrics, 'net-invested').value).toBe(EMPTY_AMOUNT_TEXT);
    expect(pick(metrics, 'cumulative-nav').value).toBe(EMPTY_AMOUNT_TEXT);
    expect(pick(metrics, 'total-return-rate').value).toBe('-');
    expect(pick(metrics, 'year-return-rate').value).toBe('-');
    expect(pick(metrics, 'xirr').value).toBe('-');
  });

  it('小数位偏好生效（navDecimals / xirrDecimals）', () => {
    const metrics = buildOverviewMetrics({
      ...FULL_INPUT,
      navDecimals: 6,
      xirrDecimals: 4,
    });
    expect(pick(metrics, 'cumulative-nav').value).toBe('1.234500');
    expect(pick(metrics, 'xirr').value).toBe('8.2100%');
    expect(pick(metrics, 'total-return-rate').description).toBe('净值 1.234500');
  });
});

describe('buildOverviewMetrics — 描述文案', () => {
  it('总资产：有截止日 → 「截至 X」；无 → 「数据截止日未知」', () => {
    expect(
      pick(buildOverviewMetrics({ latestDate: '2026-06-15' }), 'total-asset')
        .description,
    ).toBe('截至 2026-06-15');
    expect(pick(buildOverviewMetrics({}), 'total-asset').description).toBe(
      '数据截止日未知',
    );
  });

  it('总资产：最新快照为手工录入 → 描述追加「· 手工」（Q-2 乙）', () => {
    const metrics = buildOverviewMetrics({
      latestDate: '2026-06-15',
      latestSource: 'MANUAL',
    });
    expect(pick(metrics, 'total-asset').description).toBe('截至 2026-06-15 · 手工');
  });

  it('现金余额：有生效日 → 「生效日 X」；未维护 → 引导文案', () => {
    expect(
      pick(buildOverviewMetrics({ cashAsOf: '2026-06-01' }), 'cash-balance')
        .description,
    ).toBe('生效日 2026-06-01');
    expect(pick(buildOverviewMetrics({}), 'cash-balance').description).toContain(
      '未维护',
    );
  });

  it('固定口径说明文案', () => {
    const metrics = buildOverviewMetrics(FULL_INPUT);
    expect(pick(metrics, 'market-value').description).toBe('由买卖流水推导');
    expect(pick(metrics, 'net-invested').description).toBe('存入 - 取出');
    expect(pick(metrics, 'xirr').description).toBe('累计年化');
    expect(pick(metrics, 'cumulative-nav').description).toBe('单位净值');
  });

  it('收益率卡描述展示对应净值；净值缺失时占位', () => {
    const metrics = buildOverviewMetrics(FULL_INPUT);
    expect(pick(metrics, 'total-return-rate').description).toBe('净值 1.2345');
    expect(pick(metrics, 'year-return-rate').description).toBe('净值 1.0500');
    const empty = buildOverviewMetrics({});
    expect(pick(empty, 'total-return-rate').description).toBe(EMPTY_AMOUNT_TEXT);
    expect(pick(empty, 'year-return-rate').description).toBe(EMPTY_AMOUNT_TEXT);
  });
});

describe('buildOverviewMetrics — trend 方向', () => {
  it('金额类恒 neutral', () => {
    const metrics = buildOverviewMetrics(FULL_INPUT);
    for (const key of [
      'total-asset',
      'market-value',
      'cash-balance',
      'net-invested',
    ]) {
      expect(pick(metrics, key).trend).toBe('neutral');
    }
  });

  it('收益率 / XIRR：≥0 → up，<0 → down，空 → neutral', () => {
    const up = buildOverviewMetrics({
      totalReturnRate: '0',
      yearReturnRate: '0.01',
      xirr: '0.5',
    });
    expect(pick(up, 'total-return-rate').trend).toBe('up');
    expect(pick(up, 'year-return-rate').trend).toBe('up');
    expect(pick(up, 'xirr').trend).toBe('up');

    const down = buildOverviewMetrics({
      totalReturnRate: '-0.01',
      yearReturnRate: -0.2,
      xirr: '-0.0001',
    });
    expect(pick(down, 'total-return-rate').trend).toBe('down');
    expect(pick(down, 'year-return-rate').trend).toBe('down');
    expect(pick(down, 'xirr').trend).toBe('down');

    const none = buildOverviewMetrics({});
    expect(pick(none, 'total-return-rate').trend).toBe('neutral');
    expect(pick(none, 'xirr').trend).toBe('neutral');
  });

  it('累计净值：≥1 → up，<1 → down，空 → neutral', () => {
    expect(
      pick(buildOverviewMetrics({ cumulativeNav: '1' }), 'cumulative-nav').trend,
    ).toBe('up');
    expect(
      pick(buildOverviewMetrics({ cumulativeNav: '0.98' }), 'cumulative-nav')
        .trend,
    ).toBe('down');
    expect(pick(buildOverviewMetrics({}), 'cumulative-nav').trend).toBe('neutral');
  });

  it('非法数值（NaN 字符串）不崩溃，回落 neutral', () => {
    const metrics = buildOverviewMetrics({
      totalReturnRate: 'abc',
      cumulativeNav: 'abc',
    });
    expect(pick(metrics, 'total-return-rate').trend).toBe('neutral');
    expect(pick(metrics, 'cumulative-nav').trend).toBe('neutral');
  });
});
