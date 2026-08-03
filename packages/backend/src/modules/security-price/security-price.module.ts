/**
 * SecurityPrice Module — 标的最新价管理
 */

import { Module } from '@nestjs/common';
import { SecurityPriceController } from './security-price.controller';
import { SecurityPriceService } from './security-price.service';
import { CalculationModule } from '../calculation/calculation.module';

@Module({
  imports: [CalculationModule],
  controllers: [SecurityPriceController],
  providers: [SecurityPriceService],
  exports: [SecurityPriceService],
})
export class SecurityPriceModule {}
