/**
 * User 类型定义
 *
 * 对应 Prisma model User（users 表）。
 * 密码哈希字段（passwordHash）仅在内部使用，不通过 API 传输。
 */

/**
 * 用户完整实体（内部/服务端使用，含敏感字段）
 */
export interface User {
  /** UUID 主键 */
  id: string;
  /** 唯一邮箱，作为登录凭证 */
  email: string;
  /** bcrypt 密码哈希（仅服务端，不传输到前端） */
  passwordHash: string;
  /** 显示名称，可为空 */
  name: string | null;
  /** 头像 URL（http/https），可为空 */
  avatar: string | null;
  /** 手机号（中国大陆 11 位），可为空 */
  phone: string | null;
  /** 个人简介，最长 200 字，可为空 */
  bio: string | null;
  /** 创建时间 ISO 8601 */
  createdAt: string;
  /** 更新时间 ISO 8601 */
  updatedAt: string;
}

/**
 * 用户公开信息（API 响应中传输的安全子集，不含 passwordHash）
 */
export interface UserPublic {
  id: string;
  email: string;
  name: string | null;
  /** 头像 URL（http/https），可为空 */
  avatar: string | null;
  /** 手机号（中国大陆 11 位），可为空 */
  phone: string | null;
  /** 个人简介，最长 200 字，可为空 */
  bio: string | null;
}
