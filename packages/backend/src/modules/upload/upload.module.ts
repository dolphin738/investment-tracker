/**
 * 上传模块
 *
 * StorageService 采用 factory provider，按 STORAGE_DRIVER 环境变量选择实现：
 * - local（默认）→ LocalDiskStorage，落盘到 UPLOAD_DIR
 * - cos / s3      → 预留，接入时新增子类并在此分支返回
 *
 * 业务层（UploadService）只依赖 StorageService 抽象，切换驱动零改动。
 */

import { Logger, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { UploadController } from './upload.controller';
import { UploadService } from './upload.service';
import { StorageService } from './storage/storage.service';
import { LocalDiskStorage } from './storage/local-disk.storage';
import { DEFAULT_STORAGE_DRIVER, STORAGE_DRIVER_ENV } from './upload.constants';

/**
 * 根据配置创建存储驱动实例
 *
 * @param config Nest 配置服务
 * @returns 具体的存储驱动
 */
export function storageServiceFactory(config: ConfigService): StorageService {
  const driver = (config.get<string>(STORAGE_DRIVER_ENV) || DEFAULT_STORAGE_DRIVER)
    .trim()
    .toLowerCase();

  switch (driver) {
    case 'local':
      return new LocalDiskStorage(config);
    // TODO(P2): case 'cos': return new CosStorage(config);  // 腾讯云对象存储
    // TODO(P2): case 's3':  return new S3Storage(config);   // AWS S3 / MinIO
    default:
      new Logger('UploadModule').warn(
        `未知的 STORAGE_DRIVER="${driver}"，已回退到 local 本地磁盘存储`,
      );
      return new LocalDiskStorage(config);
  }
}

@Module({
  controllers: [UploadController],
  providers: [
    UploadService,
    {
      provide: StorageService,
      useFactory: storageServiceFactory,
      inject: [ConfigService],
    },
  ],
  exports: [UploadService, StorageService],
})
export class UploadModule {}
