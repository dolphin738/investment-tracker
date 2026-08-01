/**
 * NestJS 应用入口
 *
 * 启动配置：
 * - 全局前缀 /api（所有路由自动添加 /api 前缀）
 * - CORS 跨域（支持自建服务器部署，源通过 CORS_ORIGIN 环境变量配置）
 * - ValidationPipe 全局校验（class-validator + class-transformer）
 * - 静态资源 /api/uploads（用户上传的头像等文件）
 * - Swagger 文档（/api/docs，仅开发环境启用）
 */

import { NestFactory } from '@nestjs/core';
import { ValidationPipe, Logger } from '@nestjs/common';
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';
import type { NestExpressApplication } from '@nestjs/platform-express';
import * as fs from 'node:fs/promises';
import { AppModule } from './app.module';
import { PrismaService } from './prisma/prisma.service';
import {
  AVATAR_SUBDIR,
  STATIC_ASSETS_PREFIX,
  resolveAvatarDir,
  resolveUploadDir,
} from './modules/upload/upload.constants';

async function bootstrap(): Promise<void> {
  const logger = new Logger('Bootstrap');
  const app = await NestFactory.create<NestExpressApplication>(AppModule);

  // ---- 全局前缀 ----
  app.setGlobalPrefix('api');

  // ---- CORS 跨域 ----
  const corsOrigin = process.env.CORS_ORIGIN || 'http://localhost:5173';
  app.enableCors({
    origin: corsOrigin.split(',').map((o) => o.trim()),
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    credentials: true,
  });

  // ---- 全局校验管道 ----
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true, // 剥离未声明的属性
      forbidNonWhitelisted: true, // 存在未声明属性时报错
      transform: true, // 自动类型转换（query 参数 string → number/Date 等）
      transformOptions: {
        enableImplicitConversion: true,
      },
    }),
  );

  // ---- 静态资源：用户上传文件 ----
  // 注意：setGlobalPrefix('api') 不作用于 express 静态中间件，
  // 所以 prefix 必须手写 /api，否则 vite 的 /api 代理转发不到（P0-5）。
  const uploadDir = resolveUploadDir((key) => process.env[key]);
  const avatarDir = resolveAvatarDir((key) => process.env[key]);
  await fs.mkdir(avatarDir, { recursive: true });
  app.useStaticAssets(uploadDir, { prefix: STATIC_ASSETS_PREFIX });
  logger.log(`📁 上传目录: ${uploadDir}（子目录 ${AVATAR_SUBDIR}）`);
  logger.log(`🖼️  静态资源已挂载: ${STATIC_ASSETS_PREFIX}`);

  // ---- Swagger 文档（仅开发环境） ----
  if (process.env.NODE_ENV !== 'production') {
    const config = new DocumentBuilder()
      .setTitle('投资收益统计系统 API')
      .setDescription('基于 XIRR 的多端投资组合收益与净值追踪平台 — RESTful API 文档')
      .setVersion('1.0.0')
      .addBearerAuth(
        {
          type: 'http',
          scheme: 'bearer',
          bearerFormat: 'JWT',
          name: 'Authorization',
          description: '输入 JWT Token',
          in: 'header',
        },
        'JWT-auth',
      )
      .build();
    const document = SwaggerModule.createDocument(app, config);
    const swaggerPath = process.env.SWAGGER_PATH || 'docs';
    SwaggerModule.setup(swaggerPath, app, document);
    logger.log(`Swagger 文档: http://localhost:${process.env.PORT || 3000}/api/${swaggerPath}`);
  }

  // ---- Prisma 连接（可选，数据库未就绪时不阻塞启动） ----
  try {
    const prismaService = app.get(PrismaService);
    await prismaService.$connect();
    logger.log('✅ Prisma 数据库连接成功');
  } catch (error) {
    logger.warn(
      `⚠️  Prisma 数据库连接失败（NestJS 仍可启动，但数据库功能不可用）: ${(error as Error).message}`,
    );
    logger.warn('   请检查 PostgreSQL 是否运行、DATABASE_URL 是否正确配置');
  }

  // ---- 启动服务 ----
  const port = process.env.PORT || 3000;
  await app.listen(port);
  logger.log(`🚀 应用已启动: http://localhost:${port}/api`);
}

bootstrap();
