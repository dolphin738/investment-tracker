/**
 * lib/__tests__/today-in-app-tz.test.ts — todayInAppTzIso() 时区鲁棒性单测
 *
 * 需求：顶栏展示「项目基准日期」= 北京时间（UTC+8）当天，
 * 口径必须与后端 `packages/backend/src/common/utils/app-date.util.ts`
 * 的 `todayInAppTz()` 完全一致：
 *
 *   const appNow = new Date(now.getTime() + 8 * 60 * 60 * 1000);
 *   return appNow.toISOString().split('T')[0];
 *
 * 核心不变式（Invariant）：
 *   **对同一物理时刻，无论浏览器本地时区是什么，返回值恒为该时刻对应的
 *   北京时间日历日。** 即结果只与 UTC 时间戳有关，与 getTimezoneOffset() 无关。
 *
 * 测试手法：
 * - vi.useFakeTimers() + vi.setSystemTime(instant) 固定"当前时刻"；
 * - spyOn(Date.prototype, 'getTimezoneOffset') 模拟不同本地时区
 *   （getTimezoneOffset 返回 UTC−本地 的分钟数：UTC−5 → +300，
 *     UTC+8 → −480，UTC+9 → −540，UTC+0 → 0）。
 * - 这样无需真的改 TZ 环境变量即可在单进程内覆盖多时区。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { todayInAppTzIso } from '@/lib/constants';

/** 常用时区的 getTimezoneOffset() 取值（分钟，UTC − 本地） */
const TZ_OFFSET = {
  'UTC-5': 300, // 美东（EST）
  UTC: 0,
  'UTC+8': -480, // 北京
  'UTC+9': -540, // 东京
  'UTC+14': -840, // 基里巴斯（地球最东时区，极端值）
  'UTC-11': 660, // 纽埃（地球最西时区，极端值）
} as const;

/**
 * 后端 todayInAppTz() 的等价参考实现（只取日期串部分）。
 * 用于「前后端口径一致」交叉校验，避免把后端 @nestjs/common 依赖引入 web 测试。
 */
function backendTodayInAppTzIso(nowMs: number): string {
  const appNow = new Date(nowMs + 8 * 60 * 60 * 1000);
  return appNow.toISOString().split('T')[0] as string;
}

/** 在指定"本地时区"下执行断言 */
function withTimezone<T>(offsetMinutes: number, fn: () => T): T {
  const spy = vi
    .spyOn(Date.prototype, 'getTimezoneOffset')
    .mockReturnValue(offsetMinutes);
  try {
    return fn();
  } finally {
    spy.mockRestore();
  }
}

