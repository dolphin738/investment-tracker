/**
 * 注册请求 DTO
 */

import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsEmail, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

export class RegisterDto {
  @ApiProperty({ description: '邮箱地址', example: 'user@example.com' })
  @IsEmail()
  @MaxLength(255)
  email!: string;

  @ApiProperty({
    description: '密码（至少 6 位）',
    example: 'password123',
    minLength: 6,
  })
  @IsString()
  @MinLength(6)
  @MaxLength(100)
  password!: string;

  @ApiPropertyOptional({ description: '显示名称', example: '张三' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  name?: string;
}
