/**
 * 上传异常过滤器单元测试（M3 核心回归）
 *
 * 背景：upload.service.spec.ts 只覆盖 service 层，而 M3 的关键改写发生在
 * controller/filter 层——multer 的 limits.fileSize 触发 PayloadTooLargeException(413)，
 * 由本过滤器改写成 400 + 1006。这一层此前没有任何测试覆盖，本文件补齐。
 *
 * 验证的四条分支（与 file-upload-exception.filter.ts 的注释一一对应）：
 * 1. 异常自带数字 code → 原样透传（状态码 / code / message 都不变）
 * 2. 401 → 1001、403 → 1002，保留登录态语义，不得被改写成 1006
 * 3. 其余 HttpException（413 / 415 / multer 其它）→ 400 + 1006，按状态码挑文案
 * 4. 非 HttpException 的原始 Error → 保持 500 + 5000，不伪装成用户参数错误
 *
 * 所有断言都走真实的 catch(exception, host)，host 用最小 mock，不启动 Nest 应用。
 */

import {
  BadRequestException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  InternalServerErrorException,
  Logger,
  PayloadTooLargeException,
  UnauthorizedException,
  UnsupportedMediaTypeException,
} from '@nestjs/common';
import type { ArgumentsHost } from '@nestjs/common';
import { FileUploadExceptionFilter } from './file-upload-exception.filter';
import {
  FILE_INVALID_CODE,
  FILE_INVALID_DEFAULT_MESSAGE,
  FILE_SIZE_MESSAGE,
  FILE_TYPE_MESSAGE,
} from '../upload.constants';

// ============================================================
// 辅助构造
// ============================================================

/** 过滤器实际写出的响应内容 */
interface CapturedResponse {
  statusCode: number;
  body: { code: number; data: unknown; message: string };
}

/** express Response 的最小可链式调用子集 */
interface MockResponse {
  status: (code: number) => MockResponse;
  json: (payload: CapturedResponse['body']) => MockResponse;
}

/** 捕获 response.status(x).json(y) 的最小 ArgumentsHost mock */
function createHost(): { host: ArgumentsHost; captured: () => CapturedResponse } {
  let statusCode = -1;
  let body: CapturedResponse['body'] | undefined;

  const response: MockResponse = {
    status: jest.fn((code: number): MockResponse => {
      statusCode = code;
      return response;
    }),
    json: jest.fn((payload: CapturedResponse['body']): MockResponse => {
      body = payload;
      return response;
    }),
  };

  const host = {
    switchToHttp: () => ({
      getResponse: <T>(): T => response as unknown as T,
      getRequest: <T>(): T => ({}) as T,
      getNext: <T>(): T => (() => undefined) as unknown as T,
    }),
  } as unknown as ArgumentsHost;

  return {
    host,
    captured: () => {
      if (body === undefined) {
        throw new Error('过滤器没有调用 response.json()');
      }
      return { statusCode, body };
    },
  };
}

/** 跑一次过滤器，返回它写出的响应 */
function runFilter(filter: FileUploadExceptionFilter, exception: unknown): CapturedResponse {
  const { host, captured } = createHost();
  filter.catch(exception, host);
  return captured();
}

// ============================================================
// 用例
// ============================================================

