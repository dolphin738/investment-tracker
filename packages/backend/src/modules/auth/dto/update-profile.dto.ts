/**
 * 修改个人资料请求 DTO
 *
 * 三态语义：
 * - 字段缺省（undefined）→ 不修改
 * - 字段为 null 或空串 ''  → 清空为 NULL
 * - 字段有值             → 更新为该值
 *
 * 注意：@IsOptional() 只跳过 undefined / null，不跳过空串 ''。
 * 因此对有格式要求的字段（avatar / phone）改用 @ValidateIf 排除空串，
 * 否则「清空」操作会被格式校验拦下。
 */

import { ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  ValidateIf,
} from 'class-validator';

/** 中国大陆手机号正则 */
const PHONE_PATTERN = /^1[3-9]\d{9}$/;

/**
 * 头像地址正则：同时放行「站内相对路径」与「外链绝对地址」。
 *
 * - 站内：以单个 / 开头（`(?!\/)` 排除 `//evil.com` 这种协议相对 URL，防开放重定向/外链注入），
 *   后续只允许字母数字、下划线、连字符、点号与斜杠 —— 覆盖 /api/uploads/avatar/<uuid>.png
 * - 外链：http(s):// + 至少含一个点号的域名（兼容历史手填的图床地址）
 *
 * P0-5：旧版用 @IsUrl({require_protocol:true}) 会把上传返回的相对路径判为非法 → PATCH 400。
 */
const AVATAR_PATTERN = /^(?:\/(?!\/)[\w\-./]*|https?:\/\/[\w-]+(\.[\w-]+)+\S*)$/i;

export class UpdateProfileDto {
  @ApiPropertyOptional({ description: '显示名称（传空串清空）', example: '张三' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  name?: string | null;

  @ApiPropertyOptional({
    description:
      '头像地址：站内相对路径（/api/uploads/avatar/xxx.png）或 http(s) 外链，传空串清空',
    example: '/api/uploads/avatar/2f1c9b0e-7a3d-4f6b-9c2e-5d8a1b0c3e4f.png',
  })
  @ValidateIf((o: UpdateProfileDto) => o.avatar !== undefined && o.avatar !== null && o.avatar !== '')
  @IsString()
  @Matches(AVATAR_PATTERN, { message: '头像地址格式不正确' })
  @MaxLength(512)
  avatar?: string | null;

  @ApiPropertyOptional({ description: '手机号（传空串清空）', example: '13800138000' })
  @ValidateIf((o: UpdateProfileDto) => o.phone !== undefined && o.phone !== null && o.phone !== '')
  @IsString()
  @Matches(PHONE_PATTERN, { message: '请输入正确的手机号' })
  phone?: string | null;

  @ApiPropertyOptional({ description: '个人简介，最多 200 字（传空串清空）', example: '长期价值投资者' })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  bio?: string | null;
}
