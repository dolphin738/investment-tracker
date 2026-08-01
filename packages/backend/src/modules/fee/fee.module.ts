/**
 * 费用记录模块
 *
 * 持仓模块独立建表，不参与 XIRR/净值计算（C-08 / C-09）。
 */

import { Module } from '@nestjs/common';
import { FeeController } from './fee.controller';
import { FeeService } from './fee.service';

@Module({
  controllers: [FeeController],
  providers: [FeeService],
  exports: [FeeService],
})
export class FeeModule {}
