/**
 * api/auth.api.ts — 认证 API
 *
 * 对应后端：
 * - POST  /api/auth/register — 注册（公开）
 * - POST  /api/auth/login — 登录（公开）
 * - POST  /api/auth/account/restore — 注销账户自助恢复（公开，SYS-P1-02）
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
  RestoreRequest,
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
 * 对应后端 DELETE /api/auth/account（JWT 保护）。
 * 后端为软删除：账户及其全部组合数据保留 30 天可恢复，期间不能登录。
 * 前端要求输入当前邮箱二次确认后才能提交。
 */
export function deleteAccount(): Promise<null> {
  return http.delete<null>('/auth/account');
}

/**
 * 注销账户自助恢复（SYS-P1-02）。
 *
 * 对应后端 POST /api/auth/account/restore（@Public，免 JWT —— 调用时用户
 * 本就处于未登录状态）。凭注销前的邮箱 + 密码清空软删标记，
 * 成功后直接返回新的 accessToken + 用户信息，无需再登录一次。
 *
 * 失败分支由拦截器统一处理：1001 邮箱或密码错误 / 1008 账户未注销 /
 * 1009 恢复期已过。
 */
export function restoreAccount(payload: RestoreRequest): Promise<LoginResponse> {
  return http.post<LoginResponse>('/auth/account/restore', payload);
}
