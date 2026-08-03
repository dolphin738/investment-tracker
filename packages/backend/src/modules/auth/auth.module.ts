/**
 * 认证模块
 *
 * 配置 JwtModule（异步注册，从环境变量读取 secret 和 expiresIn），
 * 提供 AuthService 和 JwtStrategy，导出 AuthService 供其他模块使用。
 */

import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { ScheduleModule } from '@nestjs/schedule';
import { AuthService } from './auth.service';
import { AuthController } from './auth.controller';
import { JwtStrategy } from './jwt.strategy';
import { CleanupService } from './cleanup.service';

@Module({
  imports: [
    // 定时任务调度（驱动 CleanupService 的 @Cron）
    ScheduleModule.forRoot(),
    PassportModule.register({ defaultStrategy: 'jwt' }),
    JwtModule.registerAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        secret: config.get<string>('JWT_SECRET'),
        signOptions: {
          expiresIn: config.get<string>('JWT_EXPIRES_IN') || '7d',
        },
      }),
    }),
  ],
  controllers: [AuthController],
  providers: [AuthService, JwtStrategy, CleanupService],
  exports: [AuthService],
})
export class AuthModule {}
