/**
 * User 实体 → UserPublic 公开投影
 *
 * 抽成独立函数，让 AuthService 与 UploadService 共用同一份投影逻辑，
 * 避免「auth 加了字段、upload 忘了加」导致两个接口返回结构不一致。
 *
 * 安全约束：这里是唯一允许把 Prisma User 转成对外结构的地方，
 * 必须显式列字段（白名单），绝不能写成 `{ ...user, passwordHash: undefined }`。
 */

import type { User } from '@prisma/client';
import type { UserPublic } from '@investment-tracker/shared';

/**
 * 把 Prisma User 实体裁剪为对外公开的安全子集（剔除 passwordHash）
 *
 * @param user Prisma 查询出的完整用户实体
 * @returns 可安全返回给前端的用户公开信息
 */
export function toUserPublic(user: User): UserPublic {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    avatar: user.avatar,
    phone: user.phone,
    bio: user.bio,
  };
}
