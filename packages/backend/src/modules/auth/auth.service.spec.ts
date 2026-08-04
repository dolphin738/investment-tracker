/**
 * 认证服务单元测试
 *
 * 测试 AuthService 的注册、登录、获取信息、账户修改功能。
 * 通过 mock PrismaService / JwtService / bcrypt 隔离外部依赖。
 *
 * 测试覆盖：
 * 1. 注册：密码 bcrypt 哈希、返回用户信息（不含密码）
 * 2. 登录：验证密码、签发 JWT
 * 3. 邮箱已存在：注册失败抛 ConflictException
 * 4. 登录密码错误：抛 UnauthorizedException
 * 5. 登录用户不存在：抛 UnauthorizedException
 * 6. 获取用户信息
 * 7. 修改密码：当前密码错 → 400 + code 1004（绝不 401）；新旧相同 → 400 + 2000
 * 8. 修改邮箱：邮箱被占用 → ConflictException；成功后重签 token
 * 9. 修改资料：只更新出现的字段，空串清空，data 不含 email / passwordHash
 * 10. 错误码信封映射（经全局异常过滤器）：1004 / 2000 / 1003 与 HTTP 状态码的对应关系
 * 11. 改密码闭环：新密码可登录、旧密码失败
 * 12. UserPublic 契约：register / login / getProfile 均返回 avatar / phone / bio
 * 13. 注销冷静期与自助恢复（SYS-P1-02）：login 冷静期信号 1007（含边界
 *     0 天 / 29.5 天 / 30 天整）+ restoreAccount 六分支（1001/1008/1009/成功）
 */

import 'reflect-metadata';
import {
  BadRequestException,
  ConflictException,
  UnauthorizedException,
  ValidationPipe,
  type ArgumentMetadata,
  type ArgumentsHost,
} from '@nestjs/common';
import { ACCOUNT_RETENTION_MS } from '@investment-tracker/shared';
import { AuthService } from './auth.service';
import { HttpExceptionFilter } from '../../common/filters/http-exception.filter';
import { LoginDto } from './dto/login.dto';
import { RegisterDto } from './dto/register.dto';
import { RestoreAccountDto } from './dto/restore-account.dto';
import { UpdateEmailDto } from './dto/update-email.dto';
import { UpdatePasswordDto } from './dto/update-password.dto';
import { UpdateProfileDto } from './dto/update-profile.dto';

// Mock bcrypt 模块
jest.mock('bcrypt', () => ({
  hash: jest.fn(),
  compare: jest.fn(),
}));

// 导入 bcrypt（已被 mock）
import * as bcrypt from 'bcrypt';

// ============================================================
// 辅助函数
// ============================================================

/** 创建 mock PrismaService */
function createMockPrisma() {
  return {
    user: {
      findUnique: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
    },
  };
}

/** 创建 mock JwtService */
function createMockJwtService() {
  return {
    signAsync: jest.fn(),
  };
}

/** 创建 mock ConfigService */
function createMockConfigService() {
  return {
    get: jest.fn((key: string) => {
      if (key === 'JWT_SECRET') return 'test-secret';
      return null;
    }),
  };
}

/** 构造一条完整的 Prisma User 记录（便于覆盖个别字段） */
function buildUser(overrides: Record<string, unknown> = {}) {
  return {
    id: 'user-uuid-1',
    email: 'test@example.com',
    passwordHash: 'hashed_password_123',
    name: 'Test User',
    avatar: null,
    phone: null,
    bio: null,
    // 软删除标记（SET-P1-06）：默认为正常账户
    deletedAt: null,
    createdAt: new Date('2024-01-01'),
    updatedAt: new Date('2024-01-01'),
    ...overrides,
  };
}

/** 一天的毫秒数（构造冷静期边界用） */
const DAY_MS = 24 * 60 * 60 * 1000;

/** 构造一个「已软删 elapsedDays 天」的用户 */
function buildDeletedUser(elapsedDays: number, overrides: Record<string, unknown> = {}) {
  return buildUser({
    deletedAt: new Date(Date.now() - elapsedDays * DAY_MS),
    ...overrides,
  });
}

/** UserPublic 的完整字段集（用于契约断言：不多一个、不少一个） */
const USER_PUBLIC_KEYS = ['avatar', 'bio', 'email', 'id', 'name', 'phone'];

/** 全局异常过滤器输出的响应信封 */
interface CapturedResponse {
  status: number;
  body: { code: number; data: unknown; message: string };
}

/**
 * 把异常喂给全局 HttpExceptionFilter，捕获它最终写给客户端的
 * HTTP 状态码与响应信封。
 *
 * 这样断言的就是「前端真正收到的东西」，而不仅仅是 service 抛了什么类型的异常。
 */
function captureFilterOutput(exception: unknown): CapturedResponse {
  const captured = {
    status: 0,
    body: { code: -1, data: undefined as unknown, message: '' },
  };

  const json = jest.fn((body: CapturedResponse['body']) => {
    captured.body = body;
  });
  const status = jest.fn((code: number) => {
    captured.status = code;
    return { json };
  });
  const host = {
    switchToHttp: () => ({
      getResponse: () => ({ status }),
      getRequest: () => ({}),
    }),
  } as unknown as ArgumentsHost;

  new HttpExceptionFilter().catch(exception, host);
  return captured as CapturedResponse;
}

/**
 * 断言 Promise 必然 reject，并返回异常经全局过滤器后的响应信封。
 *
 * 用哨兵错误区分「调用意外成功」与「业务异常」，避免 try/catch 里
 * 自己抛出的错误被同一个 catch 吞掉导致误判。
 */
const NOT_THROWN = Symbol('promise resolved but rejection expected');

async function captureRejection(
  promise: Promise<unknown>,
): Promise<CapturedResponse> {
  let thrown: unknown = NOT_THROWN;
  try {
    await promise;
  } catch (err) {
    thrown = err;
  }
  if (thrown === NOT_THROWN) {
    throw new Error('预期调用抛出异常，但它成功返回了');
  }
  return captureFilterOutput(thrown);
}

// ============================================================
// 测试
// ============================================================

