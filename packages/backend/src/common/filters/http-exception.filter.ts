/**
 * 全局异常过滤器
 *
 * 将所有异常统一转换为 API 响应信封格式：
 * { code: number, data: null, message: string }
 *
 * 错误码规划（与 shared/types/api.ts 一致）：
 *   0           成功
 *   1001        未认证（401）
 *   1002        Token 过期 / 无权限（403）
 *   1003        邮箱已注册（409）
 *   2000        参数校验错误（400）
 *   3001        资源不存在（404）
 *   5000        服务器内部错误（500）
 */

import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Response } from 'express';

/** 错误码与 HTTP 状态码的映射 */
function resolveErrorCode(status: number, exception: HttpException): number {
  // 优先使用异常响应中自定义的 code
  const response = exception.getResponse();
  if (typeof response === 'object' && response !== null) {
    const code = (response as Record<string, unknown>).code;
    if (typeof code === 'number') {
      return code;
    }
  }

  switch (status) {
    case HttpStatus.UNAUTHORIZED:
      return 1001;
    case HttpStatus.FORBIDDEN:
      return 1002;
    case HttpStatus.CONFLICT:
      return 1003;
    case HttpStatus.BAD_REQUEST:
      return 2000;
    case HttpStatus.NOT_FOUND:
      return 3001;
    default:
      return 5000;
  }
}

/** 从 HttpException 中提取可读的错误信息 */
function resolveMessage(exception: HttpException): string {
  const response = exception.getResponse();

  if (typeof response === 'string') {
    return response;
  }

  if (typeof response === 'object' && response !== null) {
    const resp = response as Record<string, unknown>;
    const message = resp.message;

    if (Array.isArray(message)) {
      // class-validator 返回的数组形式的错误信息
      return message.join('; ');
    }

    if (typeof message === 'string') {
      return message;
    }

    if (typeof resp.error === 'string') {
      return resp.error;
    }
  }

  return exception.message;
}

@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(HttpExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();

    let status = HttpStatus.INTERNAL_SERVER_ERROR;
    let code = 5000;
    let message = '服务器内部错误';

    if (exception instanceof HttpException) {
      status = exception.getStatus();
      code = resolveErrorCode(status, exception);
      message = resolveMessage(exception);
    } else if (exception instanceof Error) {
      message = exception.message;
      this.logger.error(`未处理的异常: ${exception.message}`, exception.stack);
    }

    response.status(status).json({
      code,
      data: null,
      message,
    });
  }
}
