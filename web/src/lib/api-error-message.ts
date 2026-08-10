/**
 * lib/api-error-message.ts — 业务错误 → 可读提示文案（就地反馈用）
 *
 * 【为什么需要它】
 * api-client 响应拦截器已对业务错误统一弹全局 toast（见 use-account.ts 注释：
 * 调用方再 toast 一次会「双弹」）。但**就地反馈**场景仍然需要一份文案：
 * - 表单提交失败：弹窗不能关，要在表单里说明失败原因（toast 3 秒就没了）；
 * - 行内删除失败：确认框需要保持打开并显示原因，而不是静默回到列表。
 *
 * 本模块只做「异常对象 → 一句中文」的收敛，**不产生任何 toast**，
 * 因此不会与拦截器重复提示。
 *
 * 文案优先级：后端 message（最贴业务，如 M1「首笔出入金必须为存入」）
 *   → 业务码兜底文案 → 调用方传入的 fallback。
 */

import { ApiError } from '@/lib/api-client';
import { BUSINESS_ERROR_CODE } from '@/lib/types';

/** 后端未给 message 时按业务码兜底（仅覆盖前端会就地呈现的几类） */
const CODE_FALLBACK: Readonly<Record<number, string>> = {
  [BUSINESS_ERROR_CODE.VALIDATION_FAILED]: '提交内容不符合业务规则，请检查后重试',
  [BUSINESS_ERROR_CODE.NOT_FOUND]: '记录不存在或已被删除，请刷新后重试',
  [BUSINESS_ERROR_CODE.INTERNAL_ERROR]: '服务异常，请稍后重试',
};

/**
 * 把任意异常收敛为可直接渲染的中文提示。
 *
 * @param error    mutation / query 抛出的异常（ApiError、网络 Error、未知值）
 * @param fallback 全部取不到时的兜底文案
 */
export function resolveApiErrorMessage(
  error: unknown,
  fallback = '操作失败，请稍后重试',
): string {
  if (error instanceof ApiError) {
    return error.message || CODE_FALLBACK[error.code] || fallback;
  }
  if (error instanceof Error && error.message) {
    return error.message;
  }
  return fallback;
}
