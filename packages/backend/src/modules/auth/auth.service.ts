/**
 * 认证服务
 *
 * 职责：
 * - 用户注册：bcrypt 加盐哈希密码，创建用户记录
 * - 用户登录：校验密码，签发 JWT
 * - 获取当前用户信息：根据 userId 查询用户公开信息
 */

import {
  ConflictException,
  Inject,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcrypt';
import { PrismaService } from '../../prisma/prisma.service';

/** JWT payload 结构（签发和解析共用） */
export interface JwtPayload {
  /** 用户 ID（subject） */
  sub: string;
  /** 用户邮箱 */
  email: string;
  /** 签发时间（由 jwt 自动填充） */
  iat?: number;
  /** 过期时间（由 jwt 自动填充） */
  exp?: number;
}

/** bcrypt 加盐轮数（cost factor） */
const BCRYPT_ROUNDS = 10;

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwtService: JwtService,
    @Inject(ConfigService) private readonly configService: ConfigService,
  ) {}

  /**
   * 用户注册
   *
   * @throws ConflictException 邮箱已被注册
   */
  async register(email: string, password: string, name?: string) {
    const existing = await this.prisma.user.findUnique({ where: { email } });
    if (existing) {
      throw new ConflictException('邮箱已被注册');
    }

    const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
    const user = await this.prisma.user.create({
      data: { email, passwordHash, name },
    });

    return {
      id: user.id,
      email: user.email,
      name: user.name,
    };
  }

  /**
   * 用户登录，返回 JWT accessToken
   *
   * @throws UnauthorizedException 邮箱或密码错误
   */
  async login(email: string, password: string) {
    const user = await this.prisma.user.findUnique({ where: { email } });
    if (!user) {
      throw new UnauthorizedException('邮箱或密码错误');
    }

    const passwordValid = await bcrypt.compare(password, user.passwordHash);
    if (!passwordValid) {
      throw new UnauthorizedException('邮箱或密码错误');
    }

    const payload: JwtPayload = { sub: user.id, email: user.email };
    const accessToken = await this.jwtService.signAsync(payload);

    return {
      accessToken,
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
      },
    };
  }

  /**
   * 获取用户公开信息（不含密码哈希）
   *
   * @throws UnauthorizedException 用户不存在
   */
  async getProfile(userId: string) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) {
      throw new UnauthorizedException('用户不存在或 Token 无效');
    }

    return {
      id: user.id,
      email: user.email,
      name: user.name,
    };
  }
}
