/**
 * 组合管理模块
 *
 * 依赖 CalculationModule（用于 POST /portfolios/:id/recalculate 全量重算）。
 * 依赖方向：PortfolioModule → CalculationModule（单向，无循环依赖；
 * CalculationModule 仅依赖全局 PrismaModule）。
 */

import { Module } from '@nestjs/common';
import { PortfolioController } from './portfolio.controller';
import { PortfolioService } from './portfolio.service';
import { CalculationModule } from '../calculation/calculation.module';

@Module({
  imports: [CalculationModule],
  controllers: [PortfolioController],
  providers: [PortfolioService],
  exports: [PortfolioService],
})
export class PortfolioModule {}
