/**
 * HttpExceptionFilter 单元测试 —— 自定义 data 透传（SYS-P1-02）
 *
 * 背景：过滤器原先把 data 硬编码为 null，导致 1007 冷静期信号携带的
 * { remainingDays } 永远到不了前端，登录页无法显示「剩余 X 天」。
 *
 * 本文件锁两件事：
 * 1. 异常自带 data → 响应信封原样透传（非 null）；
 * 2. 异常不带 data → 仍回落 null（防回归，既有错误响应形状不变）。
 */

import 'reflect-metadata';
import {
  BadRequestException,
  ConflictException,
  HttpException,
  HttpStatus,
  UnauthorizedException,
  type ArgumentsHost,
} from '@nestjs/common';
import { HttpExceptionFilter } from './http-exception.filter';
import { AccountPendingDeletionException } from '../../modules/auth/exceptions/account-pending-deletion.exception';

/** 过滤器最终写给客户端的内容 */
interface CapturedResponse {
  status: number;
  body: { code: number; data: unknown; message: string };
}

/** 把异常喂给过滤器，捕获 HTTP 状态码 + 响应信封 */
function runFilter(exception: unknown): CapturedResponse {
  const captured: CapturedResponse = {
    status: 0,
    body: { code: -1, data: undefined, message: '' },
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
      getRequest: () => ({ method: 'POST', url: '/api/auth/login' }),
    }),
  } as unknown as ArgumentsHost;

  new HttpExceptionFilter().catch(exception, host);
  return captured;
}

describe('HttpExceptionFilter', () => {
  describe('自定义 data 透传（SYS-P1-02 核心）', () => {
    it('异常自带 data 时应原样透传，而非被写成 null', () => {
      const res = runFilter(
        new HttpException(
          { code: 1007, message: '账户处于注销冷静期', data: { remainingDays: 23 } },
          HttpStatus.CONFLICT,
        ),
      );

      expect(res.status).toBe(409);
      expect(res.body.code).toBe(1007);
      // 这一行就是本次修复的核心：data 不再是 null
      expect(res.body.data).not.toBeNull();
      expect(res.body.data).toEqual({ remainingDays: 23 });
    });

    it('AccountPendingDeletionException → 409 + 1007 + data.remainingDays', () => {
      const res = runFilter(new AccountPendingDeletionException(7));

      expect(res.status).toBe(409);
      expect(res.body.code).toBe(1007);
      expect(res.body.data).toEqual({ remainingDays: 7 });
      expect(res.body.message).toBe('账户处于注销冷静期，请在登录页恢复');
      // 反证：绝不能是 401，否则前端拦截器会清 token + 跳登录页，信号被吃掉
      expect(res.status).not.toBe(401);
    });

    it('data 为数组 / 原始值时同样透传', () => {
      const res = runFilter(
        new BadRequestException({ code: 2000, message: '校验失败', data: ['a', 'b'] }),
      );

      expect(res.body.data).toEqual(['a', 'b']);
    });
  });

  describe('无 data 时仍回落 null（防回归）', () => {
    it('只带 code / message 的异常 → data 为 null', () => {
      const res = runFilter(
        new BadRequestException({ code: 1004, message: '当前密码错误' }),
      );

      expect(res.status).toBe(400);
      expect(res.body).toEqual({ code: 1004, data: null, message: '当前密码错误' });
    });

    it('字符串型 HttpException（UnauthorizedException）→ 401 + 1001 + data null', () => {
      const res = runFilter(new UnauthorizedException('邮箱或密码错误'));

      expect(res.status).toBe(401);
      expect(res.body).toEqual({ code: 1001, data: null, message: '邮箱或密码错误' });
    });

    it('ConflictException 无自定义 code → 409 映射 1003 + data null', () => {
      const res = runFilter(new ConflictException('邮箱已被注册'));

      expect(res.status).toBe(409);
      expect(res.body).toEqual({ code: 1003, data: null, message: '邮箱已被注册' });
    });

    it('非 HttpException（普通 Error）→ 500 + 5000 + data null', () => {
      const res = runFilter(new Error('boom'));

      expect(res.status).toBe(500);
      expect(res.body).toEqual({ code: 5000, data: null, message: 'boom' });
    });
  });

  describe('自定义 code 与状态码映射', () => {
    it('410 + 自定义 code 1009（未知状态码不影响 code 透传）', () => {
      const res = runFilter(
        new HttpException(
          { code: 1009, message: '恢复期已过，账户数据已不可找回' },
          HttpStatus.GONE,
        ),
      );

      expect(res.status).toBe(410);
      expect(res.body.code).toBe(1009);
      expect(res.body.data).toBeNull();
    });

    it('409 + 自定义 code 1008 覆盖默认的 1003 映射', () => {
      const res = runFilter(
        new HttpException(
          { code: 1008, message: '该账户无需恢复，请直接登录' },
          HttpStatus.CONFLICT,
        ),
      );

      expect(res.status).toBe(409);
      expect(res.body.code).toBe(1008);
      expect(res.body.code).not.toBe(1003);
    });
  });
});
