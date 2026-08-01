/**
 * 证券管理模块
 *
 * 提供标的主数据 CRUD（HOLD-P0-01）。
 * 依赖全局 PrismaModule，不依赖任何计算模块。
 */

import { Module } from '@nestjs/common';
import { SecurityController } from './security.controller';
import { SecurityService } from './security.service';

@Module({
  controllers: [SecurityController],
  providers: [SecurityService],
  exports: [SecurityService],
})
export class SecurityModule {}
