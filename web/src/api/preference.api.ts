/**
 * api/preference.api.ts — 用户偏好 API
 *
 * 对应后端：
 * - GET   /api/users/preferences   — 获取偏好
 * - PATCH /api/users/preferences   — 更新偏好
 */

import { http } from '@/lib/api-client';
import type { UserPreference, UpdatePreferenceDto } from './types';

/** 获取当前用户偏好 */
export function getPreferences(): Promise<UserPreference> {
  return http.get<UserPreference>('/users/preferences');
}

/** 更新用户偏好（部分更新） */
export function updatePreferences(
  payload: UpdatePreferenceDto,
): Promise<UserPreference> {
  return http.patch<UserPreference>('/users/preferences', payload);
}
