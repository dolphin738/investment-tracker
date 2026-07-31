/**
 * PrismaModule — 全局提供 PrismaService
 *
 * 通过 @Global() 装饰器使 PrismaService 在整个应用中可注入，
 * 各业务模块无需重复 import。
 */

import { Global, Module } from '@nestjs/common';
import { PrismaService } from './prisma.service';

@Global()
@Module({
  providers: [PrismaService],
  exports: [PrismaService],
})
export class PrismaModule {}
