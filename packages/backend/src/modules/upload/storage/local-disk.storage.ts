/**
 * 本地磁盘存储驱动
 *
 * 落盘路径：<UPLOAD_DIR>/avatar/<uuid>.<ext>
 * 对外 URL：/api/uploads/avatar/<uuid>.<ext>
 *
 * 安全要点：
 * - 文件名由 crypto.randomUUID() 生成，扩展名由魔数嗅探推导，
 *   完全不使用 file.originalname，杜绝 `../../etc/passwd` 一类的路径穿越。
 * - canRemove() 做三重校验（URL 前缀 / 文件名白名单正则 / resolve 后仍在 baseDir 内），
 *   只有全部通过才允许删除，避免历史脏数据（外链、手填路径）触发误删。
 */

import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  AVATAR_FILENAME_PATTERN,
  AVATAR_URL_PREFIX,
  resolveAvatarDir,
} from '../upload.constants';
import { StorageService, type StoredFile } from './storage.service';

@Injectable()
export class LocalDiskStorage extends StorageService {
  private readonly logger = new Logger(LocalDiskStorage.name);

  /** 头像落盘根目录（绝对路径），构造时解析一次 */
  private readonly baseDir: string;

  constructor(private readonly config: ConfigService) {
    super();
    this.baseDir = resolveAvatarDir((key) => this.config.get<string>(key));
  }

  /** 暴露给测试与诊断使用的头像目录绝对路径 */
  getBaseDir(): string {
    return this.baseDir;
  }

  /**
   * 保存图片到本地磁盘
   *
   * @param buffer 图片二进制内容
   * @param ext 魔数嗅探得到的扩展名（jpg / png / webp）
   */
  async save(buffer: Buffer, ext: string): Promise<StoredFile> {
    // 目录可能在运行期被误删，这里再兜一次底（recursive 已存在不报错）
    await fs.mkdir(this.baseDir, { recursive: true });

    const filename = `${randomUUID()}.${ext}`;
    const absPath = path.join(this.baseDir, filename);
    await fs.writeFile(absPath, buffer);

    return {
      url: `${AVATAR_URL_PREFIX}/${filename}`,
      path: absPath,
    };
  }

  /**
   * 删除磁盘文件。文件不存在（ENOENT）视为成功，其余错误向上抛。
   *
   * @param absPath 文件绝对路径
   */
  async remove(absPath: string): Promise<void> {
    try {
      await fs.unlink(absPath);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') {
        this.logger.debug(`旧头像文件已不存在，跳过删除: ${absPath}`);
        return;
      }
      throw error;
    }
  }

  /**
   * 三重校验：是否是本驱动生成、可安全删除的头像文件。
   *
   * 1. URL 必须以 /api/uploads/avatar/ 开头（排除外链与其它业务资源）
   * 2. 文件名必须匹配 `<uuid>.<jpg|png|webp>`（排除 ..、/、查询串等）
   * 3. path.resolve 之后必须仍在 baseDir 内（最终防线，防符号链接/穿越）
   */
  canRemove(url: string): boolean {
    if (typeof url !== 'string' || url.length === 0) {
      return false;
    }
    const prefix = `${AVATAR_URL_PREFIX}/`;
    if (!url.startsWith(prefix)) {
      return false;
    }

    // 取前缀之后的剩余部分，必须是单一文件名（不含任何路径分隔符）
    const remainder = url.slice(prefix.length);
    if (remainder.includes('/') || remainder.includes('\\')) {
      return false;
    }
    if (!AVATAR_FILENAME_PATTERN.test(remainder)) {
      return false;
    }

    const absPath = path.resolve(this.baseDir, remainder);
    const normalizedBase = path.resolve(this.baseDir);
    return absPath.startsWith(normalizedBase + path.sep);
  }

  /**
   * URL → 磁盘绝对路径。调用方须先通过 canRemove() 校验。
   */
  resolvePath(url: string): string {
    const prefix = `${AVATAR_URL_PREFIX}/`;
    const filename = url.startsWith(prefix) ? url.slice(prefix.length) : path.basename(url);
    return path.resolve(this.baseDir, filename);
  }
}
