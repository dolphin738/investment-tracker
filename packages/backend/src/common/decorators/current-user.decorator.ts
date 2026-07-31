/**
 * @CurrentUser() 参数装饰器
 *
 * 从 JWT 认证后的 request.user 中提取当前用户信息。
 * JwtStrategy.validate() 返回的对象成为 req.user，结构为 { userId, email }。
 *
 * 用法：
 *   getProfile(@CurrentUser() user: AuthenticatedUser) { ... }
 *   create(@CurrentUser('userId') userId: string, @Body() dto: Dto) { ... }
 */

import { createParamDecorator, ExecutionContext } from '@nestjs/common';

/**
 * JWT 认证后挂载到 request.user 上的用户信息
 */
export interface AuthenticatedUser {
  /** 用户 ID（对应 User.id） */
  userId: string;
  /** 用户邮箱 */
  email: string;
}

/**
 * 提取当前登录用户信息
 *
 * @param data 指定要提取的字段（如 'userId'），不传则返回整个 user 对象
 */
export const CurrentUser = createParamDecorator(
  (data: keyof AuthenticatedUser | undefined, ctx: ExecutionContext): AuthenticatedUser | unknown => {
    const request = ctx.switchToHttp().getRequest();
    const user = request.user as AuthenticatedUser | undefined;
    if (!user) {
      return undefined;
    }
    return data ? user[data] : user;
  },
);
