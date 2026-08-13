/**
 * hooks/use-interface-test.ts — 单接口测试 TanStack Query mutation
 *
 * 对应后端 POST /api/admin/quote-interfaces/{id}/test（§5.2）。
 * 调用方传入 interfaceId + 编辑后的完整 params + 可选 codes；
 * 成功后 toast 提示，失败（含接口返回的 error 字段）也提示，便于联调。
 */

import { useMutation } from '@tanstack/react-query';
import { toast } from 'sonner';
import {
  testInterface,
  type InterfaceTestRequest,
  type InterfaceTestResponse,
} from '@/api/quote-interface.api';

/** 测试入参：在 InterfaceTestRequest 基础上携带要测试的接口 id */
export interface InterfaceTestVariables extends InterfaceTestRequest {
  interfaceId: string;
}

export function useInterfaceTest() {
  return useMutation<InterfaceTestResponse, Error, InterfaceTestVariables>({
    mutationFn: ({ interfaceId, ...body }) => testInterface(interfaceId, body),
    onSuccess: (data) => {
      if (data.status === 'success') {
        toast.success(`测试成功（${data.elapsedMs}ms）`);
      } else {
        toast.error(`测试失败：${data.error ?? '未知错误'}`);
      }
    },
    onError: (e: Error) => toast.error(`测试请求异常：${e.message}`),
  });
}
