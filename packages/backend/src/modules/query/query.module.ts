/**
 * 查询模块
 *
 * 提供四维度查询聚合（日/周/月/年 + 期末值/均值）。
 * 仅依赖 PrismaService（全局提供），不依赖其他业务模块。
 */

import { Module } from '@nestjs/common';
import { QueryController } from './query.controller';
import { QueryService } from './query.service';

@Module({
  controllers: [QueryController],
  providers: [QueryService],
})
export class QueryModule {}
