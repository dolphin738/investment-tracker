/**
 * HttpExceptionFilter — 全局异常过滤器
 *
 * 将 NestJS 内置异常（HttpException 及其子类）转换为统一响应信封：
 * { code: statusCode, data: null, message: errorMessage }
 *
 * 对齐 ARCH §4.1 通用约定。
 */

import {
  ExceptionFilter,
  Catch,
  ArgumentsHost,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import type { Request, Response } from 'express';

interface ErrorResponseBody {
  code: number;
  data: null;
  message: string;
}

@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(HttpExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();

    let status: number;
    let message: string;

    if (exception instanceof HttpException) {
      status = exception.getStatus();
      const exceptionResponse = exception.getResponse();
      if (typeof exceptionResponse === 'string') {
        message = exceptionResponse;
      } else if (
        typeof exceptionResponse === 'object' &&
        exceptionResponse !== null
      ) {
        const resp = exceptionResponse as Record<string, unknown>;
        message =
          (resp.message as string) ?? exception.message;
      } else {
        message = exception.message;
      }
    } else {
      const err = exception as Error;
      status = HttpStatus.INTERNAL_SERVER_ERROR;
      message = err?.message ?? 'Internal Server Error';
      this.logger.error(
        `Unhandled exception: ${message}`,
        err?.stack,
      );
    }

    const body: ErrorResponseBody = {
      code: status,
      data: null,
      message,
    };

    this.logger.warn(
      `${request.method} ${request.url} → ${status}: ${message}`,
    );

    response.status(status).json(body);
  }
}
