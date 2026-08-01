/**
 * 上传端点专用异常过滤器（M3）
 *
 * 背景：
 * Nest 的 FileInterceptor 会把 multer 的 LIMIT_FILE_SIZE 转成 PayloadTooLargeException(413)，
 * 而全局 http-exception.filter.ts 的 switch 没有 413 分支 → 落到 default 返回 5000，
 * 前端只能看到「服务器内部错误」。本过滤器把上传相关的异常统一收敛到 400 + 1006。
 *
 * 处理策略（按优先级）：
 * 1. 异常自带数字 code（service 主动抛的 1006 等）→ 原样透传，保留精确文案
 * 2. 401 / 403 → 保持登录态语义，映射为 1001 / 1002（不能被改写成 1006，
 *    否则前端拦截器无法识别「登录已失效」）
 * 3. 其余 HttpException（413 / 415 / multer 其它错误）→ 400 + 1006，
 *    按状态码挑选更贴切的文案，拿不到就用默认文案
 * 4. 非 HttpException 的原始 Error（如磁盘写失败）→ 500 + 5000 并记日志，
 *    不伪装成用户侧参数错误，保留可观测性
 *
 * 用法：@UseFilters(FileUploadExceptionFilter) 挂在 upload.controller 的方法上，
 * 控制器作用域优先于全局过滤器。
 */

import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import type { Response } from 'express';
import {
  FILE_INVALID_CODE,
  FILE_INVALID_DEFAULT_MESSAGE,
  FILE_SIZE_MESSAGE,
  FILE_TYPE_MESSAGE,
} from '../upload.constants';

/** 统一错误响应信封 */
interface ErrorEnvelope {
  code: number;
  data: null;
  message: string;
}

/** 从 HttpException 的响应体里取自定义业务码，没有则返回 undefined */
function extractCustomCode(exception: HttpException): number | undefined {
  const response = exception.getResponse();
  if (typeof response === 'object' && response !== null) {
    const code = (response as Record<string, unknown>).code;
    if (typeof code === 'number') {
      return code;
    }
  }
  return undefined;
}

/** 从 HttpException 里提取可读文案 */
function extractMessage(exception: HttpException): string {
  const response = exception.getResponse();
  if (typeof response === 'string') {
    return response;
  }
  if (typeof response === 'object' && response !== null) {
    const resp = response as Record<string, unknown>;
    if (Array.isArray(resp.message)) {
      return resp.message.join('; ');
    }
    if (typeof resp.message === 'string') {
      return resp.message;
    }
    if (typeof resp.error === 'string') {
      return resp.error;
    }
  }
  return exception.message;
}

/** 无自定义 code 时，按 HTTP 状态码挑一条更贴切的 1006 文案 */
function fallbackMessageByStatus(status: number): string {
  switch (status) {
    case HttpStatus.PAYLOAD_TOO_LARGE:
      return FILE_SIZE_MESSAGE;
    case HttpStatus.UNSUPPORTED_MEDIA_TYPE:
      return FILE_TYPE_MESSAGE;
    default:
      return FILE_INVALID_DEFAULT_MESSAGE;
  }
}

@Catch()
export class FileUploadExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(FileUploadExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<Response>();
    const { status, body } = this.resolve(exception);
    response.status(status).json(body);
  }

  /** 把任意异常归一为 { status, body } */
  private resolve(exception: unknown): { status: number; body: ErrorEnvelope } {
    if (!(exception instanceof HttpException)) {
      // 非 HTTP 异常：真正的服务端故障，保持 500/5000 并落日志
      const error = exception instanceof Error ? exception : new Error(String(exception));
      this.logger.error(`头像上传发生未处理异常: ${error.message}`, error.stack);
      return {
        status: HttpStatus.INTERNAL_SERVER_ERROR,
        body: { code: 5000, data: null, message: '服务器内部错误' },
      };
    }

    const status = exception.getStatus();
    const customCode = extractCustomCode(exception);
    const message = extractMessage(exception);

    // 1. 已带业务码 → 原样透传（service 抛的 1006 精确文案走这里）
    if (customCode !== undefined) {
      return { status, body: { code: customCode, data: null, message } };
    }

    // 2. 登录态相关状态码必须保留，不能被改写成 1006
    if (status === HttpStatus.UNAUTHORIZED) {
      return { status, body: { code: 1001, data: null, message } };
    }
    if (status === HttpStatus.FORBIDDEN) {
      return { status, body: { code: 1002, data: null, message } };
    }

    // 3. 其余（413 / 415 / multer 其它错误）统一收敛为 400 + 1006
    this.logger.warn(`上传异常已收敛为 1006（原始状态码 ${status}）: ${message}`);
    return {
      status: HttpStatus.BAD_REQUEST,
      body: {
        code: FILE_INVALID_CODE,
        data: null,
        message: fallbackMessageByStatus(status),
      },
    };
  }
}
