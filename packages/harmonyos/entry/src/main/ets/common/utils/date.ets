/**
 * 日期工具 — 日期范围计算、维度标签生成
 *
 * 所有日期均为业务日期（YYYY-MM-DD），不涉及时区转换。
 */

export class DateUtil {
  /**
   * 获取今天的日期字符串
   * @returns YYYY-MM-DD
   */
  static today(): string {
    const now = new Date();
    return DateUtil.dateToString(now);
  }

  /**
   * Date 对象转 YYYY-MM-DD 字符串
   */
  static dateToString(date: Date): string {
    const year = date.getFullYear();
    const month = (date.getMonth() + 1).toString().padStart(2, '0');
    const day = date.getDate().toString().padStart(2, '0');
    return `${year}-${month}-${day}`;
  }

  /**
   * YYYY-MM-DD 字符串转 Date 对象
   */
  static stringToDate(str: string): Date {
    const parts = str.split('-');
    return new Date(parseInt(parts[0]), parseInt(parts[1]) - 1, parseInt(parts[2]));
  }

  /**
   * 检查日期是否为未来日期
   */
  static isFutureDate(date: string): boolean {
    const today = DateUtil.today();
    return date > today;
  }

  /**
   * 根据查询粒度获取默认日期范围
   * @param granularity day / week / month / year
   * @returns { startDate, endDate } YYYY-MM-DD
   */
  static getDefaultRange(granularity: string): { startDate: string; endDate: string } {
    const now = new Date();
    const end = DateUtil.dateToString(now);
    let start: Date;

    switch (granularity) {
      case 'day':
        // 最近 30 天
        start = new Date(now);
        start.setDate(start.getDate() - 30);
        break;
      case 'week':
        // 最近 12 周（约 84 天）
        start = new Date(now);
        start.setDate(start.getDate() - 84);
        break;
      case 'month':
        // 最近 12 个月
        start = new Date(now);
        start.setMonth(start.getMonth() - 12);
        break;
      case 'year':
        // 最近 5 年
        start = new Date(now);
        start.setFullYear(start.getFullYear() - 5);
        break;
      default:
        start = new Date(now);
        start.setMonth(start.getMonth() - 12);
        break;
    }

    return { startDate: DateUtil.dateToString(start), endDate: end };
  }

  /**
   * 获取当年日期范围
   */
  static getCurrentYearRange(): { startDate: string; endDate: string } {
    const now = new Date();
    const yearStart = `${now.getFullYear()}-01-01`;
    const yearEnd = DateUtil.dateToString(now);
    return { startDate: yearStart, endDate: yearEnd };
  }

  /**
   * 获取查询粒度的中文标签
   */
  static getGranularityLabel(granularity: string): string {
    switch (granularity) {
      case 'day': return '按日';
      case 'week': return '按周';
      case 'month': return '按月';
      case 'year': return '按年';
      default: return '按月';
    }
  }

  /**
   * 获取查询粒度的简称（用于 Tab 标签）
   */
  static getGranularityShortLabel(granularity: string): string {
    switch (granularity) {
      case 'day': return '日';
      case 'week': return '周';
      case 'month': return '月';
      case 'year': return '年';
      default: return '月';
    }
  }

  /**
   * 获取所有粒度选项数组
   */
  static getAllGranularities(): string[] {
    return ['day', 'week', 'month', 'year'];
  }

  /**
   * 格式化日期范围用于显示
   * @param startDate 起始日期
   * @param endDate 结束日期
   * @returns 如 "2025-01-01 ~ 2025-07-29"
   */
  static formatRange(startDate: string, endDate: string): string {
    return `${startDate} ~ ${endDate}`;
  }
}
