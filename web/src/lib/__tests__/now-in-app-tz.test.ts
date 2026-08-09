/**
 * lib/__tests__/now-in-app-tz.test.ts — nowInAppTzIso() 时区鲁棒性单测
 *
 * 需求：顶栏实时时钟展示「项目基准日期时间」= 北京时间（UTC+8）的
 * YYYY-MM-DD HH:mm:ss，口径必须与 todayInAppTzIso() 同一不变式：
 *
 *   const appNow = new Date(Date.now() + 8 * 60 * 60 * 1000);
 *   const s = appNow.toISOString();
 *   return `${s.slice(0, 10)} ${s.slice(11, 19)}`;
 *
 * 核心不变式（Invariant）：
 *   **对同一物理时刻，无论浏览器本地时区是什么，返回值恒为该时刻对应的
 *   北京时间（日期 + 时间）。** 即结果只与 UTC 时间戳有关，与
 *   getTimezoneOffset() 无关。位移 +8h 仅配 toISOString()（UTC 渲染），
 *   绝不混入 getTimezoneOffset()。
 *
 * 测试手法同 today-in-app-tz.test.ts：
 * - vi.useFakeTimers() + vi.setSystemTime(instant) 固定"当前时刻"；
 * - spyOn(Date.prototype, 'getTimezoneOffset') 模拟不同本地时区。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { nowInAppTzIso } from '@/lib/constants';

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
 * 后端 todayInAppTz() 的等价参考实现（日期 + 时间串）。
 * 用于「前后端口径一致」交叉校验，避免把后端 @nestjs/common 依赖引入 web 测试。
 */
function backendNowInAppTzIso(nowMs: number): string {
  const appNow = new Date(nowMs + 8 * 60 * 60 * 1000);
  const s = appNow.toISOString();
  return `${s.slice(0, 10)} ${s.slice(11, 19)}`;
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

describe('nowInAppTzIso() — 北京时间（UTC+8）基准日期时间', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('格式为 YYYY-MM-DD HH:mm:ss', () => {
    vi.setSystemTime(new Date(Date.UTC(2026, 7, 5, 3, 0, 0)));
    const result = nowInAppTzIso();
    expect(result).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  });

  it('日期部分与 todayInAppTzIso() 口径一致', () => {
    vi.setSystemTime(new Date(Date.UTC(2026, 7, 5, 23, 0, 0))); // 京 2026-08-06 07:00
    expect(nowInAppTzIso().slice(0, 10)).toBe('2026-08-06');
  });

  describe('核心：同一时刻在任意本地时区下结果一致（北京时间当天 + 时间）', () => {
    // 2026-08-05T23:00:00Z ＝ 北京时间 2026-08-06 07:00:00
    const instant = new Date(Date.UTC(2026, 7, 5, 23, 0, 0));
    const expected = '2026-08-06 07:00:00';

    it.each([
      ['UTC-5（美东）', TZ_OFFSET['UTC-5']],
      ['UTC+0', TZ_OFFSET.UTC],
      ['UTC+8（北京本地）', TZ_OFFSET['UTC+8']],
      ['UTC+9（东京）', TZ_OFFSET['UTC+9']],
      ['UTC+14（极东）', TZ_OFFSET['UTC+14']],
      ['UTC-11（极西）', TZ_OFFSET['UTC-11']],
    ])('%s → %s', (_label, offset) => {
      vi.setSystemTime(instant);
      expect(withTimezone(offset, nowInAppTzIso)).toBe(expected);
    });

    it('所有时区返回值完全相同（不随 getTimezoneOffset 漂移）', () => {
      vi.setSystemTime(instant);
      const results = Object.values(TZ_OFFSET).map((offset) =>
        withTimezone(offset, nowInAppTzIso),
      );
      expect(new Set(results).size).toBe(1);
      expect(results[0]).toBe(expected);
    });
  });

  describe('跨午夜边界（北京时间 00:00 ＝ UTC 16:00）', () => {
    it.each([
      ['UTC 15:59:59 → 北京 2026-08-05 23:59:59', Date.UTC(2026, 7, 5, 15, 59, 59), '2026-08-05 23:59:59'],
      ['UTC 16:00:00 → 北京 2026-08-06 00:00:00（刚跨日）', Date.UTC(2026, 7, 5, 16, 0, 0), '2026-08-06 00:00:00'],
      ['UTC 16:00:01 → 北京 2026-08-06 00:00:01', Date.UTC(2026, 7, 5, 16, 0, 1), '2026-08-06 00:00:01'],
      ['UTC 23:00:00 → 北京 2026-08-06 07:00:00', Date.UTC(2026, 7, 5, 23, 0, 0), '2026-08-06 07:00:00'],
      ['UTC 00:00:00 → 北京 2026-08-06 08:00:00', Date.UTC(2026, 7, 6, 0, 0, 0), '2026-08-06 08:00:00'],
    ])('%s', (_label, ms, expected) => {
      vi.setSystemTime(new Date(ms));
      for (const offset of [TZ_OFFSET['UTC-5'], TZ_OFFSET['UTC+8'], TZ_OFFSET['UTC+9']]) {
        expect(withTimezone(offset, nowInAppTzIso)).toBe(expected);
      }
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
      const expected = backendNowInAppTzIso(ms);
      for (const offset of Object.values(TZ_OFFSET)) {
        expect(withTimezone(offset, nowInAppTzIso)).toBe(expected);
      }
    });
  });

  it('不变式：结果只由 UTC 时间戳决定，与 getTimezoneOffset() 完全无关', () => {
    const instants = [
      Date.UTC(2026, 7, 5, 15, 59, 59),
      Date.UTC(2026, 7, 5, 16, 0, 0),
      Date.UTC(2026, 7, 6, 11, 0, 0),
      Date.UTC(2026, 7, 6, 15, 59, 59),
      Date.UTC(2026, 7, 6, 16, 0, 0),
    ];
    for (const ms of instants) {
      vi.setSystemTime(new Date(ms));
      const expected = backendNowInAppTzIso(ms);
      for (let offset = 720; offset >= -840; offset -= 30) {
        expect(
          withTimezone(offset, nowInAppTzIso),
          `offset=${offset} 时结果发生漂移`,
        ).toBe(expected);
      }
    }
  });
});
