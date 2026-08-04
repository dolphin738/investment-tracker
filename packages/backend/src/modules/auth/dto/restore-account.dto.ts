/**
 * 注销账户自助恢复请求 DTO（SYS-P1-02）
 *
 * 校验口径与 login.dto.ts 完全一致，**刻意不加密码强度校验**：
 * restore 是「比对」既有密码而非「设置」新密码，套用 register.dto.ts 的
 * @Matches(PASSWORD_PATTERN) 会误伤不满足现行策略的存量弱密码用户，
 * 让他们连恢复的机会都没有。
 */

import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsEmail, IsNotEmpty, IsString, MaxLength } from 'class-validator';

export class RestoreAccountDto {
  @ApiProperty({ description: '邮箱地址', example: 'user@example.com' })
  @Transform(({ value }) => typeof value === 'string' ? value.trim().toLowerCase() : value)
  @IsEmail()
  @MaxLength(255)
  email!: string;

  @ApiProperty({ description: '密码（与注销前一致）', example: 'password123' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  password!: string;
}
