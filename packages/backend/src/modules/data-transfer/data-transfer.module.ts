/**
 * 数据导入导出模块（T05）
 *
 * 依赖：
 * - RecalculationModule（commit 后单次 recalculateNavRange）
 * - PrismaModule（@Global，无需 import）
 */

import { Module } from '@nestjs/common';
import { RecalculationModule } from '../recalculation/recalculation.module';
import { DataTransferController } from './data-transfer.controller';
import { DataTransferService } from './data-transfer.service';

@Module({
  imports: [RecalculationModule],
  controllers: [DataTransferController],
  providers: [DataTransferService],
})
export class DataTransferModule {}
