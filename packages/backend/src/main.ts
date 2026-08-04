/**
 * NestJS 应用入口（方案B）
 *
 * 端口 3000，全局 ValidationPipe + Swagger + 异常过滤器 + 响应拦截器。
 */

import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { AppModule } from './app.module';
import { HttpExceptionFilter } from './common/filters/http-exception.filter';
import { ResponseInterceptor } from './common/interceptors/response.interceptor';
import {
  resolveUploadDir,
  STATIC_ASSETS_PREFIX,
} from './modules/upload/upload.constants';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule);

  // 全局前缀 /api
  app.setGlobalPrefix('api');

  // 🔴 上传目录静态资源挂载
  //
  // LocalDiskStorage 把头像落盘到 <UPLOAD_DIR>/avatar/<uuid>.<ext>，
  // 对外 URL 是 /api/uploads/avatar/<uuid>.<ext>（见 upload.constants.ts）。
  // 注意：setGlobalPrefix('api') 只作用于 Nest 路由，不作用于 express 静态中间件，
  // 所以 prefix 必须手写含 /api 的 STATIC_ASSETS_PREFIX，否则 GET 头像一律 404。
  const uploadDir = resolveUploadDir((key) => process.env[key]);
  app.useStaticAssets(uploadDir, { prefix: STATIC_ASSETS_PREFIX });

  // CORS
  app.enableCors({
    origin: ['http://localhost:5173'],
    credentials: true,
  });

  // 🔴 全局 ValidationPipe：自动校验 DTO + 转换类型
  app.useGlobalPipes(
    new ValidationPipe({
      transform: true,
      whitelist: true,
      forbidNonWhitelisted: true,
      transformOptions: { enableImplicitConversion: true },
    }),
  );

  // 全局异常过滤器
  app.useGlobalFilters(new HttpExceptionFilter());

  // 全局响应拦截器
  app.useGlobalInterceptors(new ResponseInterceptor());

  // 🔴 Swagger 文档
  const config = new DocumentBuilder()
    .setTitle('投资收益统计系统 API')
    .setDescription('方案B — 资产快照 + 出入金 + 证券买卖 + 标的最新价 + 现金余额')
    .setVersion('1.0')
    .addBearerAuth(
      {
        type: 'http',
        scheme: 'bearer',
        bearerFormat: 'JWT',
        name: 'JWT',
        in: 'header',
      },
      'JWT-auth',
    )
    .build();

  const document = SwaggerModule.createDocument(app, config);
  SwaggerModule.setup('api/docs', app, document);

  const port = process.env.PORT ?? 3000;
  await app.listen(port);
  console.log(`🚀 Backend listening on http://localhost:${port}`);
  console.log(`📚 Swagger docs: http://localhost:${port}/api/docs`);
  console.log(`🖼️  Static uploads: ${STATIC_ASSETS_PREFIX} → ${uploadDir}`);
}

bootstrap().catch((err: unknown) => {
  console.error('Failed to bootstrap:', err);
  process.exit(1);
});
