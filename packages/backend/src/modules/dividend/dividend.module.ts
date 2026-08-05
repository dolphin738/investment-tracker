/**
 * 分红记录模块（HOLD-B-P0-10 / 阶段 C · Q-1 A 恢复）
 *
 * 持仓模块独立建表，不参与 XIRR / 净值计算（C-08 / D-02）。
 * 故意不 import RecalculationModule —— 任何写入都不得触发重算。
 * PrismaModule 是 @Global()，无需显式导入。
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
