/**
 * 费用记录模块（HOLD-B-P0-10 / 阶段 C · Q-1 A 恢复）
 *
 * 持仓模块独立建表，不参与 XIRR / 净值计算（C-09 / D-03）。
 * 故意不 import RecalculationModule —— 任何写入都不得触发重算。
 * PrismaModule 是 @Global()，无需显式导入。
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
