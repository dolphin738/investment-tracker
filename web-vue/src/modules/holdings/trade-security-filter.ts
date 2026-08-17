/**
 * modules/holdings/trade-security-filter.ts — 统一筛选器 →「买卖明细」标的过滤派生
 *
 * 平移自 React 版 web/src/features/holdings/trade-security-filter.ts。
 *
 * 背景（缺陷4 二次修复）：买卖明细接口只认 `securityId`（逗号分隔，后端 `IN` 过滤），
 * 不认 `type`。所以持仓页顶部的「类型多选」必须先在前端映射成证券 ID 集合再下发。
 *
 * 上一版把结果压成单一 `string[]`，三种语义共用空数组：
 *   ① 未施加标的约束（查全部）② 标的字典未就绪（应等待）③ 明确无匹配（应查不到）
 * 调用方见空数组就省略 `securityId`，②③ 全部退化为 ①，后端返回全量买卖记录，
 * 表现为「类型筛选器切到买卖明细 Tab 不生效」。本模块用 `state` 显式区分三态。
 */

import type { Security } from '@/api/types';
import type { SecurityType } from '@/lib/types';

/**
 * 「买卖明细」板块的标的过滤三态。
 *
 * React 版定义在 features/security-trade/security-trade-list.tsx 并由本模块
 * re-export；Vue 版 security-trade 模块已迁移（modules/security-trade），此处的
 * 同名契约保留在本模块内以维持 holdings ↔ security-trade 的耦合内聚。
 * 三态字面量联合须与 security-trade 侧保持一致。
 */
export type TradeFilterState = 'ready' | 'loading' | 'empty';

/** 派生结果：状态 + 有效证券 ID 列表 */
export interface TradeSecurityFilter {
  /**
   * - `ready`：条件已确定，按 `ids` 查询（`ids` 为空 = 不施加标的约束）
   * - `loading`：标的字典未就绪，调用方应挂起查询
   * - `empty`：条件已确定且无任何命中，调用方应直接呈现空结果
   */
  state: TradeFilterState;
  /** 有效证券 ID（仅 `state === 'ready'` 时有意义） */
  ids: string[];
}

/** 派生入参 */
export interface DeriveTradeSecurityFilterInput {
  /** 类型多选（空 = 不按类型过滤） */
  types: readonly SecurityType[];
  /** 证券多选（空 = 不按证券过滤） */
  sec: readonly string[];
  /** 标的字典（useSecurities 解包后的数组） */
  securities: readonly Security[];
  /** 标的字典是否仍在加载 */
  securitiesLoading: boolean;
}

/**
 * 由「类型多选 + 证券多选」派生买卖明细的标的过滤条件。
 *
 * 规则：
 * - 未选类型 → 退回纯证券多选语义（`sec` 原样透传，空数组表示不约束）
 * - 选了类型但字典未就绪 → `loading`（绝不按「无约束」放行）
 * - 选了类型：取该类型下全部证券；若同时选了证券则取交集
 * - 上述结果为空 → `empty`（语义是「查不到」，不是「不过滤」）
 *
 * 字典加载失败（`securitiesLoading=false` 且 `securities` 为空）同样收敛到 `empty`：
 * 宁可显示空态，也不能把类型筛选静默降级成全量。
 */
export function deriveTradeSecurityFilter({
  types,
  sec,
  securities,
  securitiesLoading,
}: DeriveTradeSecurityFilterInput): TradeSecurityFilter {
  if (types.length === 0) {
    return { state: 'ready', ids: [...sec] };
  }
  if (securitiesLoading) {
    return { state: 'loading', ids: [] };
  }
  const typeSet = new Set<SecurityType>(types);
  const typeIdSet = new Set(
    securities.filter((s) => typeSet.has(s.type)).map((s) => s.id),
  );
  const ids =
    sec.length > 0 ? sec.filter((id) => typeIdSet.has(id)) : [...typeIdSet];
  if (ids.length === 0) {
    return { state: 'empty', ids: [] };
  }
  return { state: 'ready', ids };
}
