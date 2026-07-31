/**
 * PrismaService — PrismaClient 的 NestJS 封装
 *
 * 继承 PrismaClient，实现 NestJS 生命周期钩子：
 * - onModuleInit：应用启动时连接数据库
 * - onModuleDestroy：应用关闭时断开连接
 *
 * 通过 @Injectable() 装饰器使其可被 NestJS DI 容器注入。
 */

import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PrismaService.name);

  /**
   * 应用模块初始化时连接数据库
   */
  async onModuleInit(): Promise<void> {
    try {
      await this.$connect();
      this.logger.log('Prisma 数据库连接已建立');
    } catch (error) {
      this.logger.error(
        `Prisma 数据库连接失败: ${(error as Error).message}`,
      );
      // 不抛出异常，允许 NestJS 在无数据库情况下启动（便于验证框架启动）
    }
  }

  /**
   * 应用模块销毁时断开数据库连接
   */
  async onModuleDestroy(): Promise<void> {
    try {
      await this.$disconnect();
      this.logger.log('Prisma 数据库连接已断开');
    } catch (error) {
      this.logger.error(
        `Prisma 数据库断开失败: ${(error as Error).message}`,
      );
    }
  }
}
