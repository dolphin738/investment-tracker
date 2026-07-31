/**
 * 认证状态管理 — token / user / login / logout / isAuthenticated
 *
 * 使用 AppStorage 进行内存级状态管理（跨页面共享），
 * 使用 @kit.ArkData preferences 进行持久化存储（跨应用重启）。
 *
 * 使用方式：
 * 1. EntryAbility.onCreate 中调用 AuthStore.init(context) 初始化
 * 2. 页面中使用 @StorageLink(ApiConfig.TOKEN_KEY) 绑定 token
 * 3. 登录/退出调用 AuthStore 方法
 */

import { preferences } from '@kit.ArkData';
import { common } from '@kit.AbilityKit';
import { ApiConfig } from '../net/api-config';
import { AuthApi } from '../api/auth-api';
import type { UserInfo } from '../net/api-types';

export class AuthStore {
  private static context: common.UIAbilityContext | null = null;
  private static readonly PREFS_NAME: string = 'auth_prefs';

  /**
   * 初始化 — 在 EntryAbility.onCreate 中调用
   * 从持久化存储加载 token 和用户信息到 AppStorage
   */
  static async init(context: common.UIAbilityContext): Promise<void> {
    AuthStore.context = context;
    try {
      const prefs = await preferences.getPreferences(context, AuthStore.PREFS_NAME);
      const token = (await prefs.get('token', '')).toString();
      const userJson = (await prefs.get('user', '')).toString();

      if (token && token.length > 0) {
        AppStorage.setOrCreate(ApiConfig.TOKEN_KEY, token);
      } else {
        AppStorage.setOrCreate(ApiConfig.TOKEN_KEY, '');
      }

      if (userJson && userJson.length > 0) {
        const user: UserInfo = JSON.parse(userJson) as UserInfo;
        AppStorage.setOrCreate(ApiConfig.USER_KEY, user);
      } else {
        AppStorage.setOrCreate(ApiConfig.USER_KEY, null);
      }
    } catch (error) {
      // 首次安装时 preferences 可能未初始化，忽略错误
      AppStorage.setOrCreate(ApiConfig.TOKEN_KEY, '');
      AppStorage.setOrCreate(ApiConfig.USER_KEY, null);
    }
  }

  /**
   * 获取当前 token
   */
  static getToken(): string {
    return AppStorage.get<string>(ApiConfig.TOKEN_KEY) || '';
  }

  /**
   * 获取当前用户信息
   */
  static getUser(): UserInfo | null {
    return AppStorage.get<UserInfo>(ApiConfig.USER_KEY);
  }

  /**
   * 是否已登录
   */
  static isAuthenticated(): boolean {
    const token = AuthStore.getToken();
    return token !== null && token !== undefined && token.length > 0;
  }

  /**
   * 登录 — 调用 API 并持久化 token
   */
  static async login(email: string, password: string): Promise<UserInfo> {
    const response = await AuthApi.login(email, password);

    // 写入 AppStorage
    AppStorage.setOrCreate(ApiConfig.TOKEN_KEY, response.accessToken);
    AppStorage.setOrCreate(ApiConfig.USER_KEY, response.user);

    // 持久化到 preferences
    await AuthStore.persist('token', response.accessToken);
    await AuthStore.persist('user', JSON.stringify(response.user));

    return response.user;
  }

  /**
   * 注册 — 调用 API（注册后不自动登录，用户需手动登录）
   */
  static async register(email: string, password: string, name?: string): Promise<UserInfo> {
    return AuthApi.register(email, password, name);
  }

  /**
   * 退出登录 — 清除所有认证状态
   */
  static async logout(): Promise<void> {
    AppStorage.setOrCreate(ApiConfig.TOKEN_KEY, '');
    AppStorage.setOrCreate(ApiConfig.USER_KEY, null);
    AppStorage.setOrCreate(ApiConfig.PORTFOLIO_KEY, '');

    await AuthStore.persist('token', '');
    await AuthStore.persist('user', '');
  }

  /**
   * 刷新用户信息 — 从服务器获取最新 profile
   */
  static async refreshProfile(): Promise<UserInfo> {
    const user = await AuthApi.getProfile();
    AppStorage.setOrCreate(ApiConfig.USER_KEY, user);
    await AuthStore.persist('user', JSON.stringify(user));
    return user;
  }

  /**
   * 持久化到 preferences
   */
  private static async persist(key: string, value: string): Promise<void> {
    if (!AuthStore.context) {
      return;
    }
    try {
      const prefs = await preferences.getPreferences(AuthStore.context, AuthStore.PREFS_NAME);
      await prefs.put(key, value);
      await prefs.flush();
    } catch (error) {
      // 持久化失败不影响应用使用（内存中仍有数据）
    }
  }
}
