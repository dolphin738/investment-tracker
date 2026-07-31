/**
 * JWT 认证守卫
 *
 * 作为全局守卫使用（通过 APP_GUARD 注册）。
 * 所有路由默认需要 JWT 认证，被 @Public() 标记的路由跳过认证。
 *
 * 认证流程：
 * 1. 检查路由是否有 @Public() 元数据 → 有则放行
 * 2. 调用 Passport JWT 策略验证 Bearer Token
 * 3. Token 无效或缺失 → 抛出 401 Unauthorized
 */

import { ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AuthGuard } from '@nestjs/passport';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';

@Injectable()
export class JwtAuthGuard extends AuthGuard('jwt') {
  constructor(private readonly reflector: Reflector) {
    super();
  }

  canActivate(context: ExecutionContext) {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (isPublic) {
      return true;
    }

    return super.canActivate(context);
  }
}
