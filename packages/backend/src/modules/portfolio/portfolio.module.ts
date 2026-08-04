/**
 * 组合管理模块
 *
 * 依赖 RecalculationModule（用于 POST /portfolios/:id/recalculate 全量重算）。
 * 依赖方向：PortfolioModule → RecalculationModule → CalculationModule（单向，无循环依赖）。
 */

import { Module } from '@nestjs/common';
import { PortfolioController } from './portfolio.controller';
import { PortfolioService } from './portfolio.service';
import { RecalculationModule } from '../recalculation/recalculation.module';

@Module({
  imports: [RecalculationModule],
  controllers: [PortfolioController],
  providers: [PortfolioService],
  exports: [PortfolioService],
})
export class PortfolioModule {}
