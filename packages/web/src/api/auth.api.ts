/**
 * api/auth.api.ts — 认证 API
 *
 * 对应后端：
 * - POST  /api/auth/register — 注册（公开）
 * - POST  /api/auth/login — 登录（公开）
 * - GET   /api/auth/profile — 获取当前用户（需认证）
 * - PATCH /api/auth/password — 修改密码（需认证）
 * - PATCH /api/auth/email — 修改邮箱（需认证）
 * - PATCH /api/auth/profile — 修改个人资料（需认证）
 */

import { http } from '@/lib/api-client';
import type {
  AuthTokenResponse,
  LoginRequest,
  LoginResponse,
  RegisterRequest,
  UpdateEmailRequest,
  UpdatePasswordRequest,
  UpdateProfileRequest,
  UserProfile,
  UserPublic,
} from './types';

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

/** 修改密码，成功后返回重签的 accessToken + 用户信息 */
export function updatePassword(payload: UpdatePasswordRequest): Promise<AuthTokenResponse> {
  return http.patch<AuthTokenResponse>('/auth/password', payload);
}

/** 修改邮箱，成功后返回重签的 accessToken + 用户信息 */
export function updateEmail(payload: UpdateEmailRequest): Promise<AuthTokenResponse> {
  return http.patch<AuthTokenResponse>('/auth/email', payload);
}

/** 修改个人资料，返回最新用户信息 */
export function updateProfile(payload: UpdateProfileRequest): Promise<UserPublic> {
  return http.patch<UserPublic>('/auth/profile', payload);
}

/**
 * 注销当前账户（SET-P1-06）。
 *
 * 对应后端 DELETE /api/auth/account（JWT 保护），
 * 成功后用户及其全部组合/交易/快照/净值/XIRR 数据被级联删除。
 */
export function deleteAccount(): Promise<null> {
  return http.delete<null>('/auth/account');
}