describe('AuthService', () => {
  let service: AuthService;
  let mockPrisma: any;
  let mockJwtService: any;
  let mockConfigService: any;

  beforeEach(() => {
    mockPrisma = createMockPrisma();
    mockJwtService = createMockJwtService();
    mockConfigService = createMockConfigService();

    service = new AuthService(mockPrisma, mockJwtService, mockConfigService);

    // 重置 bcrypt mock
    (bcrypt.hash as jest.Mock).mockReset();
    (bcrypt.compare as jest.Mock).mockReset();
  });

  // ----------------------------------------------------------
  // 测试 1: 注册 — 密码 bcrypt 哈希、返回用户信息
  // ----------------------------------------------------------
  describe('register', () => {
    it('should hash password and return user info without passwordHash', async () => {
      // Arrange
      mockPrisma.user.findUnique.mockResolvedValue(null); // 邮箱不存在
      (bcrypt.hash as jest.Mock).mockResolvedValue('hashed_password_123');
      mockPrisma.user.create.mockResolvedValue(buildUser());

      // Act
      const result = await service.register('test@example.com', 'MyPassword123', 'Test User');

      // Assert
      expect(result).toEqual({
        id: 'user-uuid-1',
        email: 'test@example.com',
        name: 'Test User',
        avatar: null,
        phone: null,
        bio: null,
      });
      // 确保不返回 passwordHash
      expect(result).not.toHaveProperty('passwordHash');

      // 验证 bcrypt.hash 被调用
      expect(bcrypt.hash).toHaveBeenCalledWith('MyPassword123', 10);

      // 验证 prisma.user.create 被调用，且存入的是哈希后的密码
      expect(mockPrisma.user.create).toHaveBeenCalledWith({
        data: {
          email: 'test@example.com',
          passwordHash: 'hashed_password_123',
          name: 'Test User',
        },
      });
    });

    // ----------------------------------------------------------
    // 测试 2: 注册 — name 可选
    // ----------------------------------------------------------
    it('should register without name (optional field)', async () => {
      mockPrisma.user.findUnique.mockResolvedValue(null);
      (bcrypt.hash as jest.Mock).mockResolvedValue('hashed');
      mockPrisma.user.create.mockResolvedValue(
        buildUser({ id: 'user-uuid-2', email: 'noname@example.com', name: null, passwordHash: 'hashed' }),
      );

      const result = await service.register('noname@example.com', 'Password123');

      expect(result.id).toBe('user-uuid-2');
      expect(result.name).toBeNull();
    });

    // ----------------------------------------------------------
    // 测试 3: 邮箱已存在 — 注册失败抛 ConflictException
    // ----------------------------------------------------------
    it('should throw ConflictException when email already exists', async () => {
      mockPrisma.user.findUnique.mockResolvedValue(
        buildUser({ id: 'existing-user', email: 'taken@example.com', passwordHash: 'existing_hash' }),
      );

      await expect(
        service.register('taken@example.com', 'Password123'),
      ).rejects.toThrow(ConflictException);

      // 不应调用 create
      expect(mockPrisma.user.create).not.toHaveBeenCalled();
      // 不应调用 bcrypt.hash
      expect(bcrypt.hash).not.toHaveBeenCalled();
    });
  });

  // ----------------------------------------------------------
  // 测试 4: 登录 — 验证密码、签发 JWT
  // ----------------------------------------------------------
  describe('login', () => {
    it('should verify password and return JWT accessToken', async () => {
      // Arrange
      mockPrisma.user.findUnique.mockResolvedValue(buildUser());
      (bcrypt.compare as jest.Mock).mockResolvedValue(true);
      mockJwtService.signAsync.mockResolvedValue('jwt_token_abc');

      // Act
      const result = await service.login('test@example.com', 'MyPassword123');

      // Assert
      expect(result.accessToken).toBe('jwt_token_abc');
      expect(result.user).toEqual({
        id: 'user-uuid-1',
        email: 'test@example.com',
        name: 'Test User',
        avatar: null,
        phone: null,
        bio: null,
      });

      // 验证 bcrypt.compare 被调用
      expect(bcrypt.compare).toHaveBeenCalledWith('MyPassword123', 'hashed_password_123');

      // 验证 JWT 签发时传入了正确的 payload
      expect(mockJwtService.signAsync).toHaveBeenCalledWith({
        sub: 'user-uuid-1',
        email: 'test@example.com',
      });
    });

    // ----------------------------------------------------------
    // 测试 5: 登录 — 密码错误抛 UnauthorizedException
    // ----------------------------------------------------------
    it('should throw UnauthorizedException when password is wrong', async () => {
      mockPrisma.user.findUnique.mockResolvedValue(buildUser());
      (bcrypt.compare as jest.Mock).mockResolvedValue(false);

      await expect(
        service.login('test@example.com', 'WrongPassword'),
      ).rejects.toThrow(UnauthorizedException);

      // 不应签发 JWT
      expect(mockJwtService.signAsync).not.toHaveBeenCalled();
    });

    // ----------------------------------------------------------
    // 测试 6: 登录 — 用户不存在抛 UnauthorizedException
    // ----------------------------------------------------------
    it('should throw UnauthorizedException when user does not exist', async () => {
      mockPrisma.user.findUnique.mockResolvedValue(null);

      await expect(
        service.login('nobody@example.com', 'password'),
      ).rejects.toThrow(UnauthorizedException);

      // 不应调用 bcrypt.compare
      expect(bcrypt.compare).not.toHaveBeenCalled();
      // 不应签发 JWT
      expect(mockJwtService.signAsync).not.toHaveBeenCalled();
    });
  });

  // ----------------------------------------------------------
  // 测试 7: 获取用户信息
  // ----------------------------------------------------------
  describe('getProfile', () => {
    it('should return user info without passwordHash', async () => {
      mockPrisma.user.findUnique.mockResolvedValue(
        buildUser({ passwordHash: 'secret_hash', avatar: 'https://cdn.example.com/a.png', phone: '13800138000', bio: '长期投资' }),
      );

      const result = await service.getProfile('user-uuid-1');

      expect(result).toEqual({
        id: 'user-uuid-1',
        email: 'test@example.com',
        name: 'Test User',
        avatar: 'https://cdn.example.com/a.png',
        phone: '13800138000',
        bio: '长期投资',
      });
      expect(result).not.toHaveProperty('passwordHash');

      // 验证按 id 查询
      expect(mockPrisma.user.findUnique).toHaveBeenCalledWith({
        where: { id: 'user-uuid-1' },
      });
    });

    it('should throw UnauthorizedException when user not found', async () => {
      mockPrisma.user.findUnique.mockResolvedValue(null);

      await expect(
        service.getProfile('nonexistent-user'),
      ).rejects.toThrow(UnauthorizedException);
    });
  });

  // ----------------------------------------------------------
  // 测试 8: 修改密码
  // ----------------------------------------------------------
  describe('updatePassword', () => {
    it('should throw BadRequest with code 1004 when current password is wrong', async () => {
      mockPrisma.user.findUnique.mockResolvedValue(buildUser());
      (bcrypt.compare as jest.Mock).mockResolvedValue(false);

      // 必须是 400 而非 401（401 会被前端拦截器判定为登录失效并踢出登录）
      try {
        await service.updatePassword('user-uuid-1', {
          currentPassword: 'WrongPassword1',
          newPassword: 'NewPassword123',
        });
        throw new Error('should not reach here');
      } catch (err) {
        const exception = err as BadRequestException;
        expect(exception).toBeInstanceOf(BadRequestException);
        expect(exception.getStatus()).toBe(400);
        // 显式反证：绝不能是 401，否则前端拦截器会清 token 并跳登录页
        expect(exception).not.toBeInstanceOf(UnauthorizedException);
        expect(exception.getStatus()).not.toBe(401);
        expect(exception.getResponse()).toEqual({
          code: 1004,
          message: '当前密码错误',
        });
      }

      expect(mockPrisma.user.update).not.toHaveBeenCalled();
    });

    it('should throw BadRequest with code 2000 when new password equals current', async () => {
      mockPrisma.user.findUnique.mockResolvedValue(buildUser());
      (bcrypt.compare as jest.Mock).mockResolvedValue(true);

      try {
        await service.updatePassword('user-uuid-1', {
          currentPassword: 'SamePassword1',
          newPassword: 'SamePassword1',
        });
        throw new Error('should not reach here');
      } catch (err) {
        const exception = err as BadRequestException;
        expect(exception).toBeInstanceOf(BadRequestException);
        expect(exception.getResponse()).toEqual({
          code: 2000,
          message: '新密码不能与当前密码相同',
        });
      }

      expect(mockPrisma.user.update).not.toHaveBeenCalled();
      expect(bcrypt.hash).not.toHaveBeenCalled();
    });

    it('should hash new password, persist it and return a fresh accessToken', async () => {
      mockPrisma.user.findUnique.mockResolvedValue(buildUser());
      (bcrypt.compare as jest.Mock).mockResolvedValue(true);
      (bcrypt.hash as jest.Mock).mockResolvedValue('new_hashed_password');
      mockPrisma.user.update.mockResolvedValue(
        buildUser({ passwordHash: 'new_hashed_password' }),
      );
      mockJwtService.signAsync.mockResolvedValue('jwt_token_new');

      const result = await service.updatePassword('user-uuid-1', {
        currentPassword: 'OldPassword1',
        newPassword: 'NewPassword123',
      });

      expect(bcrypt.hash).toHaveBeenCalledWith('NewPassword123', 10);
      expect(mockPrisma.user.update).toHaveBeenCalledWith({
        where: { id: 'user-uuid-1' },
        data: { passwordHash: 'new_hashed_password' },
      });
      expect(result.accessToken).toBe('jwt_token_new');
      expect(result.user).toEqual({
        id: 'user-uuid-1',
        email: 'test@example.com',
        name: 'Test User',
        avatar: null,
        phone: null,
        bio: null,
      });
    });
  });

  // ----------------------------------------------------------
  // 测试 9: 修改邮箱
  // ----------------------------------------------------------
  describe('updateEmail', () => {
    it('should throw BadRequest with code 1004 when current password is wrong', async () => {
      mockPrisma.user.findUnique.mockResolvedValue(buildUser());
      (bcrypt.compare as jest.Mock).mockResolvedValue(false);

      try {
        await service.updateEmail('user-uuid-1', {
          currentPassword: 'WrongPassword1',
          newEmail: 'new@example.com',
        });
        throw new Error('should not reach here');
      } catch (err) {
        const exception = err as BadRequestException;
        expect(exception).toBeInstanceOf(BadRequestException);
        expect(exception.getStatus()).toBe(400);
        // 显式反证：绝不能是 401
        expect(exception).not.toBeInstanceOf(UnauthorizedException);
        expect(exception.getStatus()).not.toBe(401);
        expect(exception.getResponse()).toEqual({
          code: 1004,
          message: '当前密码错误',
        });
      }

      expect(mockPrisma.user.update).not.toHaveBeenCalled();
    });

    it('should throw BadRequest with code 2000 when new email equals current', async () => {
      mockPrisma.user.findUnique.mockResolvedValue(buildUser());
      (bcrypt.compare as jest.Mock).mockResolvedValue(true);

      try {
        await service.updateEmail('user-uuid-1', {
          currentPassword: 'Password123',
          newEmail: 'test@example.com',
        });
        throw new Error('should not reach here');
      } catch (err) {
        const exception = err as BadRequestException;
        expect(exception).toBeInstanceOf(BadRequestException);
        expect(exception.getResponse()).toEqual({
          code: 2000,
          message: '新邮箱与当前邮箱相同',
        });
      }

      expect(mockPrisma.user.update).not.toHaveBeenCalled();
    });

    it('should throw ConflictException when new email is already taken', async () => {
      // 第 1 次 findUnique = 查当前用户；第 2 次 = 查新邮箱是否被占用
      mockPrisma.user.findUnique
        .mockResolvedValueOnce(buildUser())
        .mockResolvedValueOnce(buildUser({ id: 'other-user', email: 'taken@example.com' }));
      (bcrypt.compare as jest.Mock).mockResolvedValue(true);

      await expect(
        service.updateEmail('user-uuid-1', {
          currentPassword: 'Password123',
          newEmail: 'taken@example.com',
        }),
      ).rejects.toThrow(ConflictException);

      expect(mockPrisma.user.update).not.toHaveBeenCalled();
    });

    it('should persist new email and re-sign token with updated email payload', async () => {
      mockPrisma.user.findUnique
        .mockResolvedValueOnce(buildUser())
        .mockResolvedValueOnce(null); // 新邮箱未被占用
      (bcrypt.compare as jest.Mock).mockResolvedValue(true);
      mockPrisma.user.update.mockResolvedValue(
        buildUser({ email: 'new@example.com' }),
      );
      mockJwtService.signAsync.mockResolvedValue('jwt_token_new_email');

      const result = await service.updateEmail('user-uuid-1', {
        currentPassword: 'Password123',
        newEmail: 'new@example.com',
      });

      expect(mockPrisma.user.update).toHaveBeenCalledWith({
        where: { id: 'user-uuid-1' },
        data: { email: 'new@example.com' },
      });
      // 新 token 的 payload.email 必须是新邮箱
      expect(mockJwtService.signAsync).toHaveBeenCalledWith({
        sub: 'user-uuid-1',
        email: 'new@example.com',
      });
      expect(result.accessToken).toBe('jwt_token_new_email');
      expect(result.user.email).toBe('new@example.com');
    });
  });

  // ----------------------------------------------------------
  // 测试 10: 修改个人资料
  // ----------------------------------------------------------
  describe('updateProfile', () => {
    it('should only update provided fields and never touch email / passwordHash', async () => {
      mockPrisma.user.update.mockResolvedValue(
        buildUser({ name: '新昵称', bio: '价值投资' }),
      );

      const result = await service.updateProfile('user-uuid-1', {
        name: '新昵称',
        bio: '价值投资',
      });

      expect(mockPrisma.user.update).toHaveBeenCalledWith({
        where: { id: 'user-uuid-1' },
        data: { name: '新昵称', bio: '价值投资' },
      });

      const updateArg = mockPrisma.user.update.mock.calls[0][0];
      expect(updateArg.data).not.toHaveProperty('email');
      expect(updateArg.data).not.toHaveProperty('passwordHash');
      // 未传的字段不应出现在 data 中
      expect(updateArg.data).not.toHaveProperty('avatar');
      expect(updateArg.data).not.toHaveProperty('phone');

      expect(result).toEqual({
        id: 'user-uuid-1',
        email: 'test@example.com',
        name: '新昵称',
        avatar: null,
        phone: null,
        bio: '价值投资',
      });
    });

    it('should convert empty string to null (clear semantics)', async () => {
      mockPrisma.user.update.mockResolvedValue(buildUser({ name: null, avatar: null, phone: null, bio: null }));

      await service.updateProfile('user-uuid-1', {
        name: '',
        avatar: '',
        phone: '',
        bio: '',
      });

      expect(mockPrisma.user.update).toHaveBeenCalledWith({
        where: { id: 'user-uuid-1' },
        data: { name: null, avatar: null, phone: null, bio: null },
      });
    });

    it('should fall back to getProfile when no field is provided', async () => {
      mockPrisma.user.findUnique.mockResolvedValue(buildUser());

      const result = await service.updateProfile('user-uuid-1', {});

      expect(mockPrisma.user.update).not.toHaveBeenCalled();
      expect(mockPrisma.user.findUnique).toHaveBeenCalledWith({
        where: { id: 'user-uuid-1' },
      });
      expect(result.id).toBe('user-uuid-1');
    });

    // ------------------------------------------------------
    // 补充：显式 null 也代表「清空」
    // ------------------------------------------------------
    it('should treat explicit null as clear semantics', async () => {
      mockPrisma.user.update.mockResolvedValue(
        buildUser({ avatar: null, phone: null, bio: null }),
      );

      await service.updateProfile('user-uuid-1', {
        avatar: null,
        phone: null,
        bio: null,
      });

      expect(mockPrisma.user.update).toHaveBeenCalledWith({
        where: { id: 'user-uuid-1' },
        data: { avatar: null, phone: null, bio: null },
      });
      // name 未传 → 不参与更新
      expect(mockPrisma.user.update.mock.calls[0][0].data).not.toHaveProperty('name');
    });

    // ------------------------------------------------------
    // 补充：任何入参组合下 data 都不得含 email / passwordHash
    // ------------------------------------------------------
    it.each([
      ['仅昵称', { name: '张三' }],
      ['清空全部', { name: '', avatar: '', phone: '', bio: '' }],
      ['混合三态', { name: '李四', avatar: null, bio: '价值投资' }],
    ])(
      'should never write email / passwordHash — case: %s',
      async (_label, dto) => {
        mockPrisma.user.update.mockResolvedValue(buildUser());

        await service.updateProfile('user-uuid-1', dto);

        const { data } = mockPrisma.user.update.mock.calls[0][0];
        expect(data).not.toHaveProperty('email');
        expect(data).not.toHaveProperty('passwordHash');
        expect(data).not.toHaveProperty('id');
      },
    );

    // ------------------------------------------------------
    // 补充：返回体必须是完整 UserPublic（6 个字段，且不含敏感字段）
    // ------------------------------------------------------
    it('should return a complete UserPublic with exactly 6 fields', async () => {
      mockPrisma.user.update.mockResolvedValue(
        buildUser({ avatar: 'https://cdn.example.com/a.png', phone: '13800138000', bio: 'hi' }),
      );

      const result = await service.updateProfile('user-uuid-1', { bio: 'hi' });

      expect(Object.keys(result).sort()).toEqual(USER_PUBLIC_KEYS);
      expect(result).not.toHaveProperty('passwordHash');
      expect(result).not.toHaveProperty('createdAt');
    });
  });

  // ----------------------------------------------------------
  // 测试 11: 错误码信封映射 —— 经全局 HttpExceptionFilter 后前端真正收到什么
  //
  // 这是本次增量最关键的正确性点（RG-04）：
  // 「当前密码错误」必须是 400 + 1004，一旦变成 401 / 1001，
  // 前端 api-client 拦截器会清 token 并跳登录页，用户被踢下线。
  // ----------------------------------------------------------
  describe('错误码信封映射（HttpExceptionFilter）', () => {
    /** api-client.ts 中会触发「清 token + 跳登录」的业务码 */
    const UNAUTH_CODES = [1001, 1002];

    it('updatePassword 当前密码错误 → HTTP 400 + code 1004（绝不 401/1001）', async () => {
      mockPrisma.user.findUnique.mockResolvedValue(buildUser());
      (bcrypt.compare as jest.Mock).mockResolvedValue(false);

      const res = await captureRejection(
        service.updatePassword('user-uuid-1', {
          currentPassword: 'WrongPassword1',
          newPassword: 'NewPassword123',
        }),
      );

      expect(res.status).toBe(400);
      expect(res.body).toEqual({
        code: 1004,
        data: null,
        message: '当前密码错误',
      });
      // 反证：不能落入前端的「登录失效」分支
      expect(res.status).not.toBe(401);
      expect(UNAUTH_CODES).not.toContain(res.body.code);
    });

    it('updateEmail 当前密码错误 → HTTP 400 + code 1004（绝不 401/1001）', async () => {
      mockPrisma.user.findUnique.mockResolvedValue(buildUser());
      (bcrypt.compare as jest.Mock).mockResolvedValue(false);

      const res = await captureRejection(
        service.updateEmail('user-uuid-1', {
          currentPassword: 'WrongPassword1',
          newEmail: 'new@example.com',
        }),
      );

      expect(res.status).toBe(400);
      expect(res.body).toEqual({
        code: 1004,
        data: null,
        message: '当前密码错误',
      });
      expect(res.status).not.toBe(401);
      expect(UNAUTH_CODES).not.toContain(res.body.code);
    });

    it('updateEmail 新邮箱被占用 → HTTP 409 + code 1003', async () => {
      mockPrisma.user.findUnique
        .mockResolvedValueOnce(buildUser())
        .mockResolvedValueOnce(buildUser({ id: 'other-user', email: 'taken@example.com' }));
      (bcrypt.compare as jest.Mock).mockResolvedValue(true);

      const res = await captureRejection(
        service.updateEmail('user-uuid-1', {
          currentPassword: 'Password123',
          newEmail: 'taken@example.com',
        }),
      );

      expect(res.status).toBe(409);
      expect(res.body.code).toBe(1003);
      expect(res.body.data).toBeNull();
      expect(res.body.message).toBe('该邮箱已被注册');
    });

    it('updateEmail 新邮箱与当前相同 → HTTP 400 + code 2000', async () => {
      mockPrisma.user.findUnique.mockResolvedValue(buildUser());
      (bcrypt.compare as jest.Mock).mockResolvedValue(true);

      const res = await captureRejection(
        service.updateEmail('user-uuid-1', {
          currentPassword: 'Password123',
          newEmail: 'test@example.com',
        }),
      );

      expect(res.status).toBe(400);
      expect(res.body).toEqual({
        code: 2000,
        data: null,
        message: '新邮箱与当前邮箱相同',
      });
    });

    it('updatePassword 新旧密码相同 → HTTP 400 + code 2000', async () => {
      mockPrisma.user.findUnique.mockResolvedValue(buildUser());
      (bcrypt.compare as jest.Mock).mockResolvedValue(true);

      const res = await captureRejection(
        service.updatePassword('user-uuid-1', {
          currentPassword: 'SamePassword1',
          newPassword: 'SamePassword1',
        }),
      );

      expect(res.status).toBe(400);
      expect(res.body).toEqual({
        code: 2000,
        data: null,
        message: '新密码不能与当前密码相同',
      });
    });

    it('用户不存在 → HTTP 401 + code 1001（此处 401 才是正确语义）', async () => {
      mockPrisma.user.findUnique.mockResolvedValue(null);

      const res = await captureRejection(
        service.updatePassword('ghost-user', {
          currentPassword: 'Password123',
          newPassword: 'NewPassword123',
        }),
      );

      expect(res.status).toBe(401);
      expect(res.body.code).toBe(1001);
      // 用户都没了，此时不应再去校验密码
      expect(bcrypt.compare).not.toHaveBeenCalled();
    });
  });

  // ----------------------------------------------------------
  // 测试 12: 改密码闭环 —— 新密码可登录、旧密码失败
  //
  // 用「可逆的假 bcrypt」+「有状态的假 prisma」串起
  // updatePassword → login 的完整链路，验证新哈希确实落库并生效。
  // ----------------------------------------------------------
  describe('改密码闭环（updatePassword → login）', () => {
    /** 可逆的假哈希：hash(p) = 'bcrypt$'+p，compare 反向校验 */
    function useReversibleBcrypt(): void {
      (bcrypt.hash as jest.Mock).mockImplementation(
        async (plain: string) => `bcrypt$${plain}`,
      );
      (bcrypt.compare as jest.Mock).mockImplementation(
        async (plain: string, hash: string) => hash === `bcrypt$${plain}`,
      );
    }

    /** 有状态的假 prisma：update 真的会改写内存中的用户记录 */
    function useStatefulPrisma(initialPassword: string) {
      const stored = buildUser({ passwordHash: `bcrypt$${initialPassword}` });
      mockPrisma.user.findUnique.mockImplementation(
        async ({ where }: { where: { id?: string; email?: string } }) => {
          if (where.id) return where.id === stored.id ? { ...stored } : null;
          if (where.email) return where.email === stored.email ? { ...stored } : null;
          return null;
        },
      );
      mockPrisma.user.update.mockImplementation(
        async ({ data }: { data: Record<string, unknown> }) => {
          Object.assign(stored, data);
          return { ...stored };
        },
      );
      return stored;
    }

    it('改密成功后：新密码可登录，旧密码被拒', async () => {
      const stored = useStatefulPrisma('OldPassword1');
      useReversibleBcrypt();
      mockJwtService.signAsync.mockResolvedValue('jwt_token');

      // Act — 改密码
      const changed = await service.updatePassword(stored.id, {
        currentPassword: 'OldPassword1',
        newPassword: 'NewPassword123',
      });

      // Assert — 返回新 token + 完整 UserPublic
      expect(changed.accessToken).toBe('jwt_token');
      expect(Object.keys(changed.user).sort()).toEqual(USER_PUBLIC_KEYS);
      // 新哈希已落库
      expect(stored.passwordHash).toBe('bcrypt$NewPassword123');

      // Assert — 新密码可登录
      await expect(
        service.login(stored.email, 'NewPassword123'),
      ).resolves.toMatchObject({ accessToken: 'jwt_token' });

      // Assert — 旧密码失败
      await expect(
        service.login(stored.email, 'OldPassword1'),
      ).rejects.toThrow(UnauthorizedException);
    });

    it('当前密码错误时不得改写 passwordHash', async () => {
      const stored = useStatefulPrisma('OldPassword1');
      useReversibleBcrypt();

      await expect(
        service.updatePassword(stored.id, {
          currentPassword: 'TotallyWrong1',
          newPassword: 'NewPassword123',
        }),
      ).rejects.toThrow(BadRequestException);

      expect(stored.passwordHash).toBe('bcrypt$OldPassword1');
      expect(mockPrisma.user.update).not.toHaveBeenCalled();
    });
  });

  // ----------------------------------------------------------
  // 测试 13: UserPublic 契约（RG-02 / AC-02）
  //
  // register / login / getProfile 三个既有接口的响应体必须
  // 追加 avatar / phone / bio 三个键（值可为 null），
  // 且不得多出 passwordHash 等敏感字段。
  // ----------------------------------------------------------
  describe('UserPublic 契约：avatar / phone / bio', () => {
    it('register 返回体包含 avatar / phone / bio（新用户为 null）', async () => {
      mockPrisma.user.findUnique.mockResolvedValue(null);
      (bcrypt.hash as jest.Mock).mockResolvedValue('hashed');
      mockPrisma.user.create.mockResolvedValue(buildUser({ passwordHash: 'hashed' }));

      const result = await service.register('test@example.com', 'Password123');

      expect(Object.keys(result).sort()).toEqual(USER_PUBLIC_KEYS);
      expect(result).toHaveProperty('avatar', null);
      expect(result).toHaveProperty('phone', null);
      expect(result).toHaveProperty('bio', null);
    });

    it('login 返回体包含 avatar / phone / bio（有值时原样透传）', async () => {
      mockPrisma.user.findUnique.mockResolvedValue(
        buildUser({
          avatar: 'https://cdn.example.com/a.png',
          phone: '13800138000',
          bio: '长期投资',
        }),
      );
      (bcrypt.compare as jest.Mock).mockResolvedValue(true);
      mockJwtService.signAsync.mockResolvedValue('jwt_token');

      const { user } = await service.login('test@example.com', 'Password123');

      expect(Object.keys(user).sort()).toEqual(USER_PUBLIC_KEYS);
      expect(user.avatar).toBe('https://cdn.example.com/a.png');
      expect(user.phone).toBe('13800138000');
      expect(user.bio).toBe('长期投资');
      expect(user).not.toHaveProperty('passwordHash');
    });

    it('getProfile 返回体包含 avatar / phone / bio（存量用户为 null）', async () => {
      mockPrisma.user.findUnique.mockResolvedValue(buildUser());

      const result = await service.getProfile('user-uuid-1');

      expect(Object.keys(result).sort()).toEqual(USER_PUBLIC_KEYS);
      expect(result.avatar).toBeNull();
      expect(result.phone).toBeNull();
      expect(result.bio).toBeNull();
    });

    it('updateEmail 返回体同样是完整 UserPublic', async () => {
      mockPrisma.user.findUnique
        .mockResolvedValueOnce(buildUser())
        .mockResolvedValueOnce(null);
      (bcrypt.compare as jest.Mock).mockResolvedValue(true);
      mockPrisma.user.update.mockResolvedValue(buildUser({ email: 'new@example.com' }));
      mockJwtService.signAsync.mockResolvedValue('jwt_token');

      const { user } = await service.updateEmail('user-uuid-1', {
        currentPassword: 'Password123',
        newEmail: 'new@example.com',
      });

      expect(Object.keys(user).sort()).toEqual(USER_PUBLIC_KEYS);
      expect(user).not.toHaveProperty('passwordHash');
    });
  });

  // ----------------------------------------------------------
  // 测试 13: 注销冷静期与自助恢复（SYS-P1-02 / PRD §6.10.1 ③）
  //
  // 断言的都是「经全局过滤器后前端真正收到的信封」，而不仅仅是异常类型 ——
  // 因为本功能的正确性恰恰取决于 HTTP 状态码 + code + data 三者的组合：
  //   · 冷静期信号必须是 409/1007（不能是 401，否则被前端拦截器当失效踢走）
  //   · remainingDays 必须真的透传到 data（过滤器原先写死 null）
  // ----------------------------------------------------------
  describe('注销冷静期与自助恢复（SYS-P1-02）', () => {
    /** api-client.ts 中会触发「清 token + 跳登录」的业务码 */
    const UNAUTH_CODES = [1001, 1002];

    /** 冷静期剩余天数（1007 的 data 形状） */
    interface PendingData {
      remainingDays: number;
    }

    // ========== login 分支 ==========

    describe('login', () => {
      it('① 邮箱不存在 → 401 + 1001（不查密码、不签 token）', async () => {
        mockPrisma.user.findUnique.mockResolvedValue(null);

        const res = await captureRejection(
          service.login('nobody@example.com', 'Password123'),
        );

        expect(res.status).toBe(401);
        expect(res.body).toEqual({
          code: 1001,
          data: null,
          message: '邮箱或密码错误',
        });
        expect(bcrypt.compare).not.toHaveBeenCalled();
        expect(mockJwtService.signAsync).not.toHaveBeenCalled();
      });

      it('② 密码错误且账户确在冷静期 → 仍是 401 + 1001（绝不泄露冷静期）', async () => {
        mockPrisma.user.findUnique.mockResolvedValue(buildDeletedUser(3));
        (bcrypt.compare as jest.Mock).mockResolvedValue(false);

        const res = await captureRejection(
          service.login('test@example.com', 'WrongPassword'),
        );

        expect(res.status).toBe(401);
        expect(res.body.code).toBe(1001);
        expect(res.body.message).toBe('邮箱或密码错误');
        // 反证：不得出现冷静期业务码或任何剩余天数线索
        expect(res.body.code).not.toBe(1007);
        expect(res.body.data).toBeNull();
        expect(mockJwtService.signAsync).not.toHaveBeenCalled();
      });

      it('⑤ 正常账户 + 密码正确 → 登录成功并签发 token', async () => {
        mockPrisma.user.findUnique.mockResolvedValue(buildUser());
        (bcrypt.compare as jest.Mock).mockResolvedValue(true);
        mockJwtService.signAsync.mockResolvedValue('jwt_ok');

        const result = await service.login('test@example.com', 'Password123');

        expect(result.accessToken).toBe('jwt_ok');
        expect(Object.keys(result.user).sort()).toEqual(USER_PUBLIC_KEYS);
      });

      it('③ 软删 + 密码正确 + 刚注销（0 天）→ 409 + 1007 + remainingDays=30', async () => {
        mockPrisma.user.findUnique.mockResolvedValue(buildDeletedUser(0));
        (bcrypt.compare as jest.Mock).mockResolvedValue(true);

        const res = await captureRejection(
          service.login('test@example.com', 'Password123'),
        );

        expect(res.status).toBe(409);
        expect(res.body.code).toBe(1007);
        expect((res.body.data as PendingData).remainingDays).toBe(30);
        expect(res.body.message).toBe('账户处于注销冷静期，请在登录页恢复');
        // 反证：绝不能落进前端的「登录已失效」分支
        expect(res.status).not.toBe(401);
        expect(UNAUTH_CODES).not.toContain(res.body.code);
        // 冷静期只是信号，不得签发 token
        expect(mockJwtService.signAsync).not.toHaveBeenCalled();
      });

      it('③ 边界：已过 29.5 天 → 仍是 1007，剩余天数向上取整为 1', async () => {
        mockPrisma.user.findUnique.mockResolvedValue(buildDeletedUser(29.5));
        (bcrypt.compare as jest.Mock).mockResolvedValue(true);

        const res = await captureRejection(
          service.login('test@example.com', 'Password123'),
        );

        expect(res.status).toBe(409);
        expect(res.body.code).toBe(1007);
        expect((res.body.data as PendingData).remainingDays).toBe(1);
      });

      it('④ 边界：整 30 天（保留期届满）→ 退回 401 + 1001 通用文案', async () => {
        // 记录仍在库中（CleanupService 尚未跑批），但按 now - deletedAt 独立判定已到期
        mockPrisma.user.findUnique.mockResolvedValue(buildDeletedUser(30));
        (bcrypt.compare as jest.Mock).mockResolvedValue(true);

        const res = await captureRejection(
          service.login('test@example.com', 'Password123'),
        );

        expect(res.status).toBe(401);
        expect(res.body.code).toBe(1001);
        expect(res.body.data).toBeNull();
        expect(mockJwtService.signAsync).not.toHaveBeenCalled();
      });

      it('④ 超期更久（45 天，跑批未执行）→ 同样是 401 + 1001', async () => {
        mockPrisma.user.findUnique.mockResolvedValue(buildDeletedUser(45));
        (bcrypt.compare as jest.Mock).mockResolvedValue(true);

        const res = await captureRejection(
          service.login('test@example.com', 'Password123'),
        );

        expect(res.status).toBe(401);
        expect(res.body.code).toBe(1001);
      });
    });

    // ========== restoreAccount 分支 ==========

    describe('restoreAccount', () => {
      it('① 邮箱不存在（含已硬删）→ 401 + 1001，不查密码', async () => {
        mockPrisma.user.findUnique.mockResolvedValue(null);

        const res = await captureRejection(
          service.restoreAccount('ghost@example.com', 'Password123'),
        );

        expect(res.status).toBe(401);
        expect(res.body).toEqual({
          code: 1001,
          data: null,
          message: '邮箱或密码错误',
        });
        expect(bcrypt.compare).not.toHaveBeenCalled();
        expect(mockPrisma.user.update).not.toHaveBeenCalled();
      });

      it('② 密码错误（账户确在冷静期）→ 401 + 1001，不得提示可恢复', async () => {
        mockPrisma.user.findUnique.mockResolvedValue(buildDeletedUser(5));
        (bcrypt.compare as jest.Mock).mockResolvedValue(false);

        const res = await captureRejection(
          service.restoreAccount('test@example.com', 'WrongPassword'),
        );

        expect(res.status).toBe(401);
        expect(res.body.code).toBe(1001);
        expect(res.body.data).toBeNull();
        expect(mockPrisma.user.update).not.toHaveBeenCalled();
      });

      it('③ 账户未注销（deletedAt=null）→ 409 + 1008，恢复不得成为登录后门', async () => {
        mockPrisma.user.findUnique.mockResolvedValue(buildUser());
        (bcrypt.compare as jest.Mock).mockResolvedValue(true);

        const res = await captureRejection(
          service.restoreAccount('test@example.com', 'Password123'),
        );

        expect(res.status).toBe(409);
        expect(res.body).toEqual({
          code: 1008,
          data: null,
          message: '该账户无需恢复，请直接登录',
        });
        // 未注销的账户绝不能借 restore 拿到 token
        expect(mockPrisma.user.update).not.toHaveBeenCalled();
        expect(mockJwtService.signAsync).not.toHaveBeenCalled();
      });

      it('④ 软删已满 30 天 → 410 + 1009，且不得清空 deletedAt', async () => {
        mockPrisma.user.findUnique.mockResolvedValue(buildDeletedUser(30));
        (bcrypt.compare as jest.Mock).mockResolvedValue(true);

        const res = await captureRejection(
          service.restoreAccount('test@example.com', 'Password123'),
        );

        expect(res.status).toBe(410);
        expect(res.body).toEqual({
          code: 1009,
          data: null,
          message: '恢复期已过，账户数据已不可找回',
        });
        expect(mockPrisma.user.update).not.toHaveBeenCalled();
      });

      it('⑤ 冷静期内 + 密码正确 → 清空 deletedAt 并返回新 token', async () => {
        mockPrisma.user.findUnique.mockResolvedValue(buildDeletedUser(10));
        (bcrypt.compare as jest.Mock).mockResolvedValue(true);
        mockPrisma.user.update.mockResolvedValue(buildUser());
        mockJwtService.signAsync.mockResolvedValue('jwt_restored');

        const result = await service.restoreAccount('test@example.com', 'Password123');

        // 只清 deletedAt，其他字段一律不动
        expect(mockPrisma.user.update).toHaveBeenCalledWith({
          where: { id: 'user-uuid-1' },
          data: { deletedAt: null },
        });
        expect(result.accessToken).toBe('jwt_restored');
        expect(Object.keys(result.user).sort()).toEqual(USER_PUBLIC_KEYS);
        expect(result.user).not.toHaveProperty('passwordHash');
      });

      it('⑤ 边界：刚过 29.5 天仍可恢复（未到 30 天整）', async () => {
        mockPrisma.user.findUnique.mockResolvedValue(buildDeletedUser(29.5));
        (bcrypt.compare as jest.Mock).mockResolvedValue(true);
        mockPrisma.user.update.mockResolvedValue(buildUser());
        mockJwtService.signAsync.mockResolvedValue('jwt_restored');

        await expect(
          service.restoreAccount('test@example.com', 'Password123'),
        ).resolves.toMatchObject({ accessToken: 'jwt_restored' });
      });

      it('恢复后即可正常登录（闭环：restore → login）', async () => {
        const stored = buildDeletedUser(10);
        mockPrisma.user.findUnique.mockImplementation(async () => ({ ...stored }));
        mockPrisma.user.update.mockImplementation(
          async ({ data }: { data: Record<string, unknown> }) => {
            Object.assign(stored, data);
            return { ...stored };
          },
        );
        (bcrypt.compare as jest.Mock).mockResolvedValue(true);
        mockJwtService.signAsync.mockResolvedValue('jwt_token');

        await service.restoreAccount(stored.email, 'Password123');
        expect(stored.deletedAt).toBeNull();

        // 恢复后账户回到正常态，login 不再返回 1007
        await expect(
          service.login(stored.email, 'Password123'),
        ).resolves.toMatchObject({ accessToken: 'jwt_token' });
      });
    });

    // ========== 常量同源 ==========

    it('保留期常量与 shared 同源（30 天）', () => {
      expect(ACCOUNT_RETENTION_MS).toBe(30 * DAY_MS);
    });
  });
});

