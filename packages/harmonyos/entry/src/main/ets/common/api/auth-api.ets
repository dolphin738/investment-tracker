/**
 * 认证 API — register / login / getProfile
 *
 * 对应后端端点：
 * - POST /api/auth/register
 * - POST /api/auth/login
 * - GET  /api/auth/profile
 */

import { HttpClient } from '../net/http-client';
import { ApiConfig } from '../net/api-config';
import type { LoginRequest, LoginResponse, RegisterRequest, UserInfo } from '../net/api-types';

export class AuthApi {
  /**
   * 用户注册
   * @param email 邮箱
   * @param password 密码
   * @param name 显示名称（可选）
   * @returns 用户公开信息
   */
  static async register(email: string, password: string, name?: string): Promise<UserInfo> {
    const body: RegisterRequest = {
      email: email,
      password: password,
    };
    if (name && name.length > 0) {
      body.name = name;
    }
    return HttpClient.post<UserInfo>(ApiConfig.AUTH_REGISTER, body);
  }

  /**
   * 用户登录
   * @param email 邮箱
   * @param password 密码
   * @returns 登录响应（含 accessToken 和用户信息）
   */
  static async login(email: string, password: string): Promise<LoginResponse> {
    const body: LoginRequest = {
      email: email,
      password: password,
    };
    return HttpClient.post<LoginResponse>(ApiConfig.AUTH_LOGIN, body);
  }

  /**
   * 获取当前登录用户信息
   * @returns 用户公开信息
   */
  static async getProfile(): Promise<UserInfo> {
    return HttpClient.get<UserInfo>(ApiConfig.AUTH_PROFILE);
  }
}
