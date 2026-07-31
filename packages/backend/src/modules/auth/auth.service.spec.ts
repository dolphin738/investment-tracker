/**
 * 认证服务单元测试
 *
 * 测试 AuthService 的注册、登录、获取信息功能。
 * 通过 mock PrismaService / JwtService / bcrypt 隔离外部依赖。
 *
 * 测试覆盖：
 * 1. 注册：密码 bcrypt 哈希、返回用户信息（不含密码）
 * 2. 登录：验证密码、签发 JWT
 * 3. 邮箱已存在：注册失败抛 ConflictException
 * 4. 登录密码错误：抛 UnauthorizedException
 * 5. 登录用户不存在：抛 UnauthorizedException
 * 6. 获取用户信息
 */

import {
  ConflictException,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { AuthService } from './auth.service';

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
      mockPrisma.user.create.mockResolvedValue({
        id: 'user-uuid-1',
        email: 'test@example.com',
        name: 'Test User',
        passwordHash: 'hashed_password_123',
        createdAt: new Date('2024-01-01'),
        updatedAt: new Date('2024-01-01'),
      });

      // Act
      const result = await service.register('test@example.com', 'MyPassword123', 'Test User');

      // Assert
      expect(result).toEqual({
        id: 'user-uuid-1',
        email: 'test@example.com',
        name: 'Test User',
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
      mockPrisma.user.create.mockResolvedValue({
        id: 'user-uuid-2',
        email: 'noname@example.com',
        name: null,
        passwordHash: 'hashed',
      });

      const result = await service.register('noname@example.com', 'password');

      expect(result.id).toBe('user-uuid-2');
      expect(result.name).toBeNull();
    });

    // ----------------------------------------------------------
    // 测试 3: 邮箱已存在 — 注册失败抛 ConflictException
    // ----------------------------------------------------------
    it('should throw ConflictException when email already exists', async () => {
      mockPrisma.user.findUnique.mockResolvedValue({
        id: 'existing-user',
        email: 'taken@example.com',
        passwordHash: 'existing_hash',
      });

      await expect(
        service.register('taken@example.com', 'password'),
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
      mockPrisma.user.findUnique.mockResolvedValue({
        id: 'user-uuid-1',
        email: 'test@example.com',
        name: 'Test User',
        passwordHash: 'hashed_password_123',
      });
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
      mockPrisma.user.findUnique.mockResolvedValue({
        id: 'user-uuid-1',
        email: 'test@example.com',
        name: 'Test User',
        passwordHash: 'hashed_password_123',
      });
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
      mockPrisma.user.findUnique.mockResolvedValue({
        id: 'user-uuid-1',
        email: 'test@example.com',
        name: 'Test User',
        passwordHash: 'secret_hash',
      });

      const result = await service.getProfile('user-uuid-1');

      expect(result).toEqual({
        id: 'user-uuid-1',
        email: 'test@example.com',
        name: 'Test User',
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
});
