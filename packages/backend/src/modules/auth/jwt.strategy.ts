/**
 * JWT Passport 策略
 *
 * 从 Authorization: Bearer <token> 头中提取 JWT，验证签名和过期时间，
 * 然后查询数据库确认用户仍存在，将 { userId, email } 挂载到 request.user。
 */

import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { PrismaService } from '../../prisma/prisma.service';
import type { JwtPayload } from './auth.service';

/** request.user 上挂载的用户信息 */
export interface AuthenticatedUserPayload {
  userId: string;
  email: string;
}

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy, 'jwt') {
  constructor(
    private readonly prisma: PrismaService,
    configService: ConfigService,
  ) {
    const secret = configService.get<string>('JWT_SECRET');
    if (!secret) {
      throw new Error('JWT_SECRET 环境变量未配置');
    }

    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: secret,
    });
  }

  /**
   * Passport 自动调用：验证 token 后，将返回值挂载到 request.user
   */
  async validate(payload: JwtPayload): Promise<AuthenticatedUserPayload> {
    const user = await this.prisma.user.findUnique({
      where: { id: payload.sub },
    });

    if (!user) {
      throw new UnauthorizedException('用户不存在或 Token 无效');
    }

    return {
      userId: user.id,
      email: user.email,
    };
  }
}
