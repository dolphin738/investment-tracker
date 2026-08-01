/**
 * 账户模块
 *
 * 提供账户统计信息接口。
 *
 * 注意：User 表已有 avatar 字段，基本 profile CRUD 已由 AuthModule（/api/auth/profile）完整覆盖。
 * 本模块仅新增统计聚合接口，不重复实现已有功能。
 */

import { Module } from '@nestjs/common';
import { AccountController } from './account.controller';
import { AccountService } from './account.service';

@Module({
  controllers: [AccountController],
  providers: [AccountService],
  exports: [AccountService],
})
export class AccountModule {}
