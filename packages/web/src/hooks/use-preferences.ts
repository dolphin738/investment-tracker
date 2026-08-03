/**
 * hooks/use-preferences.ts — 用户偏好 TanStack Query hooks
 */

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import {
  getPreferences,
  updatePreferences,
} from '@/api/preference.api';
import type { UpdatePreferenceDto, UserPreference } from '@/api/types';
import { usePreferenceStore } from '@/stores/preference.store';

/** 偏好查询 key */
export const PREFERENCE_KEY = ['users', 'preferences'] as const;

/** 获取用户偏好 */
export function usePreferences() {
  return useQuery({
    queryKey: PREFERENCE_KEY,
    queryFn: () => getPreferences(),
    staleTime: 5 * 60 * 1000,
  });
}

/** 更新用户偏好（乐观更新） */
export function useUpdatePreferences() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (payload: UpdatePreferenceDto) => updatePreferences(payload),
    onMutate: async (payload) => {
      await queryClient.cancelQueries({ queryKey: PREFERENCE_KEY });
      const previous = queryClient.getQueryData(PREFERENCE_KEY);
      queryClient.setQueryData(PREFERENCE_KEY, (old: unknown) => {
        if (!old || typeof old !== 'object') return old;
        return { ...(old as Record<string, unknown>), ...payload };
      });
      return { previous };
    },
    onError: (_err, _payload, context) => {
      if (context?.previous) {
        queryClient.setQueryData(PREFERENCE_KEY, context.previous);
      }
    },
    onSuccess: (_data, payload) => {
      toast.success('偏好已保存');
      queryClient.invalidateQueries({ queryKey: PREFERENCE_KEY });
      // 同步本地 store：把增量 payload 合并进现有偏好，
      // 保证概览页 / 分析页即使不重新请求也能立即读到新默认值。
      const state = usePreferenceStore.getState();
      if (state.preferences) {
        state.setPreferences({
          ...state.preferences,
          ...payload,
        } as UserPreference);
      }
    },
  });
}
