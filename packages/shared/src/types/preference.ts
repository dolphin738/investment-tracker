/**
 * UserPreference（用户偏好）类型定义
 *
 * 对应 Prisma model UserPreference（user_preferences 表）。
 * 列式存储（非 JSON），Prisma 类型安全、可索引（SET-P0-02）。
 *
 * 偏好设置跟随账号，实现多端/多浏览器一致。
 * 首次登录返回系统默认值，保存为乐观更新 + 失败回滚。
 */

/**
 * 默认粒度枚举
 */
export const PreferenceGranularity = {
  DAY: 'day',
  WEEK: 'week',
  MONTH: 'month',
  YEAR: 'year',
} as const;

export type PreferenceGranularity =
  (typeof PreferenceGranularity)[keyof typeof PreferenceGranularity];

/**
 * 默认日期范围枚举
 */
export const PreferenceDateRange = {
  /** 近 3 月 */
  THREE_MONTHS: '3m',
  /** 近 1 年 */
  ONE_YEAR: '1y',
  /** 今年至今 */
  YEAR_TO_DATE: 'ytd',
  /** 全部 */
  ALL: 'all',
} as const;

export type PreferenceDateRange =
  (typeof PreferenceDateRange)[keyof typeof PreferenceDateRange];

/**
 * 聚合方式枚举（复用 QueryGranularity 中的概念，这里是偏好存储的值）
 */
export const PreferenceAggregation = {
  /** 取期末值 */
  LAST: 'last',
  /** 取平均值 */
  AVG: 'avg',
} as const;

export type PreferenceAggregation =
  (typeof PreferenceAggregation)[keyof typeof PreferenceAggregation];

/**
 * 主题枚举
 */
export const PreferenceTheme = {
  LIGHT: 'light',
  DARK: 'dark',
  SYSTEM: 'system',
} as const;

export type PreferenceTheme =
  (typeof PreferenceTheme)[keyof typeof PreferenceTheme];

/**
 * 用户偏好实体
 */
export interface UserPreference {
  /** UUID 主键 */
  id: string;
  /** 用户 ID（唯一） */
  userId: string;
  /** 登录后自动选中的组合 ID */
  defaultPortfolioId: string | null;
  /** 默认时间维度，默认 "month" */
  defaultGranularity: string;
  /** 默认日期范围快捷项，默认 "1y" */
  defaultDateRange: string;
  /** 周期聚合方式，默认 "last" */
  aggregation: string;
  /** 按周聚合的周起始日（0=周日, 1=周一），默认 1 */
  weekStartsOn: number;
  /** 净值展示小数位，默认 4 */
  navDecimals: number;
  /** XIRR 百分比小数位，默认 2 */
  xirrDecimals: number;
  /** 主题（light/dark/system），默认 "system" */
  theme: string;
  /** 快照过期提醒阈值（天数），默认 3 */
  staleDays: number;
  /** 创建时间 ISO 8601 */
  createdAt: string;
  /** 更新时间 ISO 8601 */
  updatedAt: string;
}

/**
 * 更新偏好 DTO（所有字段可选）
 */
export interface UpdatePreferenceDto {
  /** 登录后自动选中的组合 ID */
  defaultPortfolioId?: string | null;
  /** 默认时间维度 */
  defaultGranularity?: string;
  /** 默认日期范围快捷项 */
  defaultDateRange?: string;
  /** 周期聚合方式 */
  aggregation?: string;
  /** 按周聚合的周起始日 */
  weekStartsOn?: number;
  /** 净值展示小数位 */
  navDecimals?: number;
  /** XIRR 百分比小数位 */
  xirrDecimals?: number;
  /** 主题 */
  theme?: string;
  /** 快照过期提醒阈值 */
  staleDays?: number;
}
