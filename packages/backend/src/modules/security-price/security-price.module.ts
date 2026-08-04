/**
 * SecurityPrice Module — 标的最新价管理
 *
 * 依赖 RecalculationModule（用于 recalculateRange 触发）。
 */

import { Module } from '@nestjs/common';
import { SecurityPriceController } from './security-price.controller';
import { SecurityPriceService } from './security-price.service';
import { RecalculationModule } from '../recalculation/recalculation.module';

@Module({
  imports: [RecalculationModule],
  controllers: [SecurityPriceController],
  providers: [SecurityPriceService],
  exports: [SecurityPriceService],
})
export class SecurityPriceModule {}
