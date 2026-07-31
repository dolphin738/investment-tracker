/**
 * 响应转换拦截器
 *
 * 将控制器返回的数据统一包装为 API 响应信封：
 * { code: 0, data: T, message: 'success' }
 *
 * 防御性处理：
 * - 如果返回值已经是信封格式（含有 code 字段），不再重复包装
 * - null / undefined 返回值统一包装为 { code: 0, data: null, message: 'success' }
 *
 * 与全局异常过滤器配合，确保所有响应（成功/失败）都遵循统一格式。
 */

import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { Observable } from 'rxjs';
import { map } from 'rxjs/operators';

/** 统一响应格式 */
export interface ApiResponseEnvelope<T> {
  code: number;
  data: T;
  message: string;
}

/**
 * 判断返回值是否已经是信封格式（含有 code 字段）。
 * 避免对已包装的响应进行二次包装。
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
export class TransformInterceptor<T> implements NestInterceptor<T, ApiResponseEnvelope<T>> {
  intercept(
    context: ExecutionContext,
    next: CallHandler<T>,
  ): Observable<ApiResponseEnvelope<T>> {
    return next.handle().pipe(
      map((data) => {
        // 已经是信封格式，直接返回，避免二次包装
        if (isEnvelope(data)) {
          return data as ApiResponseEnvelope<T>;
        }
        // undefined 统一转为 null，防止 JSON 序列化丢失 data 字段
        return {
          code: 0,
          data: (data === undefined ? null : data) as T,
          message: 'success',
        };
      }),
    );
  }
}
