/**
 * ResponseInterceptor — 统一响应信封包装
 *
 * 将 Controller 返回的成功数据包装为：
 * { code: 0, data: <original>, message: 'ok' }
 *
 * 对齐 ARCH §4.1 通用约定。
 *
 * 防御性处理（与 TransformInterceptor 的 isEnvelope 保持同一契约）：
 * 控制器若已自行返回 { code:number, data, message } 信封，则原样透传，不再二次包装。
 * 缺少这道判断时，upload.controller 手工造的信封会被再包一层，
 * 前端解一层后拿到的是内层信封而非业务数据（曾导致头像上传后刷新掉登录态）。
 * 当前没有任何业务响应对象带 number 型 code 字段，该判断不会误伤正常数据。
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

/**
 * 判断控制器返回值是否已经是响应信封（带 number 型 code 字段）。
 *
 * @param value 控制器返回值
 * @returns true 表示已是信封，跳过二次包装
 */
function isEnvelope(value: unknown): boolean {
  return (
    typeof value === 'object' &&
    value !== null &&
    'code' in value &&
    typeof (value as Record<string, unknown>).code === 'number'
  );
}

@Injectable()
export class ResponseInterceptor<T> implements NestInterceptor<T, SuccessResponseBody<T>> {
  intercept(
    _context: ExecutionContext,
    next: CallHandler<T>,
  ): Observable<SuccessResponseBody<T>> {
    return next.handle().pipe(
      map((data: T) => {
        // 已是信封 → 原样透传，避免 data 被套娃后前端解不出业务字段
        if (isEnvelope(data)) {
          return data as unknown as SuccessResponseBody<T>;
        }
        return {
          code: 0,
          // undefined 归一为 null，防止 JSON 序列化直接丢掉 data 字段
          data: (data === undefined ? null : data) as T,
          message: 'ok',
        };
      }),
    );
  }
}
