/**
 * ResponseInterceptor — 统一响应信封包装
 *
 * 将 Controller 返回的成功数据包装为：
 * { code: 0, data: <original>, message: 'ok' }
 *
 * 对齐 ARCH §4.1 通用约定。
 */

import {
  Injectable,
  NestInterceptor,
  ExecutionContext,
  CallHandler,
} from '@nestjs/common';
import { Observable } from 'rxjs';
import { map } from 'rxjs/operators';

interface SuccessResponseBody<T> {
  code: number;
  data: T;
  message: string;
}

@Injectable()
export class ResponseInterceptor<T> implements NestInterceptor<T, SuccessResponseBody<T>> {
  intercept(
    _context: ExecutionContext,
    next: CallHandler<T>,
  ): Observable<SuccessResponseBody<T>> {
    return next.handle().pipe(
      map((data: T) => ({
        code: 0,
        data,
        message: 'ok',
      })),
    );
  }
}
