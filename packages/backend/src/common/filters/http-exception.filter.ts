/**
 * HttpExceptionFilter — 全局异常过滤器
 *
 * 将任意异常转换为统一响应信封：{ code, data, message }
 * code 为业务码（0=成功、非 0=错误），与 @investment-tracker/shared
 * types/api.ts 的单一事实来源对齐（对齐 ARCH §4.1 响应信封）：
 *   - 异常自带数字 code（service 主动抛的 1004 / 2000 等）→ 原样透传；
 *   - 无自带 code 时按 HTTP 状态码映射：
 *       400 → 2000（参数/业务校验错误）
 *       401 → 1001（未认证）
 *       403 → 1002（Token 过期 / 无权限）
 *       404 → 3001（资源不存在）
 *       409 → 1003（邮箱已被注册）
 *       500 → 5000（服务器内部错误）
 *   - 其余未知状态码回退为 HTTP statusCode，保证可辨识性。
 * HTTP 状态码仍由异常本身决定（response.status(status)），
 * 与成功响应（code=0，见 ResponseInterceptor）共同构成完整信封契约。
 *
 * data 字段（SYS-P1-02 新增）：
 *   - 异常自带 data（如 1007 冷静期的 { remainingDays }）→ 原样透传；
 *   - 未携带 data 时仍回落为 null，既有错误响应形状保持不变。
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
  /** 错误附带的结构化数据，绝大多数错误为 null（见 extractCustomData） */
  data: unknown;
  message: string;
}

/** 业务错误码（与 shared/types/api.ts 的 BUSINESS_ERROR_CODE 取值一致） */
const BUSINESS_CODE = {
  UNAUTHORIZED: 1001,
  TOKEN_EXPIRED: 1002,
  EMAIL_TAKEN: 1003,
  VALIDATION_FAILED: 2000,
  NOT_FOUND: 3001,
  INTERNAL_ERROR: 5000,
} as const;

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

/**
 * 从 HttpException 的响应体里取自定义 data，没有则返回 undefined。
 *
 * 仅当 service 主动抛出 `{ code, message, data }` 形态的异常时才有值，
 * 例如 1007 冷静期信号需要把 { remainingDays } 送到前端（SYS-P1-02）。
 * 注意与 code 分开取：只带 code 不带 data 的既有异常必须继续回落 null。
 */
function extractCustomData(exception: HttpException): unknown | undefined {
  const response = exception.getResponse();
  if (typeof response === 'object' && response !== null) {
    const data = (response as Record<string, unknown>).data;
    if (data !== undefined) {
      return data;
    }
  }
  return undefined;
}

/** 无自定义 code 时，按 HTTP 状态码映射业务码；未知状态码回退 statusCode */
function businessCodeByStatus(status: number): number {
  switch (status) {
    case HttpStatus.BAD_REQUEST:
      return BUSINESS_CODE.VALIDATION_FAILED;
    case HttpStatus.UNAUTHORIZED:
      return BUSINESS_CODE.UNAUTHORIZED;
    case HttpStatus.FORBIDDEN:
      return BUSINESS_CODE.TOKEN_EXPIRED;
    case HttpStatus.NOT_FOUND:
      return BUSINESS_CODE.NOT_FOUND;
    case HttpStatus.CONFLICT:
      return BUSINESS_CODE.EMAIL_TAKEN;
    case HttpStatus.INTERNAL_SERVER_ERROR:
      return BUSINESS_CODE.INTERNAL_ERROR;
    default:
      return status;
  }
}

/** 从 HttpException 里提取可读文案（兼容 string / string[] / 对象） */
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
      message = extractMessage(exception);
    } else {
      const err = exception as Error;
      status = HttpStatus.INTERNAL_SERVER_ERROR;
      message = err?.message ?? 'Internal Server Error';
      this.logger.error(
        `Unhandled exception: ${message}`,
        err?.stack,
      );
    }

    const customCode =
      exception instanceof HttpException
        ? extractCustomCode(exception)
        : undefined;
    const code = customCode ?? businessCodeByStatus(status);

    const customData =
      exception instanceof HttpException
        ? extractCustomData(exception)
        : undefined;

    const body: ErrorResponseBody = {
      code,
      // 异常未携带 data 时保持既有形状（null），不影响存量错误响应
      data: customData ?? null,
      message,
    };

    this.logger.warn(
      `${request.method} ${request.url} → ${status}: ${message}`,
    );

    response.status(status).json(body);
  }
}
