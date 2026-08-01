/**
 * api/upload.api.ts — 文件上传 API
 *
 * 对应后端：
 * - POST /api/upload/avatar — 上传并绑定当前用户头像（需认证）
 *
 * 注意：绝不手动设置 Content-Type。
 * 只有让浏览器自己生成 `multipart/form-data; boundary=...`，后端 multer 才能解析出文件。
 * api-client 的请求拦截器已在检测到 FormData 时删除实例级的 application/json 头。
 */

import { http } from '@/lib/api-client';
import type { UploadAvatarResponse } from './types';

/**
 * 上传头像文件
 *
 * @param file 用户选择的图片文件（JPG / PNG / WebP，≤ 2MB）
 * @returns 新头像地址 + 更新后的用户信息
 */
export function uploadAvatar(file: File): Promise<UploadAvatarResponse> {
  const formData = new FormData();
  formData.append('file', file);
  return http.post<UploadAvatarResponse>('/upload/avatar', formData);
}
