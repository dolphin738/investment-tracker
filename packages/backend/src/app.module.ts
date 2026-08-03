/**
 * AppModule — NestJS 根模块
 *
 * 导入 PrismaModule（全局），后续业务模块在此注册。
 */

import { Module } from '@nestjs/common';
import { PrismaModule } from './prisma/prisma.module';

@Module({
  imports: [PrismaModule],
  controllers: [],
  providers: [],
})
export class AppModule {}
