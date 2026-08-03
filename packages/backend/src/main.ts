/**
 * NestJS 应用入口
 *
 * 端口 3000，全局异常过滤器 + 响应拦截器。
 * CORS 开启（开发阶段允许 localhost:5173）。
 */

import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { HttpExceptionFilter } from './common/filters/http-exception.filter';
import { ResponseInterceptor } from './common/interceptors/response.interceptor';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule);

  // 全局前缀 /api（对齐 ARCH §4.1）
  app.setGlobalPrefix('api');

  // CORS — 开发阶段允许 Web 前端
  app.enableCors({
    origin: ['http://localhost:5173'],
    credentials: true,
  });

  // 全局异常过滤器 → 响应信封 { code, data, message }
  app.useGlobalFilters(new HttpExceptionFilter());

  // 全局响应拦截器 → 统一包装响应信封
  app.useGlobalInterceptors(new ResponseInterceptor());

  const port = process.env.PORT ?? 3000;
  await app.listen(port);
  console.log(`🚀 Backend listening on http://localhost:${port}`);
}

bootstrap().catch((err: unknown) => {
  console.error('Failed to bootstrap:', err);
  process.exit(1);
});
