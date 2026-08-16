/**
 * features/holdings/holdings-query-params.ts — 持仓页 URL 查询状态（T02/T04 · I-05 统一筛选器）
 *
 * URL key（对齐增量设计 §4.4.2 / §6.2.5，均小写；等于默认值不写入）：
 * - `date`      YYYY-MM-DD 持仓日期 as-of（缺省 = todayInAppTzIso()）
 * - `closed`    1/0 「显示已清仓」（持仓专属；初值 = UserPreference.showLiquidated，URL 参数优先）
 * - `types`     STOCK,ON_EXCHANGE_FUND,... 类型多选（持仓专属；空 = 全部）
 * - `sec`       标的多选（三板块；逗号分隔；空 = 全部）—— 🆕 I-05 升级 arrayCodec 多值
 * - `range`     1w|1m|3m|6m|1y|ytd|all|custom（买卖明细/分红费用日期范围；缺省 = 偏好 defaultDateRange）
 * - `from`/`to` YYYY-MM-DD（仅 range=custom 生效）
 * - `scenario`  all|BUY|SELL（买卖明细→side、分红费用→scenario；持仓不适用置灰）
 *
 * 约定：默认值不写入 URL；非法值静默降级；白名单外 key 忽略。
 */

import { SecurityType } from '@/lib/types';
import {
  arrayCodec,
  booleanCodec,
  dateCodec,
  enumCodec,
} from '@/lib/url-query';
import type { UrlStateSchema } from '@/lib/url-query';

/** 范围白名单（QUICK_RANGE_OPTIONS 7 项 + custom；与概览页 OVERVIEW_RANGE_VALUES 同构） */
export const HOLDINGS_RANGE_VALUES = [
  '1w',
  '1m',
  '3m',
  '6m',
  '1y',
  'ytd',
  'all',
  'custom',
] as const;

/** 场景白名单（all = 全部） */
export const HOLDINGS_SCENARIO_VALUES = ['all', 'BUY', 'SELL'] as const;

/** 持仓页统一筛选器状态（I-05） */
export interface HoldingsFilterState {
  /** 持仓日期 as-of（YYYY-MM-DD，持仓板块精确回溯） */
  date: string;
  /** 显示已清仓（持仓专属） */
  closed: boolean;
  /** 标的类型多选（持仓专属，空 = 全部） */
  types: SecurityType[];
  /** 标的多选（三板块，空 = 全部；I-05 升级多值） */
  sec: string[];
  /** 场景（买卖明细→side、分红费用→scenario；持仓不适用置灰） */
  scenario: (typeof HOLDINGS_SCENARIO_VALUES)[number];
  /** 快捷范围 1w|1m|3m|6m|1y|ytd|all|custom（买卖明细/分红费用） */
  range: (typeof HOLDINGS_RANGE_VALUES)[number];
  /** range=custom 起 */
  from: string;
  /** range=custom 止 */
  to: string;
}

/**
 * 标的类型多选选项（与 shared `SecurityType` 对齐）。
 *
 * 说明：场内基金（ON_EXCHANGE_FUND）合并原 ETF/LOF；场外基金（OFF_EXCHANGE_FUND）
 * 为银行/第三方代销开放式基金，二者分开筛选。
 */
export const HOLDINGS_TYPE_OPTIONS: ReadonlyArray<{
  value: SecurityType;
  label: string;
}> = [
  { value: SecurityType.STOCK, label: '股票' },
  { value: SecurityType.ON_EXCHANGE_FUND, label: '场内基金' },
  { value: SecurityType.OFF_EXCHANGE_FUND, label: '场外基金' },
  { value: SecurityType.BOND, label: '债券' },
  { value: SecurityType.OTHER, label: '其他' },
];

/**
 * 构造 useUrlState schema（I-05）。
 *
 * @param defaultDate 缺省日期（todayInAppTzIso()）
 * @param defaultClosed 「显示已清仓」初值（UserPreference.showLiquidated；URL 有 closed 时优先于它）
 * @param defaultRange 缺省快捷范围（UserPreference.defaultDateRange；URL 有 range 时优先于它）
 */
export function createHoldingsSchema(
  defaultDate: string,
  defaultClosed: boolean,
  defaultRange: string,
): UrlStateSchema<HoldingsFilterState> {
  const rangeDefault = (
    HOLDINGS_RANGE_VALUES as readonly string[]
  ).includes(defaultRange)
    ? (defaultRange as HoldingsFilterState['range'])
    : ('1y' as HoldingsFilterState['range']);
  return {
    date: dateCodec(defaultDate),
    closed: booleanCodec(defaultClosed),
    types: arrayCodec<SecurityType>([]),
    // 单值读取向后兼容：'abc' → ['abc']（arrayCodec 天然支持）
    sec: arrayCodec<string>([]),
    scenario: enumCodec(HOLDINGS_SCENARIO_VALUES, 'all'),
    range: enumCodec(HOLDINGS_RANGE_VALUES, rangeDefault),
    from: dateCodec(''),
    to: dateCodec(''),
  };
}
