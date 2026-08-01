/**
 * 修改密码请求 DTO
 *
 * 注意：ValidationPipe 开启了 forbidNonWhitelisted，
 * 「确认新密码」只在前端校验，绝不能出现在请求体中。
 */

import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString, Matches, MaxLength } from 'class-validator';
import {
  PASSWORD_MAX_LENGTH,
  PASSWORD_MESSAGE,
  PASSWORD_MIN_LENGTH,
  PASSWORD_PATTERN,
} from './password-policy';

export class UpdatePasswordDto {
  @ApiProperty({ description: '当前密码', example: 'password123' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(PASSWORD_MAX_LENGTH)
  currentPassword!: string;

  @ApiProperty({
    description: '新密码（至少 8 位，含字母和数字）',
    example: 'newPassword123',
    minLength: PASSWORD_MIN_LENGTH,
  })
  @IsString()
  @Matches(PASSWORD_PATTERN, { message: PASSWORD_MESSAGE })
  @MaxLength(PASSWORD_MAX_LENGTH)
  newPassword!: string;
}
