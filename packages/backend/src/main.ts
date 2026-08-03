/**
 * NestJS 应用入口（方案B）
 *
 * 端口 3000，全局 ValidationPipe + Swagger + 异常过滤器 + 响应拦截器。
 */

import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { AppModule } from './app.module';
import { HttpExceptionFilter } from './common/filters/http-exception.filter';
import { ResponseInterceptor } from './common/interceptors/response.interceptor';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule);

  // 全局前缀 /api
  app.setGlobalPrefix('api');

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
}

bootstrap().catch((err: unknown) => {
  console.error('Failed to bootstrap:', err);
  process.exit(1);
});
