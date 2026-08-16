/**
 * features/holdings/trade-security-filter.ts — 买卖明细标的过滤派生（缺陷4 二次修复）
 *
 * 回归重点：**空结果不得退化成「不过滤」**。
 * 旧实现把「无约束 / 字典未就绪 / 筛选无命中」三种语义都压成空数组，
 * 调用方据此省略 securityId，后端返回全量交易 —— 表现为「类型筛选器无效」。
 */

import { describe, expect, it } from 'vitest';
import { SecurityType } from '@/lib/types';
import type { Security } from '@/api/types';
import { deriveTradeSecurityFilter } from '@/features/holdings/trade-security-filter';

function makeSecurity(id: string, type: SecurityType): Security {
  return {
    id,
    portfolioId: 'pf-1',
    code: id.toUpperCase(),
    name: `标的-${id}`,
    type,
    note: null,
    createdAt: '2025-01-01T00:00:00.000Z',
    updatedAt: '2025-01-01T00:00:00.000Z',
  };
}

const SECURITIES: Security[] = [
  makeSecurity('s-stock-1', SecurityType.STOCK),
  makeSecurity('s-stock-2', SecurityType.STOCK),
  makeSecurity('s-fund-1', SecurityType.ON_EXCHANGE_FUND),
];

describe('deriveTradeSecurityFilter · 三态语义', () => {
  it('未选类型且未选证券 → ready + 空 ids（语义为「不施加标的约束」）', () => {
    const r = deriveTradeSecurityFilter({
      types: [],
      sec: [],
      securities: SECURITIES,
      securitiesLoading: false,
    });
    expect(r.state).toBe('ready');
    expect(r.ids).toEqual([]);
  });

  it('未选类型但选了证券 → ready + 原样透传 sec', () => {
    const r = deriveTradeSecurityFilter({
      types: [],
      sec: ['s-fund-1'],
      securities: SECURITIES,
      securitiesLoading: false,
    });
    expect(r.state).toBe('ready');
    expect(r.ids).toEqual(['s-fund-1']);
  });

  it('仅选类型 → ready + 该类型下全部证券 ID', () => {
    const r = deriveTradeSecurityFilter({
      types: [SecurityType.STOCK],
      sec: [],
      securities: SECURITIES,
      securitiesLoading: false,
    });
    expect(r.state).toBe('ready');
    expect([...r.ids].sort()).toEqual(['s-stock-1', 's-stock-2']);
  });

  it('类型 + 证券同选 → ready + 交集', () => {
    const r = deriveTradeSecurityFilter({
      types: [SecurityType.STOCK],
      sec: ['s-stock-2', 's-fund-1'],
      securities: SECURITIES,
      securitiesLoading: false,
    });
    expect(r.state).toBe('ready');
    expect(r.ids).toEqual(['s-stock-2']);
  });

  it('🔴 选中的类型下没有任何证券 → empty（不得退化成 ready+空数组）', () => {
    const r = deriveTradeSecurityFilter({
      types: [SecurityType.BOND],
      sec: [],
      securities: SECURITIES,
      securitiesLoading: false,
    });
    expect(r.state).toBe('empty');
    expect(r.ids).toEqual([]);
  });

  it('🔴 类型与证券交集为空 → empty（不得退化成 ready+空数组）', () => {
    const r = deriveTradeSecurityFilter({
      types: [SecurityType.ON_EXCHANGE_FUND],
      sec: ['s-stock-1'],
      securities: SECURITIES,
      securitiesLoading: false,
    });
    expect(r.state).toBe('empty');
    expect(r.ids).toEqual([]);
  });

  it('🔴 选了类型但标的字典仍在加载 → loading（不得先闪一屏全量数据）', () => {
    const r = deriveTradeSecurityFilter({
      types: [SecurityType.STOCK],
      sec: [],
      securities: [],
      securitiesLoading: true,
    });
    expect(r.state).toBe('loading');
    expect(r.ids).toEqual([]);
  });

  it('未选类型时即使字典在加载也不阻塞（纯证券多选无需字典）', () => {
    const r = deriveTradeSecurityFilter({
      types: [],
      sec: ['s-stock-1'],
      securities: [],
      securitiesLoading: true,
    });
    expect(r.state).toBe('ready');
    expect(r.ids).toEqual(['s-stock-1']);
  });

  it('字典加载完成却为空（拉取失败/组合无标的）→ empty，而非放行全量', () => {
    const r = deriveTradeSecurityFilter({
      types: [SecurityType.STOCK],
      sec: [],
      securities: [],
      securitiesLoading: false,
    });
    expect(r.state).toBe('empty');
  });

  it('多类型多选 → 并集去重', () => {
    const r = deriveTradeSecurityFilter({
      types: [SecurityType.STOCK, SecurityType.ON_EXCHANGE_FUND],
      sec: [],
      securities: SECURITIES,
      securitiesLoading: false,
    });
    expect(r.state).toBe('ready');
    expect([...r.ids].sort()).toEqual(['s-fund-1', 's-stock-1', 's-stock-2']);
  });

  it('不修改入参数组（sec 原样透传时返回副本）', () => {
    const sec = ['s-stock-1'];
    const r = deriveTradeSecurityFilter({
      types: [],
      sec,
      securities: SECURITIES,
      securitiesLoading: false,
    });
    expect(r.ids).not.toBe(sec);
    expect(r.ids).toEqual(sec);
  });
});
