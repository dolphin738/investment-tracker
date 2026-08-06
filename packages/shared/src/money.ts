/**
 * packages/shared/src/money.ts — 金额 / 税 / 费用工具（前后端共用，零依赖）
 *
 * 设计约束（增量设计 C-8 / K-3）：
 * - 金额 / 税 / 费用：NUMERIC(18,2) 字符串传输，避免 JS 浮点丢精
 * - 内部一律「整数分」运算（BigInt），杜绝 0.1+0.2=0.30000000000000004 毛刺
 * - 前端表单 zod refine 与后端 Decimal 校验共用同一套格式口径，避免两套正则漂移
 */

/** 金额正则：非负、最多 2 位小数（空串不匹配） */
export const MONEY_RE = /^\d+(\.\d{1,2})?$/;

/** isMoneyString 选项 */
export interface MoneyOptions {
  /**
   * 是否允许 0（默认 true：'0' / '0.00' 合法，税与费用允许为 0）。
   * 置 false 时要求数值 > 0（分红金额 / 费用金额这类必须为正的字段）。
   */
  allowZero?: boolean;
}

/**
 * 校验字符串是否为合法金额（非负、最多 2 位小数）。
 *
 * @example
 * isMoneyString('0.00')            // true
 * isMoneyString('1500.45')         // true
 * isMoneyString('1500.456')        // false（超 2 位小数）
 * isMoneyString('-1')              // false（不允许负数）
 * isMoneyString('0.00', { allowZero: false }) // false（必须 > 0）
 */
export function isMoneyString(value: string, opts: MoneyOptions = {}): boolean {
  if (typeof value !== 'string') return false;
  const v = value.trim();
  if (!MONEY_RE.test(v)) return false;
  if (opts.allowZero === false) {
    return Number(v) > 0;
  }
  return true;
}

/** 金额字符串 → 整数分（BigInt，精确无浮点） */
function toCents(value: string): bigint {
  const v = value.trim();
  if (v === '' || v === '.') return 0n;
  const [intPart = '0', fracPart = ''] = v.split('.');
  const frac = (fracPart + '00').slice(0, 2);
  return BigInt(intPart || '0') * 100n + BigInt(frac || '0');
}

/** 整数分 → 金额字符串（恒 2 位小数） */
function fromCents(cents: bigint): string {
  const sign = cents < 0n ? '-' : '';
  const abs = cents < 0n ? -cents : cents;
  const int = abs / 100n;
  const frac = abs % 100n;
  return `${sign}${int.toString()}.${frac.toString().padStart(2, '0')}`;
}

/**
 * 计算净额 = amount − tax（整数分运算，返回恒 2 位小数字符串）。
 *
 * 注意：本函数只做计算，不校验净额 ≥ 0；是否允许负净额由调用方
 * （前端 zod refine / 后端 validateNetAmount）按业务口径把关。
 *
 * @example
 * computeNetAmount('1500', '300') // '1200.00'
 * computeNetAmount('100', '150')  // '-50.00'（调用方负责拒绝）
 */
export function computeNetAmount(amount: string, tax: string): string {
  return fromCents(toCents(amount) - toCents(tax));
}

/**
 * 金额求和（整数分运算，返回恒 2 位小数字符串）。
 *
 * @example
 * sumMoney(['45.00', '0', '5']) // '50.00'
 * sumMoney(['0.10', '0.20'])    // '0.30'（无浮点毛刺）
 */
export function sumMoney(values: Array<string | number>): string {
  let total = 0n;
  for (const v of values) {
    total += toCents(String(v));
  }
  return fromCents(total);
}
