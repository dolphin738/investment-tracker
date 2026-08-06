/**
 * shared 金额工具单测（增量设计 T01 验收 / C-8 / K-3）
 *
 * 补齐设计验收要求但此前缺失的直接单测：
 * - isMoneyString('0.00') = true；格式/负数/超精度拒绝
 * - computeNetAmount('1500','300') = '1200.00'（整数分运算）
 * - sumMoney(['45.00','0','5']) = '50.00'（无浮点毛刺）
 *
 * 直接从 @investment-tracker/shared 导入纯函数，不依赖任何组件。
 */
import { describe, expect, it } from 'vitest';
import {
  computeNetAmount,
  isMoneyString,
  sumMoney,
} from '@investment-tracker/shared';

describe('shared MoneyUtils（整数分运算，C-8）', () => {
  describe('isMoneyString', () => {
    it.each(['0', '0.00', '45', '45.00', '1500', '1500.45', '0.1', '0.30'])(
      '合法金额通过：%s',
      (v) => {
        expect(isMoneyString(v)).toBe(true);
      },
    );

    it.each(['', ' ', '.', '1.234', '-1', '-0.00', 'abc', '1,000'])(
      '非法金额拒绝：%s',
      (v) => {
        expect(isMoneyString(v)).toBe(false);
      },
    );

    it('allowZero:false 时 0 被拒，> 0 通过', () => {
      expect(isMoneyString('0.00', { allowZero: false })).toBe(false);
      expect(isMoneyString('0', { allowZero: false })).toBe(false);
      expect(isMoneyString('0.01', { allowZero: false })).toBe(true);
    });

    it('非字符串输入返回 false', () => {
      expect(isMoneyString(45 as unknown as string)).toBe(false);
      expect(isMoneyString(undefined as unknown as string)).toBe(false);
      expect(isMoneyString(null as unknown as string)).toBe(false);
    });
  });

  describe('computeNetAmount（净额 = 税前 − 税）', () => {
    it('设计验收示例：1500 − 300 = 1200.00', () => {
      expect(computeNetAmount('1500', '300')).toBe('1200.00');
    });

    it('税缺省按 0：1500 − 0 = 1500.00', () => {
      expect(computeNetAmount('1500', '0')).toBe('1500.00');
    });

    it('恒 2 位小数：0.30 − 0.20 = 0.10（无浮点毛刺）', () => {
      expect(computeNetAmount('0.30', '0.20')).toBe('0.10');
      expect(computeNetAmount('0.30', '0.20')).not.toContain('0000');
    });

    it('整数分运算大额无丢精：9999999999999999.99 − 0.01 = 9999999999999999.98', () => {
      expect(computeNetAmount('9999999999999999.99', '0.01')).toBe(
        '9999999999999999.98',
      );
    });

    it('净额为负也返回负值字符串（是否拒绝由调用方把关）', () => {
      expect(computeNetAmount('100', '150')).toBe('-50.00');
    });
  });

  describe('sumMoney（费用/金额求和）', () => {
    it('设计验收示例：45 + 0 + 5 = 50.00', () => {
      expect(sumMoney(['45.00', '0', '5'])).toBe('50.00');
    });

    it('0.10 + 0.20 = 0.30（无 0.30000000000000004 毛刺）', () => {
      expect(sumMoney(['0.10', '0.20'])).toBe('0.30');
    });

    it('数字入参同样支持：45 + 5 = 50.00', () => {
      expect(sumMoney([45, 5])).toBe('50.00');
    });

    it('空列表 = 0.00', () => {
      expect(sumMoney([])).toBe('0.00');
    });

    it('多笔相加：45 + 5 + 2 + 0.01 = 52.01', () => {
      expect(sumMoney(['45', '5', '2', '0.01'])).toBe('52.01');
    });
  });
});
