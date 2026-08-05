/**
 * features/holdings/holdings-query-params.ts — 持仓页 URL 查询状态（T02 · AL-026/027/028）
 *
 * URL key（对齐增量设计 §3.3 / §4.1，均小写）：
 * - `date`    YYYY-MM-DD（缺省 = todayInAppTzIso()；等于默认不写入）
 * - `closed`  1/0（「显示已清仓」；初值 = UserPreference.showLiquidated，URL 参数优先）
 * - `types`   STOCK,ETF,...（逗号分隔；空 = 全部；与后端 holding.controller 白名单一致）
 * - `sec`     仅看某标的 ID（来自概览页「去更新行情」跳转，非工具栏控件）
 *
 * 约定：默认值不写入 URL；非法值静默降级；白名单外 key 忽略。
 */

import { SecurityType } from '@investment-tracker/shared';
import {
  arrayCodec,
  booleanCodec,
  dateCodec,
  stringCodec,
} from '@/lib/url-query';
import type { UrlStateSchema } from '@/lib/url-query';

/** 持仓页 URL 查询状态 */
export interface HoldingsQueryState {
  /** 推导日期 YYYY-MM-DD */
  date: string;
  /** 是否显示已清仓标的（qty=0） */
  closed: boolean;
  /** 标的类型多选（空 = 全部） */
  types: SecurityType[];
  /** 仅看某标的 ID（URL `sec`） */
  sec: string;
}

/**
 * 标的类型多选选项（与 shared `SecurityType` 对齐）。
 *
 * 说明：增量设计文案「股票/ETF/基金/债券/其他」中的「ETF」在本系统归入
 * `FUND`（证券枚举为 STOCK/FUND/BOND/CASH/OTHER，后端白名单同样只认这 5 类），
 * 故不单列 ETF 选项。
 */
export const HOLDINGS_TYPE_OPTIONS: ReadonlyArray<{
  value: SecurityType;
  label: string;
}> = [
  { value: SecurityType.STOCK, label: '股票' },
  { value: SecurityType.FUND, label: '基金' },
  { value: SecurityType.BOND, label: '债券' },
  { value: SecurityType.CASH, label: '现金' },
  { value: SecurityType.OTHER, label: '其他' },
];

/**
 * 构造 useUrlState schema。
 *
 * @param defaultDate 缺省日期（todayInAppTzIso()）
 * @param defaultClosed 「显示已清仓」初值（UserPreference.showLiquidated；URL 有 closed 时优先于它）
 */
export function createHoldingsSchema(
  defaultDate: string,
  defaultClosed: boolean,
): UrlStateSchema<HoldingsQueryState> {
  return {
    date: dateCodec(defaultDate),
    closed: booleanCodec(defaultClosed),
    types: arrayCodec<SecurityType>([]),
    sec: stringCodec(''),
  };
}
