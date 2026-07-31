/**
 * 格式化工具 — 金额 / 百分比 / 日期 / 小数
 *
 * 用于统一展示格式：
 * - formatPercent: 0.1234 → "12.34%"
 * - formatDecimal: "1.200000" → "1.2000"
 * - formatCurrency: "10000.00" → "¥10,000.00"
 * - formatDate: "2025-07-29" → "2025-07-29"（或 "07-29" 短格式）
 */

export class FormatUtil {
  /**
   * 格式化百分比
   * @param value 小数形式（如 0.1234 表示 12.34%），null 返回 "--"
   * @param decimals 小数位数（默认 2）
   * @returns 格式化后的百分比字符串，如 "12.34%"
   */
  static formatPercent(value: number | null, decimals: number = 2): string {
    if (value === null || value === undefined || isNaN(value)) {
      return '--';
    }
    const percent = value * 100;
    return `${percent.toFixed(decimals)}%`;
  }

  /**
   * 格式化百分比（带正负号）
   * @param value 小数形式
   * @param decimals 小数位数（默认 2）
   * @returns 如 "+12.34%" 或 "-5.20%"
   */
  static formatPercentSigned(value: number | null, decimals: number = 2): string {
    if (value === null || value === undefined || isNaN(value)) {
      return '--';
    }
    const percent = value * 100;
    const sign = percent >= 0 ? '+' : '';
    return `${sign}${percent.toFixed(decimals)}%`;
  }

  /**
   * 格式化小数
   * @param value 数值或字符串（Decimal as string）
   * @param decimals 小数位数（默认 4）
   * @returns 格式化后的小数字符串，如 "1.2000"
   */
  static formatDecimal(value: number | string | null, decimals: number = 4): string {
    if (value === null || value === undefined) {
      return '--';
    }
    const num = typeof value === 'string' ? parseFloat(value) : value;
    if (isNaN(num)) {
      return '--';
    }
    return num.toFixed(decimals);
  }

  /**
   * 格式化金额（带千分位和货币符号）
   * @param value 数值或字符串
   * @param currency 货币符号（默认 "¥"）
   * @returns 如 "¥10,000.00"
   */
  static formatCurrency(value: number | string | null, currency: string = '¥'): string {
    if (value === null || value === undefined) {
      return '--';
    }
    const num = typeof value === 'string' ? parseFloat(value) : value;
    if (isNaN(num)) {
      return '--';
    }
    const formatted = num.toLocaleString('zh-CN', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });
    return `${currency}${formatted}`;
  }

  /**
   * 格式化日期（完整格式）
   * @param date YYYY-MM-DD 字符串
   * @returns 如 "2025-07-29"
   */
  static formatDate(date: string): string {
    if (!date || date.length === 0) {
      return '--';
    }
    return date;
  }

  /**
   * 格式化日期（短格式，仅月-日）
   * @param date YYYY-MM-DD 字符串
   * @returns 如 "07-29"
   */
  static formatDateShort(date: string): string {
    if (!date || date.length < 10) {
      return '--';
    }
    return date.substring(5, 10);
  }

  /**
   * 格式化净值变化（pp = percentage points）
   * @param value 小数形式的差值
   * @returns 如 "+0.05pp" 或 "-0.02pp"
   */
  static formatPP(value: number | null, decimals: number = 2): string {
    if (value === null || value === undefined || isNaN(value)) {
      return '--';
    }
    const pp = value * 100;
    const sign = pp >= 0 ? '+' : '';
    return `${sign}${pp.toFixed(decimals)}pp`;
  }
}
