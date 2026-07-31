/**
 * api/auth.api.ts — 认证 API
 *
 * 对应后端：
 * - POST /api/auth/register — 注册（公开）
 * - POST /api/auth/login — 登录（公开）
 * - GET  /api/auth/profile — 获取当前用户（需认证）
 */

import { http } from '@/lib/api-client';
import type {
  LoginRequest,
  LoginResponse,
  RegisterRequest,
  UserProfile,
} from './types';
import type { UserPublic } from '@investment-tracker/shared';

/** 用户注册 */
export function register(payload: RegisterRequest): Promise<UserPublic> {
  return http.post<UserPublic>('/auth/register', payload);
}

/** 用户登录，返回 accessToken + 用户信息 */
export function login(payload: LoginRequest): Promise<LoginResponse> {
  return http.post<LoginResponse>('/auth/login', payload);
}

/** 获取当前登录用户信息 */
export function getProfile(): Promise<UserProfile> {
  return http.get<UserProfile>('/auth/profile');
}
