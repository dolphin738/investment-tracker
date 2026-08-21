/**
 * SecurityType 收敛到 @/lib/types — 无回归验收（Q-3）
 *
 * 验证「shared as const 对象」与原 React 本地 enum 行为等价：
 * 1. @/api/types 的 re-export 与 shared 原始导出是同一对象引用
 * 2. 键值一一对应（9 项：含主数据扩展 UNCATEGORIZED；无 CASH），
 *    且键集合 === 值集合（无 enum 反向映射污染）
 * 3. 成员访问方式与旧 enum 写法兼容（SecurityType.STOCK === 'STOCK'）
 *
 * BugFix 说明：后端可合法下发 UNCATEGORIZED（代码无法可靠归类时的兜底值），
 * SecurityType const 已将其纳入镜像（与后端枚举对齐）；本测试随之更新为 9 项。
 * 主数据同步类别等需排除它的路径应显式过滤，而非依赖其在 const 中缺席。
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
      // BugFix：UNCATEGORIZED 为后端可合法下发的兜底值，已纳入 const 镜像
      UNCATEGORIZED: 'UNCATEGORIZED',
    });
    expect(Object.keys(SharedSecurityType)).toHaveLength(9);
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
    expect(SharedSecurityType.UNCATEGORIZED).toBe('UNCATEGORIZED');
  });
});
