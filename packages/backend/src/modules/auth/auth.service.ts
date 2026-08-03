/**
 * 认证服务
 *
 * 职责：
 * - 用户注册：bcrypt 加盐哈希密码，创建用户记录
 * - 用户登录：校验密码，签发 JWT
 * - 获取当前用户信息：根据 userId 查询用户公开信息
 * - 账户修改：修改密码 / 修改邮箱 / 修改个人资料
 * - 注销账户：删除用户，子数据由 Prisma onDelete: Cascade 级联清理
 *
 * 错误码约定（见 shared/types/api.ts）：
 * - 1003 邮箱已被注册（HTTP 409）
 * - 1004 当前密码错误（HTTP 400，刻意不用 401，避免前端拦截器把用户踢下线）
 * - 2000 参数/业务校验错误（HTTP 400）
 */

import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcrypt';
import { Prisma, type User } from '@prisma/client';
import type { UserPublic } from '@investment-tracker/shared';
import { PrismaService } from '../../prisma/prisma.service';
import { toUserPublic } from './user-public.mapper';
import { UpdateEmailDto } from './dto/update-email.dto';
import { UpdatePasswordDto } from './dto/update-password.dto';
import { UpdateProfileDto } from './dto/update-profile.dto';

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

/** 携带新 token 的认证响应（登录 / 改密码 / 改邮箱共用） */
export interface AuthTokenResult {
  accessToken: string;
  user: UserPublic;
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

  // ==========================================================
  // 私有辅助方法
  // ==========================================================

  /** 签发 JWT accessToken（payload 固定为 { sub, email }） */
  private async signToken(user: { id: string; email: string }): Promise<string> {
    const payload: JwtPayload = { sub: user.id, email: user.email };
    return this.jwtService.signAsync(payload);
  }

  /**
   * 把 Prisma User 实体裁剪为对外公开的安全子集（剔除 passwordHash）。
   *
   * 实际投影逻辑已抽到 user-public.mapper.ts，供 UploadService 等模块共用，
   * 保证「auth 加字段、upload 漏字段」这类不一致不会发生。
   */
  private toUserPublic(user: User): UserPublic {
    return toUserPublic(user);
  }

  /**
   * 校验当前密码，失败抛 HTTP 400 + 业务码 1004。
   *
   * 这里刻意不用 401：前端拦截器对任何 401 都会清 token 并跳登录页，
   * 用 401 会把正在修改密码的用户直接踢下线。
   */
  private async assertCurrentPassword(user: User, plain: string): Promise<void> {
    const ok = await bcrypt.compare(plain, user.passwordHash);
    if (!ok) {
      throw new BadRequestException({ code: 1004, message: '当前密码错误' });
    }
  }

