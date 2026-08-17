/**
 * SecurityType 收敛到 @/lib/types — 无回归验收（Q-3）
 *
 * 验证「shared as const 对象」与原 React 本地 enum 行为等价：
 * 1. @/api/types 的 re-export 与 shared 原始导出是同一对象引用
 * 2. 键值一一对应（8 项，无 CASH），且键集合 === 值集合（无 enum 反向映射污染）
 * 3. 成员访问方式与旧 enum 写法兼容（SecurityType.STOCK === 'STOCK'）
 *
 * 平移自 React 版 web/src/features/security-trade/__tests__/security-type-shared.test.tsx
 * （UI 部分：表单 resolve 不携带 type 已在 security-trade-form.test.ts 提交链路覆盖）
 */

import { describe, expect, it } from 'vitest';
import { SecurityType as SharedSecurityType } from '@/lib/types';
import { SecurityType as ReExportedSecurityType } from '@/api/types';

describe('SecurityType 单一定义（shared as const）', () => {
  it('@/api/types 的 re-export 与 shared 原始导出是同一对象引用', () => {
    expect(ReExportedSecurityType).toBe(SharedSecurityType);
  });

  it('类型键值一一对应（含主数据扩展；无 CASH）', () => {
    expect(SharedSecurityType).toEqual({
      STOCK: 'STOCK',
      ON_EXCHANGE_FUND: 'ON_EXCHANGE_FUND',
      BOND: 'BOND',
      OTHER: 'OTHER',
      HK_STOCK: 'HK_STOCK',
      CONVERTIBLE_BOND: 'CONVERTIBLE_BOND',
      INDEX: 'INDEX',
      OFF_EXCHANGE_FUND: 'OFF_EXCHANGE_FUND',
    });
    expect(Object.keys(SharedSecurityType)).toHaveLength(8);
  });

  it('无 enum 反向映射污染（键集合 === 值集合）', () => {
    const keys = Object.keys(SharedSecurityType).sort();
    const values = Object.values(SharedSecurityType).sort();
    expect(keys).toEqual(values);
  });

  it('成员访问方式与旧 enum 写法保持兼容（SecurityType.STOCK === "STOCK"）', () => {
    expect(SharedSecurityType.STOCK).toBe('STOCK');
    expect(SharedSecurityType.ON_EXCHANGE_FUND).toBe('ON_EXCHANGE_FUND');
    expect(SharedSecurityType.BOND).toBe('BOND');
    expect(SharedSecurityType.OTHER).toBe('OTHER');
    expect(SharedSecurityType.OFF_EXCHANGE_FUND).toBe('OFF_EXCHANGE_FUND');
  });
});
