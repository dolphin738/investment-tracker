/**
 * 修改邮箱请求 DTO
 *
 * 修改邮箱属于敏感操作，必须二次校验当前密码。
 */

import { ApiProperty } from '@nestjs/swagger';
import { IsEmail, IsNotEmpty, IsString, MaxLength } from 'class-validator';
import { PASSWORD_MAX_LENGTH } from './password-policy';

export class UpdateEmailDto {
  @ApiProperty({ description: '当前密码', example: 'password123' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(PASSWORD_MAX_LENGTH)
  currentPassword!: string;

  @ApiProperty({ description: '新邮箱地址', example: 'new@example.com' })
  @IsEmail()
  @MaxLength(255)
  newEmail!: string;
}
