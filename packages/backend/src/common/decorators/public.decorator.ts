/**
 * @Public() 装饰器
 *
 * 标记路由为公开访问（不需要 JWT 认证）。
 * 配合全局 JwtAuthGuard 使用：守卫检查到 @Public() 元数据时跳过认证。
 *
 * 用法：
 *   @Public()
 *   @Post('register')
 *   register(@Body() dto: RegisterDto) { ... }
 */

import { SetMetadata } from '@nestjs/common';

/** 元数据 key：标记路由是否公开 */
export const IS_PUBLIC_KEY = 'isPublic';

/**
 * 标记路由为公开访问，跳过 JWT 认证
 */
export const Public = (): MethodDecorator & ClassDecorator =>
  SetMetadata(IS_PUBLIC_KEY, true);
