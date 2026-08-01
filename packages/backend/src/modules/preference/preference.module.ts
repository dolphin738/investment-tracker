/**
 * 用户偏好模块
 *
 * 偏好设置服务端持久化（SET-P0-02）。
 * 列式存储（非 JSON），按 userId 唯一。
 */

import { Module } from '@nestjs/common';
import { PreferenceController } from './preference.controller';
import { PreferenceService } from './preference.service';

@Module({
  controllers: [PreferenceController],
  providers: [PreferenceService],
  exports: [PreferenceService],
})
export class PreferenceModule {}
