/**
 * 认证服务
 *
 * 职责：
 * - 用户注册：bcrypt 加盐哈希密码，创建用户记录
 * - 用户登录：校验密码，签发 JWT
 * - 获取当前用户信息：根据 userId 查询用户公开信息
 * - 账户修改：修改密码 / 修改邮箱 / 修改个人资料
 * - 注销账户：软删除（deletedAt = now，SET-P1-06），
 *   子数据仍保留在库中，30 天内可恢复；软删除用户不能登录
 * - 自助恢复：冷静期内凭原邮箱 + 原密码清空 deletedAt 并直接登录（SYS-P1-02）
 *
 * 错误码约定（见 shared/types/api.ts）：
 * - 1001 邮箱或密码错误（HTTP 401，账户枚举防护的统一出口）
 * - 1003 邮箱已被注册（HTTP 409）
 * - 1004 当前密码错误（HTTP 400，刻意不用 401，避免前端拦截器把用户踢下线）
 * - 1007 账户处于注销冷静期（HTTP 409 + data.remainingDays）
 * - 1008 账户未注销、无需恢复（HTTP 409）
 * - 1009 恢复期已过（HTTP 410）
 * - 2000 参数/业务校验错误（HTTP 400）
 */

import {
  BadRequestException,
  ConflictException,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcrypt';
import { Prisma, type User } from '@prisma/client';
import {
  ACCOUNT_RETENTION_MS,
  BUSINESS_ERROR_CODE,
  type UserPublic,
} from '@investment-tracker/shared';
import { PrismaService } from '../../prisma/prisma.service';
import { toUserPublic } from './user-public.mapper';
import { AccountPendingDeletionException } from './exceptions/account-pending-deletion.exception';
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

/** 一天的毫秒数（冷静期剩余天数换算用） */
const DAY_MS = 24 * 60 * 60 * 1000;

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

  /**
   * 由「已软删时长」换算冷静期剩余天数（向上取整，最小 1 天）。
   *
   * 仅在确认 elapsedMs < ACCOUNT_RETENTION_MS 后调用。向上取整保证
   * 「还剩几个小时」也显示为 1 天，与 PRD §7.10「最小 1 天」一致。
   */
  private remainingRestoreDays(elapsedMs: number): number {
    return Math.max(1, Math.ceil((ACCOUNT_RETENTION_MS - elapsedMs) / DAY_MS));
  }

  /** 按 id 查询用户，不存在或已软删除抛 UnauthorizedException */
  private async findUserOrThrow(userId: string): Promise<User> {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user || user.deletedAt) {
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
    // 软删保留期内（deletedAt 非空）该 email 仍占用唯一索引，会拦截同邮箱重注册。
    // 这是刻意设计：避免「重注册同邮箱 → 旧数据与新账户混淆」。
    // 保留期满（30 天）后 CleanupService 物理硬删整行，索引槽随之释放，
    // 届时同邮箱可正常重注册，无需额外的索引处理。
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
   * 判定顺序是**安全要求，不可调换**（SYS-P1-02）：
   *   ① 邮箱不存在            → 1001 通用文案
   *   ② 密码错误（含账户确在冷静期）→ 1001 通用文案，绝不泄露冷静期
   *   ③ 已软删且未满保留期     → 1007 + data.remainingDays（HTTP 409）
   *   ④ 已软删且已超保留期     → 1001 通用文案（等价于账户不存在）
   *   ⑤ 正常                  → 签发 token
   *
   * 只有「密码校验通过」才允许暴露冷静期状态：此时请求方本就是账户所有者，
   * 告知冷静期不构成信息泄露；反之一律走 ① / ② 的通用出口，防账户枚举。
   *
   * @throws UnauthorizedException 1001 邮箱或密码错误
   * @throws AccountPendingDeletionException 1007 账户处于注销冷静期
   */
  async login(email: string, password: string): Promise<AuthTokenResult> {
    const user = await this.prisma.user.findUnique({ where: { email } });
    if (!user) {
      throw new UnauthorizedException('邮箱或密码错误');
    }

    const passwordValid = await bcrypt.compare(password, user.passwordHash);
    // 枚举防护：密码不通过的一切路径统一走通用文案，
    // 即便该账户确实处于冷静期，也绝不在此提示「可恢复」。
    if (!passwordValid) {
      throw new UnauthorizedException('邮箱或密码错误');
    }

    if (user.deletedAt) {
      const elapsedMs = Date.now() - user.deletedAt.getTime();
      if (elapsedMs < ACCOUNT_RETENTION_MS) {
        // 冷静期内：返回可自助恢复的信号（HTTP 409 + 1007），而非登录失败
        throw new AccountPendingDeletionException(
          this.remainingRestoreDays(elapsedMs),
        );
      }
      // 超过保留期：按 now - deletedAt 独立判定，与 CleanupService 是否已跑批无关。
      // 即便记录尚未被物理删除，也一律视为账户不存在。
      throw new UnauthorizedException('邮箱或密码错误');
    }

    return {
      accessToken: await this.signToken(user),
      user: this.toUserPublic(user),
    };
  }

  /**
   * 注销账户自助恢复（SYS-P1-02）：冷静期内凭原邮箱 + 原密码清空 deletedAt，
   * 并直接返回新 token（用户无需再登录一次）。
   *
   * 判定顺序同样是安全要求，不可调换：
   *   ① 邮箱不存在（含已硬删） → 1001 通用文案
   *   ② 密码错误              → 1001 通用文案（即便在冷静期内也不得提示可恢复）
   *   ③ deletedAt === null    → 1008（HTTP 409），恢复接口不得成为登录后门
   *   ④ 已超保留期            → 1009（HTTP 410），数据已不可找回
   *   ⑤ 冷静期内              → 清空 deletedAt，签发 token
   *
   * 注意：本方法**不复用** findUserOrThrow —— 后者会把软删用户当作不存在拦掉，
   * 而这里要处理的恰恰就是软删用户。
   *
   * 恢复只改 deletedAt 一个字段：组合 / 流水 / 快照 / 密码 / 偏好一律不动，
   * 恢复后的账户状态与注销前完全一致。
   *
   * TODO(P2 安全缺口)：本接口与 POST /auth/login 一样目前**没有任何限流**，
   * 存在被离线撞库的风险。经决策本次不引入 @nestjs/throttler（不加新依赖），
   * 留待统一的认证限流方案落地时一并处理。
   *
   * @throws UnauthorizedException 1001 邮箱或密码错误
   * @throws HttpException 1008 账户未注销 / 1009 恢复期已过
   */
  async restoreAccount(email: string, password: string): Promise<AuthTokenResult> {
    const user = await this.prisma.user.findUnique({ where: { email } });
    if (!user) {
      throw new UnauthorizedException('邮箱或密码错误');
    }

    const passwordValid = await bcrypt.compare(password, user.passwordHash);
    if (!passwordValid) {
      throw new UnauthorizedException('邮箱或密码错误');
    }

    if (!user.deletedAt) {
      throw new HttpException(
        {
          code: BUSINESS_ERROR_CODE.ACCOUNT_NOT_DELETED,
          message: '该账户无需恢复，请直接登录',
        },
        HttpStatus.CONFLICT,
      );
    }

    const elapsedMs = Date.now() - user.deletedAt.getTime();
    if (elapsedMs >= ACCOUNT_RETENTION_MS) {
      throw new HttpException(
        {
          code: BUSINESS_ERROR_CODE.RESTORE_EXPIRED,
          message: '恢复期已过，账户数据已不可找回',
        },
        HttpStatus.GONE,
      );
    }

    const updated = await this.prisma.user.update({
      where: { id: user.id },
      data: { deletedAt: null },
    });

    return {
      accessToken: await this.signToken(updated),
      user: this.toUserPublic(updated),
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
   * 注销账户：软删除（SET-P1-06）。
   *
   * 仅置 deletedAt = now，用户及其全部组合/现金流/交易/快照/净值/XIRR 数据
   * 仍保留在库中（保留 30 天可恢复）。软删除期间该用户不能登录，
   * email 仍占用唯一索引（30 天后由 CleanupService 硬删释放，
   * 同邮箱重注册即恢复）；到期后由定时任务彻底清理。
   *
   * @throws UnauthorizedException 用户不存在或 Token 无效
   */
  async deleteAccount(userId: string): Promise<null> {
    await this.findUserOrThrow(userId);
    await this.prisma.user.update({
      where: { id: userId },
      data: { deletedAt: new Date() },
    });
    return null;
  }
}
