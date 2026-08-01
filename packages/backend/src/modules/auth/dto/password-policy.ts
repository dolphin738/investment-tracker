/**
 * 密码策略常量
 *
 * 注册与修改密码共用同一套强度规则，避免两处校验不一致：
 * 至少 8 位，且必须同时包含字母和数字（允许任意其他字符）。
 * 前端 zod 校验需与此保持一致（web/src/features/auth/register-form.tsx、
 * web/src/features/account/change-password-dialog.tsx）。
 */

/** 密码强度正则：≥8 位且同时含字母与数字 */
export const PASSWORD_PATTERN = /^(?=.*[A-Za-z])(?=.*\d)[\s\S]{8,100}$/;

/** 密码强度校验失败时的提示文案 */
export const PASSWORD_MESSAGE = '密码至少 8 位，且需同时包含字母和数字';

/** 密码最短长度 */
export const PASSWORD_MIN_LENGTH = 8;

/** 密码最长长度 */
export const PASSWORD_MAX_LENGTH = 100;
