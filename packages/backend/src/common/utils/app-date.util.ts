/**
 * 应用日期工具（UTC+8 口径）
 *
 * 全项目统一的"应用日"入口。所有需要"今天"或解析日期参数的地方
 * 必须使用本工具，避免 UTC 截断与本地时区混用导致跨日。
 *
 * 数据库 @db.Date 列以 UTC 午夜 JS Date 存取，本工具产出的 Date
 * 一律为 UTC 午夜，与 Prisma 口径一致。
 */

import { BadRequestException } from '@nestjs/common';

/** 应用时区（UTC+8）的当天，表示为 UTC 午夜 Date */
export function todayInAppTz(): Date {
  const now = new Date();
  // UTC+8 的"今天"= 当前时刻加 8 小时后的 UTC 日历日
  // 避免 toISOString() 直接截断取 UTC 日期导致 UTC+8 凌晨 0-8 点"今天"变成昨天
  const appNow = new Date(now.getTime() + 8 * 60 * 60 * 1000);
  const s = appNow.toISOString().split('T')[0];
  return new Date(s + 'T00:00:00.000Z');
}

/**
 * 解析 YYYY-MM-DD 为 UTC 午夜 Date
 *
 * 统一口径：避免 new Date('YYYY-MM-DD')（UTC 午夜）与
 * new Date(y, m, d)（本地午夜）混用导致 UTC+8 跨日。
 */
export function parseAppDate(dateStr: string): Date {
  const parts = dateStr.split('-').map((p) => Number(p));
  if (parts.length !== 3 || parts.some((p) => Number.isNaN(p))) {
    throw new BadRequestException(`无效日期参数: ${dateStr}`);
  }
  return new Date(dateStr + 'T00:00:00.000Z');
}