describe('FileUploadExceptionFilter (M3)', () => {
  let filter: FileUploadExceptionFilter;
  let errorSpy: jest.SpyInstance;
  let warnSpy: jest.SpyInstance;

  beforeEach(() => {
    filter = new FileUploadExceptionFilter();
    // 屏蔽测试输出噪音，同时用于断言「磁盘故障必须落 error 日志」
    errorSpy = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  // ---------- 分支 3：413 超限（M3 最关键路径） ----------

  describe('multer 超限 413 → 400 + 1006', () => {
    it('应把 PayloadTooLargeException 改写为 400 / 1006 / 大小文案', () => {
      // Arrange：模拟 FileInterceptor limits.fileSize 触发后 Nest 抛出的异常
      const exception = new PayloadTooLargeException('File too large');

      // Act
      const res = runFilter(filter, exception);

      // Assert
      expect(res.statusCode).toBe(HttpStatus.BAD_REQUEST);
      expect(res.body).toEqual({
        code: FILE_INVALID_CODE,
        data: null,
        message: FILE_SIZE_MESSAGE,
      });
      expect(res.body.code).toBe(1006);
      expect(res.body.message).toBe('图片大小不能超过 2MB');
      // 收敛动作应留下可观测日志
      expect(warnSpy).toHaveBeenCalled();
    });

    it('415 类型异常应改写为 400 / 1006 / 类型文案', () => {
      const res = runFilter(filter, new UnsupportedMediaTypeException());

      expect(res.statusCode).toBe(HttpStatus.BAD_REQUEST);
      expect(res.body.code).toBe(FILE_INVALID_CODE);
      expect(res.body.message).toBe(FILE_TYPE_MESSAGE);
      expect(res.body.data).toBeNull();
    });

    it('其它无业务码的 HttpException 应落到 1006 默认兜底文案', () => {
      // multer 的 LIMIT_UNEXPECTED_FILE 等会以 400 抛出且不带 code
      const res = runFilter(filter, new BadRequestException('Unexpected field'));

      expect(res.statusCode).toBe(HttpStatus.BAD_REQUEST);
      expect(res.body.code).toBe(FILE_INVALID_CODE);
      expect(res.body.message).toBe(FILE_INVALID_DEFAULT_MESSAGE);
    });

    it('500 级 HttpException 也应收敛为 400 + 1006（不外泄内部错误）', () => {
      const res = runFilter(filter, new InternalServerErrorException('boom'));

      expect(res.statusCode).toBe(HttpStatus.BAD_REQUEST);
      expect(res.body.code).toBe(FILE_INVALID_CODE);
      expect(res.body.message).toBe(FILE_INVALID_DEFAULT_MESSAGE);
    });
  });

  // ---------- 分支 2：登录态语义必须保留 ----------

  describe('登录态异常不得被改写成 1006', () => {
    it('401 应保持 401 且 code=1001', () => {
      const res = runFilter(filter, new UnauthorizedException());

      expect(res.statusCode).toBe(HttpStatus.UNAUTHORIZED);
      expect(res.body.code).toBe(1001);
      expect(res.body.data).toBeNull();
      // 关键回归点：绝不能被 1006 吞掉，否则前端识别不出「登录已失效」
      expect(res.body.code).not.toBe(FILE_INVALID_CODE);
      expect(res.statusCode).not.toBe(HttpStatus.BAD_REQUEST);
    });

    it('401 应保留原始文案', () => {
      const res = runFilter(filter, new UnauthorizedException('登录已失效，请重新登录'));

      expect(res.statusCode).toBe(401);
      expect(res.body.code).toBe(1001);
      expect(res.body.message).toBe('登录已失效，请重新登录');
    });

    it('403 应保持 403 且 code=1002', () => {
      const res = runFilter(filter, new ForbiddenException());

      expect(res.statusCode).toBe(HttpStatus.FORBIDDEN);
      expect(res.body.code).toBe(1002);
      expect(res.body.data).toBeNull();
      expect(res.body.code).not.toBe(FILE_INVALID_CODE);
    });
  });

  // ---------- 分支 1：自带业务码原样透传 ----------

  describe('自带业务码的异常原样透传', () => {
    it('fileFilter 抛的 1006 类型异常应保留精确文案', () => {
      // Arrange：等价于 upload.controller.ts fileFilter 里 cb(new BadRequestException({...}))
      const exception = new BadRequestException({
        code: FILE_INVALID_CODE,
        message: FILE_TYPE_MESSAGE,
      });

      const res = runFilter(filter, exception);

      expect(res.statusCode).toBe(HttpStatus.BAD_REQUEST);
      expect(res.body).toEqual({
        code: 1006,
        data: null,
        message: '仅支持 JPG / PNG / WebP 格式的图片',
      });
    });

    it('service 抛的 1006 大小异常应保留精确文案而非兜底文案', () => {
      const exception = new BadRequestException({
        code: FILE_INVALID_CODE,
        message: FILE_SIZE_MESSAGE,
      });

      const res = runFilter(filter, exception);

      expect(res.body.message).toBe(FILE_SIZE_MESSAGE);
      expect(res.body.message).not.toBe(FILE_INVALID_DEFAULT_MESSAGE);
    });

    it('自带 code 的非 400 异常应保留其原始状态码', () => {
      // 透传分支优先级最高，状态码不应被改成 400
      const exception = new HttpException(
        { code: 1003, message: '邮箱已注册' },
        HttpStatus.CONFLICT,
      );

      const res = runFilter(filter, exception);

      expect(res.statusCode).toBe(HttpStatus.CONFLICT);
      expect(res.body.code).toBe(1003);
      expect(res.body.message).toBe('邮箱已注册');
    });

    it('自带 code 的 401 应走透传分支，不被 1001 覆盖', () => {
      const exception = new UnauthorizedException({ code: 1002, message: 'Token 已过期' });

      const res = runFilter(filter, exception);

      expect(res.statusCode).toBe(HttpStatus.UNAUTHORIZED);
      expect(res.body.code).toBe(1002);
      expect(res.body.message).toBe('Token 已过期');
    });
  });

  // ---------- 分支 4：真实服务端故障不得伪装 ----------

  describe('非 HttpException 的原始 Error 保持 500 + 5000', () => {
    it('磁盘写失败应返回 500 / 5000 且落 error 日志', () => {
      const res = runFilter(filter, new Error('disk write failed'));

      expect(res.statusCode).toBe(HttpStatus.INTERNAL_SERVER_ERROR);
      expect(res.body).toEqual({
        code: 5000,
        data: null,
        message: '服务器内部错误',
      });
      // 关键回归点：不能被伪装成 400/1006 的用户侧参数错误
      expect(res.statusCode).not.toBe(HttpStatus.BAD_REQUEST);
      expect(res.body.code).not.toBe(FILE_INVALID_CODE);
      // 必须保留可观测性
      expect(errorSpy).toHaveBeenCalledTimes(1);
      expect(String(errorSpy.mock.calls[0][0])).toContain('disk write failed');
    });

    it('抛出的非 Error 值（字符串）也应收敛为 500 / 5000', () => {
      const res = runFilter(filter, 'something exploded');

      expect(res.statusCode).toBe(HttpStatus.INTERNAL_SERVER_ERROR);
      expect(res.body.code).toBe(5000);
      expect(errorSpy).toHaveBeenCalled();
    });
  });

  // ---------- 响应信封结构一致性 ----------

  describe('响应信封结构', () => {
    const cases: Array<[string, unknown]> = [
      ['413 超限', new PayloadTooLargeException()],
      ['401 未认证', new UnauthorizedException()],
      ['403 禁止', new ForbiddenException()],
      ['自带 code', new BadRequestException({ code: 1006, message: 'x' })],
      ['原始 Error', new Error('x')],
    ];

    it.each(cases)('%s 的响应都应是 { code, data:null, message } 三字段信封', (_name, exc) => {
      const res = runFilter(filter, exc);

      expect(Object.keys(res.body).sort()).toEqual(['code', 'data', 'message']);
      expect(typeof res.body.code).toBe('number');
      expect(res.body.data).toBeNull();
      expect(typeof res.body.message).toBe('string');
      expect(res.body.message.length).toBeGreaterThan(0);
    });
  });
});
