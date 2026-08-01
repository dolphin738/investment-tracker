/**
 * 上传模块常量与路径解析
 *
 * 单一事实来源：main.ts（创建目录 + 注册静态资源）与 LocalDiskStorage（落盘）
 * 都从这里获取上传根目录，避免两处各自拼路径导致「写进 A、读的是 B」。
 *
 * 关键约束（勿改）：
 * - URL 前缀必须以 /api 开头。vite 只代理 /api，且 app.setGlobalPrefix('api')
 *   不作用于 express 静态中间件，所以 useStaticAssets 的 prefix 要手写 /api。
 */

import * as path from 'node:path';

/** 允许上传的图片 MIME 类型白名单 */
export const ALLOWED_MIME: readonly string[] = ['image/jpeg', 'image/png', 'image/webp'];

/** 单文件大小上限：2MB */
export const MAX_SIZE = 2 * 1024 * 1024;

/** 头像在上传根目录下的子目录名 */
export const AVATAR_SUBDIR = 'avatar';

/** 头像对外访问 URL 前缀（含 /api，与 useStaticAssets 的 prefix 对齐） */
export const AVATAR_URL_PREFIX = `/api/uploads/${AVATAR_SUBDIR}`;

/** 静态资源挂载前缀（express.static 的 prefix，必须以 / 结尾） */
export const STATIC_ASSETS_PREFIX = '/api/uploads/';

/** 上传根目录环境变量名 */
export const UPLOAD_DIR_ENV = 'UPLOAD_DIR';

/** 存储驱动环境变量名（local / cos / s3，本轮仅实现 local） */
export const STORAGE_DRIVER_ENV = 'STORAGE_DRIVER';

/** 默认存储驱动 */
export const DEFAULT_STORAGE_DRIVER = 'local';

/** 魔数嗅探得到的图片扩展名 */
export type ImageExt = 'jpg' | 'png' | 'webp';

/** 合法头像文件名：<uuid>.<ext>（crypto.randomUUID() 固定 36 字符） */
export const AVATAR_FILENAME_PATTERN = /^[0-9a-f-]{36}\.(jpg|png|webp)$/;

/** 文件校验失败业务码（类型 / 大小 / 缺失） */
export const FILE_INVALID_CODE = 1006;

/** 1006 默认兜底文案（过滤器在拿不到具体原因时使用） */
export const FILE_INVALID_DEFAULT_MESSAGE = '图片上传失败，请重试';

/** 类型不合法文案 */
export const FILE_TYPE_MESSAGE = '仅支持 JPG / PNG / WebP 格式的图片';

/** 超出大小限制文案 */
export const FILE_SIZE_MESSAGE = '图片大小不能超过 2MB';

/** 文件缺失文案 */
export const FILE_MISSING_MESSAGE = '请选择要上传的图片文件';

/**
 * 解析上传根目录的绝对路径。
 *
 * 优先读环境变量 UPLOAD_DIR：
 * - 绝对路径 → 原样使用（生产环境挂持久卷推荐）
 * - 相对路径 → 相对 process.cwd() 解析
 * - 未配置   → <cwd>/uploads
 *
 * @param getEnv 环境变量读取函数（main.ts 传 process.env，服务里传 ConfigService.get）
 * @returns 上传根目录的绝对路径
 */
export function resolveUploadDir(getEnv: (key: string) => string | undefined): string {
  const configured = getEnv(UPLOAD_DIR_ENV)?.trim();
  if (configured) {
    return path.isAbsolute(configured) ? configured : path.resolve(process.cwd(), configured);
  }
  return path.join(process.cwd(), 'uploads');
}

/** 解析头像子目录的绝对路径 */
export function resolveAvatarDir(getEnv: (key: string) => string | undefined): string {
  return path.join(resolveUploadDir(getEnv), AVATAR_SUBDIR);
}