  /** 按 id 查询用户，不存在抛 UnauthorizedException */
  private async findUserOrThrow(userId: string): Promise<User> {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) {
      throw new UnauthorizedException('用户不存在或 Token 无效');
    }
    return user;
  }

  // ==========================================================
  // 注册 / 登录 / 获取信息
  // ==========================================================

  /**
   * 用户注册
   *
   * @throws ConflictException 邮箱已被注册
   */
  async register(email: string, password: string, name?: string): Promise<UserPublic> {
    const existing = await this.prisma.user.findUnique({ where: { email } });
    if (existing) {
      throw new ConflictException('邮箱已被注册');
    }

    const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
    const user = await this.prisma.user.create({
      data: { email, passwordHash, name },
    });

    return this.toUserPublic(user);
  }

  /**
   * 用户登录，返回 JWT accessToken
   *
   * @throws UnauthorizedException 邮箱或密码错误
   */
  async login(email: string, password: string): Promise<AuthTokenResult> {
    const user = await this.prisma.user.findUnique({ where: { email } });
    if (!user) {
      throw new UnauthorizedException('邮箱或密码错误');
    }

    const passwordValid = await bcrypt.compare(password, user.passwordHash);
    if (!passwordValid) {
      throw new UnauthorizedException('邮箱或密码错误');
    }

    return {
      accessToken: await this.signToken(user),
      user: this.toUserPublic(user),
    };
  }

  /**
   * 获取用户公开信息（不含密码哈希）
   *
   * @throws UnauthorizedException 用户不存在
   */
  async getProfile(userId: string): Promise<UserPublic> {
    const user = await this.findUserOrThrow(userId);
    return this.toUserPublic(user);
  }

  // ==========================================================
  // 账户修改
  // ==========================================================

  /**
   * 修改密码：校验当前密码 → 重新哈希落库 → 重签 token
   *
   * @throws BadRequestException 1004 当前密码错误 / 2000 新旧密码相同
   */
  async updatePassword(userId: string, dto: UpdatePasswordDto): Promise<AuthTokenResult> {
    const user = await this.findUserOrThrow(userId);
    await this.assertCurrentPassword(user, dto.currentPassword);

    if (dto.newPassword === dto.currentPassword) {
      throw new BadRequestException({
        code: 2000,
        message: '新密码不能与当前密码相同',
      });
    }

    const passwordHash = await bcrypt.hash(dto.newPassword, BCRYPT_ROUNDS);
    const updated = await this.prisma.user.update({
      where: { id: userId },
      data: { passwordHash },
    });

    return {
      accessToken: await this.signToken(updated),
      user: this.toUserPublic(updated),
    };
  }

  /**
   * 修改邮箱：校验当前密码 → 查重 → 落库 → 重签 token（payload.email 同步更新）
   *
   * @throws BadRequestException 1004 当前密码错误 / 2000 新邮箱与当前相同
   * @throws ConflictException 1003 邮箱已被占用
   */
  async updateEmail(userId: string, dto: UpdateEmailDto): Promise<AuthTokenResult> {
    const user = await this.findUserOrThrow(userId);
    await this.assertCurrentPassword(user, dto.currentPassword);

    if (dto.newEmail === user.email) {
      throw new BadRequestException({
        code: 2000,
        message: '新邮箱与当前邮箱相同',
      });
    }

    const occupied = await this.prisma.user.findUnique({
      where: { email: dto.newEmail },
    });
    if (occupied) {
      throw new ConflictException('该邮箱已被注册');
    }

    const updated = await this.prisma.user.update({
      where: { id: userId },
      data: { email: dto.newEmail },
    });

    return {
      accessToken: await this.signToken(updated),
      user: this.toUserPublic(updated),
    };
  }

  /**
   * 修改个人资料（三态语义）：
   * - undefined → 该字段不参与更新
   * - null / '' → 清空为 NULL
   * - 有值      → 更新为该值
   *
   * 安全约束：data 中绝不包含 email / passwordHash。
   */
  async updateProfile(userId: string, dto: UpdateProfileDto): Promise<UserPublic> {
    const data: Prisma.UserUpdateInput = {};
    if (dto.name !== undefined) data.name = dto.name === '' ? null : dto.name;
    if (dto.avatar !== undefined) data.avatar = dto.avatar === '' ? null : dto.avatar;
    if (dto.phone !== undefined) data.phone = dto.phone === '' ? null : dto.phone;
    if (dto.bio !== undefined) data.bio = dto.bio === '' ? null : dto.bio;

    // 没有任何字段需要更新时，直接回读当前资料，避免无谓写库
    if (Object.keys(data).length === 0) {
      return this.getProfile(userId);
    }

    const updated = await this.prisma.user.update({
      where: { id: userId },
      data,
    });

    return this.toUserPublic(updated);
  }

  /**
   * 注销账户：删除用户记录。
   *
   * 组合 / 现金流 / 交易 / 快照 / 净值 / XIRR / 偏好等子数据
   * 由 Prisma Schema 中的 onDelete: Cascade 级联清理，无需逐个删除。
   *
   * @throws UnauthorizedException 用户不存在或 Token 无效
   */
  async deleteAccount(userId: string): Promise<null> {
    await this.findUserOrThrow(userId);
    await this.prisma.user.delete({ where: { id: userId } });
    return null;
  }
}
