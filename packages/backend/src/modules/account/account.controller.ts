/**
 * 账户控制器
 *
 * 路由前缀：/api/account
 *
 * 接口：
 * - GET /api/account/stats — 获取账户统计信息
 *
 * 注意：用户信息（profile）的读取与修改已由 AuthModule（/api/auth/profile）
 * 完整覆盖。User 表已有 avatar 字段，头像 URL 可通过 PATCH /api/auth/profile
 * 直接更新。头像文件上传由 UploadModule（/api/upload/avatar）处理。
 */

import { Controller, Get } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { AccountService } from './account.service';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../../common/decorators/current-user.decorator';

@ApiTags('账户')
@ApiBearerAuth('JWT-auth')
@Controller('account')
export class AccountController {
  constructor(private readonly accountService: AccountService) {}

  @Get('stats')
  @ApiOperation({ summary: '获取账户统计信息（组合数/交易笔数/快照天数/起止日期/使用天数）' })
  async getStats(@CurrentUser() user: AuthenticatedUser) {
    return this.accountService.getStats(user.userId);
  }
}