describe('todayInAppTzIso() — 北京时间（UTC+8）基准日', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('格式为 YYYY-MM-DD', () => {
    vi.setSystemTime(new Date(Date.UTC(2026, 7, 5, 3, 0, 0)));
    expect(todayInAppTzIso()).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  describe('核心：同一时刻在任意本地时区下结果一致（北京时间当天）', () => {
    // 2026-08-05T23:00:00Z ＝ 北京时间 2026-08-06 07:00
    const instant = new Date(Date.UTC(2026, 7, 5, 23, 0, 0));
    const expected = '2026-08-06';

    it.each([
      ['UTC-5（美东，北京时间已跨到次日）', TZ_OFFSET['UTC-5']],
      ['UTC+0', TZ_OFFSET.UTC],
      ['UTC+8（北京本地，凌晨 0–8 点是历史 Bug 高发区）', TZ_OFFSET['UTC+8']],
      ['UTC+9（东京）', TZ_OFFSET['UTC+9']],
      ['UTC+14（极东）', TZ_OFFSET['UTC+14']],
      ['UTC-11（极西）', TZ_OFFSET['UTC-11']],
    ])('%s → %s', (_label, offset) => {
      vi.setSystemTime(instant);
      expect(withTimezone(offset, todayInAppTzIso)).toBe(expected);
    });

    it('所有时区返回值完全相同（不随 getTimezoneOffset 漂移）', () => {
      vi.setSystemTime(instant);
      const results = Object.values(TZ_OFFSET).map((offset) =>
        withTimezone(offset, todayInAppTzIso),
      );
      expect(new Set(results).size).toBe(1);
      expect(results[0]).toBe(expected);
    });
  });

  describe('跨午夜边界（北京时间 00:00 ＝ UTC 16:00）', () => {
    it.each([
      ['UTC 15:59:59 → 北京 2026-08-05 23:59:59', Date.UTC(2026, 7, 5, 15, 59, 59), '2026-08-05'],
      ['UTC 16:00:00 → 北京 2026-08-06 00:00:00（刚跨日）', Date.UTC(2026, 7, 5, 16, 0, 0), '2026-08-06'],
      ['UTC 16:00:01 → 北京 2026-08-06 00:00:01', Date.UTC(2026, 7, 5, 16, 0, 1), '2026-08-06'],
      ['UTC 23:00:00 → 北京 2026-08-06 07:00:00', Date.UTC(2026, 7, 5, 23, 0, 0), '2026-08-06'],
      ['UTC 00:00:00 → 北京 2026-08-06 08:00:00', Date.UTC(2026, 7, 6, 0, 0, 0), '2026-08-06'],
    ])('%s', (_label, ms, expected) => {
      vi.setSystemTime(new Date(ms));
      // 在三个代表性时区下都必须一致
      for (const offset of [TZ_OFFSET['UTC-5'], TZ_OFFSET['UTC+8'], TZ_OFFSET['UTC+9']]) {
        expect(withTimezone(offset, todayInAppTzIso)).toBe(expected);
      }
    });

    it('跨月：UTC 2026-07-31T16:00Z → 北京 2026-08-01', () => {
      vi.setSystemTime(new Date(Date.UTC(2026, 6, 31, 16, 0, 0)));
      expect(withTimezone(TZ_OFFSET['UTC+8'], todayInAppTzIso)).toBe('2026-08-01');
    });

    it('跨年：UTC 2025-12-31T16:00Z → 北京 2026-01-01', () => {
      vi.setSystemTime(new Date(Date.UTC(2025, 11, 31, 16, 0, 0)));
      expect(withTimezone(TZ_OFFSET['UTC-5'], todayInAppTzIso)).toBe('2026-01-01');
    });

    it('闰日：UTC 2028-02-28T16:00Z → 北京 2028-02-29', () => {
      vi.setSystemTime(new Date(Date.UTC(2028, 1, 28, 16, 0, 0)));
      expect(withTimezone(TZ_OFFSET['UTC+9'], todayInAppTzIso)).toBe('2028-02-29');
    });
  });

  describe('与后端 todayInAppTz() 口径交叉校验', () => {
    const instants = [
      Date.UTC(2026, 7, 5, 15, 59, 59),
      Date.UTC(2026, 7, 5, 16, 0, 0),
      Date.UTC(2026, 7, 5, 23, 0, 0),
      Date.UTC(2026, 7, 6, 0, 0, 0),
      Date.UTC(2026, 7, 6, 11, 30, 0),
      Date.UTC(2025, 11, 31, 16, 0, 0),
    ];

    it.each(instants)('时刻 %d：前端 === 后端参考实现（且不受本地时区影响）', (ms) => {
      vi.setSystemTime(new Date(ms));
      const expected = backendTodayInAppTzIso(ms);
      for (const offset of Object.values(TZ_OFFSET)) {
        expect(withTimezone(offset, todayInAppTzIso)).toBe(expected);
      }
    });
  });

  it('纯函数：同一时刻多次调用结果稳定', () => {
    vi.setSystemTime(new Date(Date.UTC(2026, 7, 5, 23, 0, 0)));
    withTimezone(TZ_OFFSET['UTC+8'], () => {
      expect(todayInAppTzIso()).toBe(todayInAppTzIso());
    });
  });

  // -------------------------------------------------------------------------
  // 回归：曾经的实现把「本地渲染补偿」与「UTC 渲染」混用 ——
  //   new Date(now + (8*60 + getTimezoneOffset()) * 60000).toISOString()
  // 位移量里多算了一个 getTimezoneOffset()，与 toISOString()（UTC 渲染）叠加
  // 产生净误差，导致整日漂移。以下两组用例精确锁死当年出问题的时段。
  // -------------------------------------------------------------------------
  describe('回归：跨午夜整日漂移（位移量与渲染方式必须配套）', () => {
    it('UTC+8 用户在北京 00:00–08:00 显示「当天」，而非「昨天」', () => {
      // 旧实现位移 = 8h + (-8h) = 0h → 直接取 UTC 日期，
      // 于是北京 00:00–08:00（UTC 前一日 16:00–24:00）整段显示昨天。
      // 这正是后端 app-date.util.ts 注释明确警告的坑。
      const beijingMidnightUtc = Date.UTC(2026, 7, 5, 16, 0, 0); // 京 2026-08-06 00:00
      const hours = [0, 1, 3, 5, 7, 7.9833]; // 覆盖 00:00 ~ 07:59
      for (const h of hours) {
        vi.setSystemTime(new Date(beijingMidnightUtc + h * 3600 * 1000));
        expect(
          withTimezone(TZ_OFFSET['UTC+8'], todayInAppTzIso),
          `北京时间 08-06 ${String(Math.floor(h)).padStart(2, '0')}:xx 应显示当天`,
        ).toBe('2026-08-06');
      }
    });

    it('UTC-5 用户在当地 06:00–11:00 显示「今天」，而非「明天」', () => {
      // 旧实现位移 = 8h + 5h = 13h，比正确的 8h 多 5h，
      // 于是 UTC 11:00–16:00（美东当地 06:00–11:00）整段提前跨日显示明天。
      const day = Date.UTC(2026, 7, 6, 0, 0, 0);
      for (const localHour of [6, 7, 8, 9, 10, 10.9833]) {
        vi.setSystemTime(new Date(day + (localHour + 5) * 3600 * 1000));
        expect(
          withTimezone(TZ_OFFSET['UTC-5'], todayInAppTzIso),
          `美东当地 08-06 ${String(Math.floor(localHour)).padStart(2, '0')}:xx 应显示今天`,
        ).toBe('2026-08-06');
      }
    });

    it('不变式：结果只由 UTC 时间戳决定，与 getTimezoneOffset() 完全无关', () => {
      // 最锋利的判据：任何本地时区扰动都不得改变输出。
      // 若有人再次把 getTimezoneOffset() 引入位移量，此用例立刻变红。
      const instants = [
        Date.UTC(2026, 7, 5, 15, 59, 59),
        Date.UTC(2026, 7, 5, 16, 0, 0),
        Date.UTC(2026, 7, 6, 11, 0, 0),
        Date.UTC(2026, 7, 6, 15, 59, 59),
        Date.UTC(2026, 7, 6, 16, 0, 0),
      ];
      for (const ms of instants) {
        vi.setSystemTime(new Date(ms));
        const expected = backendTodayInAppTzIso(ms);
        // 遍历全球所有整点/半点偏移（UTC-12 ~ UTC+14）
        for (let offset = 720; offset >= -840; offset -= 30) {
          expect(
            withTimezone(offset, todayInAppTzIso),
            `offset=${offset} 时结果发生漂移`,
          ).toBe(expected);
        }
      }
    });
  });
});
