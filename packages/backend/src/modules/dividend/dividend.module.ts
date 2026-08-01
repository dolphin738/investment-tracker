/**
 * 分红记录模块
 *
 * 持仓模块独立建表，不参与 XIRR/净值计算（C-08 / C-09）。
 */

import { Module } from '@nestjs/common';
import { DividendController } from './dividend.controller';
import { DividendService } from './dividend.service';

@Module({
  controllers: [DividendController],
  providers: [DividendService],
  exports: [DividendService],
})
export class DividendModule {}