// ============================================================
// 测试 14: DTO 入参校验（与 main.ts 完全相同的 ValidationPipe 配置）
//
// 这些用例覆盖「请求还没进 service 就该被拦下」的场景：
// - 密码策略：register 与 change-password 必须一致（≥8 位 + 字母 + 数字）
// - login 仍放行存量 6 位密码（本次不改）
// - 清空语义：'' / null 不能被格式校验误伤
// - forbidNonWhitelisted：前端必须剔除 confirmPassword，否则 400
// ============================================================

describe('Auth DTO 校验（ValidationPipe）', () => {
  // 与 packages/backend/src/main.ts 保持一致
  const pipe = new ValidationPipe({
    whitelist: true,
    forbidNonWhitelisted: true,
    transform: true,
    transformOptions: { enableImplicitConversion: true },
  });

  const meta = (metatype: new () => object): ArgumentMetadata => ({
    type: 'body',
    metatype,
    data: '',
  });

  /** 校验通过则返回转换后的对象，失败则抛 BadRequestException */
  const run = (metatype: new () => object, payload: unknown) =>
    pipe.transform(payload, meta(metatype));

  /** 断言校验失败，并返回经全局过滤器后的信封（应为 400 + 2000） */
  async function expectRejected(
    metatype: new () => object,
    payload: unknown,
  ): Promise<CapturedResponse> {
    const res = await captureRejection(run(metatype, payload));
    expect(res.status).toBe(400);
    expect(res.body.code).toBe(2000);
    return res;
  }

  describe('UpdatePasswordDto', () => {
    it('合法入参通过校验', async () => {
      await expect(
        run(UpdatePasswordDto, {
          currentPassword: 'oldpass',
          newPassword: 'NewPass123',
        }),
      ).resolves.toMatchObject({ newPassword: 'NewPass123' });
    });

    it.each([
      ['不足 8 位', 'Ab1'],
      ['仅字母无数字', 'abcdefghij'],
      ['仅数字无字母', '12345678'],
      ['超长（>100）', `A1${'x'.repeat(120)}`],
    ])('新密码「%s」→ 400 + 2000', async (_label, newPassword) => {
      await expectRejected(UpdatePasswordDto, {
        currentPassword: 'oldpass',
        newPassword,
      });
    });

    it('缺少 currentPassword → 400 + 2000', async () => {
      await expectRejected(UpdatePasswordDto, { newPassword: 'NewPass123' });
    });

    // 前端 change-password-dialog.tsx 提交时必须剔除 confirmPassword
    it('混入 confirmPassword → 400 + 2000（forbidNonWhitelisted）', async () => {
      const res = await expectRejected(UpdatePasswordDto, {
        currentPassword: 'oldpass',
        newPassword: 'NewPass123',
        confirmPassword: 'NewPass123',
      });
      expect(res.body.message).toContain('confirmPassword');
    });
  });

  describe('密码策略在 register 与 change-password 之间保持一致', () => {
    it.each([
      ['Ab1', false],
      ['abcdefghij', false],
      ['12345678', false],
      ['Password123', true],
      ['a1234567', true],
    ])('密码 %s 的通过结果在两个 DTO 上一致', async (password, shouldPass) => {
      const registerOk = await run(RegisterDto, {
        email: 'a@example.com',
        password,
      }).then(
        () => true,
        () => false,
      );
      const changeOk = await run(UpdatePasswordDto, {
        currentPassword: 'whatever',
        newPassword: password,
      }).then(
        () => true,
        () => false,
      );

      expect(registerOk).toBe(shouldPass);
      expect(changeOk).toBe(shouldPass);
      expect(registerOk).toBe(changeOk);
    });

    it('login 仍放行存量 6 位弱密码（本次未收紧）', async () => {
      await expect(
        run(LoginDto, { email: 'a@example.com', password: '123456' }),
      ).resolves.toMatchObject({ password: '123456' });
    });
  });

  describe('RestoreAccountDto（SYS-P1-02）', () => {
    it('合法入参通过校验', async () => {
      await expect(
        run(RestoreAccountDto, { email: 'a@example.com', password: 'Password123' }),
      ).resolves.toMatchObject({ email: 'a@example.com', password: 'Password123' });
    });

    // 关键：restore 是「比对」而非「设置」密码，加强度校验会误伤存量弱密码用户，
    // 让他们连恢复账户的机会都没有 —— 口径必须与 login.dto.ts 一致。
    it('放行存量 6 位弱密码（与 login 同口径，不得套用注册强度校验）', async () => {
      await expect(
        run(RestoreAccountDto, { email: 'a@example.com', password: '123456' }),
      ).resolves.toMatchObject({ password: '123456' });
    });

    it.each([
      ['非法邮箱', { email: 'not-an-email', password: 'Password123' }],
      ['缺少邮箱', { password: 'Password123' }],
      ['缺少密码', { email: 'a@example.com' }],
      ['密码为空串', { email: 'a@example.com', password: '' }],
      ['混入未声明字段', { email: 'a@example.com', password: 'p', extra: 'x' }],
    ])('%s → 400 + 2000', async (_label, payload) => {
      await expectRejected(RestoreAccountDto, payload);
    });
  });

  describe('UpdateEmailDto', () => {
    it('合法邮箱通过', async () => {
      await expect(
        run(UpdateEmailDto, {
          currentPassword: 'pass',
          newEmail: 'new@example.com',
        }),
      ).resolves.toMatchObject({ newEmail: 'new@example.com' });
    });

    it.each([['not-an-email'], ['a@'], ['@example.com'], ['']])(
      '非法邮箱 %s → 400 + 2000',
      async (newEmail) => {
        await expectRejected(UpdateEmailDto, {
          currentPassword: 'pass',
          newEmail,
        });
      },
    );

    it('缺少 currentPassword → 400 + 2000', async () => {
      await expectRejected(UpdateEmailDto, { newEmail: 'new@example.com' });
    });
  });

  describe('UpdateProfileDto', () => {
    it('空对象通过（等价于不修改任何字段）', async () => {
      await expect(run(UpdateProfileDto, {})).resolves.toEqual({});
    });

    // 关键：清空语义不能被 @IsUrl / @Matches 误伤
    it('全部传空串通过（清空语义）', async () => {
      await expect(
        run(UpdateProfileDto, { name: '', avatar: '', phone: '', bio: '' }),
      ).resolves.toEqual({ name: '', avatar: '', phone: '', bio: '' });
    });

    it('全部传 null 通过（清空语义）', async () => {
      await expect(
        run(UpdateProfileDto, { name: null, avatar: null, phone: null, bio: null }),
      ).resolves.toEqual({ name: null, avatar: null, phone: null, bio: null });
    });

    it('合法完整资料通过', async () => {
      await expect(
        run(UpdateProfileDto, {
          name: '张三',
          avatar: 'https://cdn.example.com/a.png',
          phone: '13800138000',
          bio: '长期价值投资者',
        }),
      ).resolves.toMatchObject({ phone: '13800138000' });
    });

    it.each([
      ['avatar 非 URL', { avatar: 'not-a-url' }],
      ['avatar 缺协议头', { avatar: 'cdn.example.com/a.png' }],
      ['phone 位数不对', { phone: '12345' }],
      ['phone 首位非 1', { phone: '23800138000' }],
      ['bio 超 200 字', { bio: 'x'.repeat(201) }],
      ['name 超 100 字', { name: 'x'.repeat(101) }],
      ['混入未声明字段 email', { email: 'hack@example.com' }],
      ['混入未声明字段 passwordHash', { passwordHash: 'xxx' }],
    ])('%s → 400 + 2000', async (_label, payload) => {
      await expectRejected(UpdateProfileDto, payload);
    });
  });
});
