/**
 * 头像上传服务
 *
 * 职责：校验 → 魔数嗅探 → 落盘 → 清理旧文件 → 更新用户 avatar 字段。
 *
 * 校验顺序（先便宜后昂贵）：
 * 1. 文件存在性  → 1006 请选择要上传的图片文件
 * 2. mimetype 白名单（客户端声明，可伪造，只作快速筛）→ 1006 类型不支持
 * 3. 魔数嗅探（真实内容，决定落盘扩展名）→ 1006 内容与格式不符
 * 4. 大小上限（multer limits 已拦一道，这里兜底 + 覆盖 limits 未生效场景）→ 1006 超过 2MB
 *
 * 错误码统一用 1006（文件校验失败），HTTP 400。
 * 抛出时带上 { code: 1006, message }，FileUploadExceptionFilter 会原样透传文案。
 */

import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import type { UserPublic } from '@investment-tracker/shared';
import { PrismaService } from '../../prisma/prisma.service';
import { toUserPublic } from '../auth/user-public.mapper';
import { StorageService } from './storage/storage.service';
import type { UploadedFileLike } from './upload.types';
import {
  ALLOWED_MIME,
  FILE_INVALID_CODE,
  FILE_MISSING_MESSAGE,
  FILE_SIZE_MESSAGE,
  FILE_TYPE_MESSAGE,
  MAX_SIZE,
  type ImageExt,
} from './upload.constants';

/** uploadAvatar 的返回结构（与 controller 信封里的 data 一致） */
export interface UploadAvatarResult {
  /** 头像可访问地址（相对路径，如 /api/uploads/avatar/<uuid>.png） */
  url: string;
  /** 更新后的用户公开信息 */
  user: UserPublic;
}

/** 内容与声明格式不符时的文案 */
const FILE_CONTENT_MISMATCH_MESSAGE = '图片内容已损坏或与格式不符，仅支持 JPG / PNG / WebP';

/**
 * 魔数嗅探：只看文件头字节，判断真实图片类型。
 *
 * - JPEG: FF D8 FF
 * - PNG : 89 50 4E 47 0D 0A 1A 0A
 * - WebP: 52 49 46 46 ?? ?? ?? ?? 57 45 42 50   ('RIFF' + 4字节长度 + 'WEBP')
 *
 * @param buffer 文件内容
 * @returns 推导出的扩展名；无法识别返回 null
 */
export function sniffImageExt(buffer: Buffer): ImageExt | null {
  if (!Buffer.isBuffer(buffer) || buffer.length < 12) {
    return null;
  }

  // JPEG
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return 'jpg';
  }

  // PNG
  if (
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47 &&
    buffer[4] === 0x0d &&
    buffer[5] === 0x0a &&
    buffer[6] === 0x1a &&
    buffer[7] === 0x0a
  ) {
    return 'png';
  }

  // WebP: 'RIFF' .... 'WEBP'
  if (
    buffer.toString('ascii', 0, 4) === 'RIFF' &&
    buffer.toString('ascii', 8, 12) === 'WEBP'
  ) {
    return 'webp';
  }

  return null;
}

@Injectable()
export class UploadService {
  private readonly logger = new Logger(UploadService.name);

  constructor(
    private readonly storage: StorageService,
    private readonly prisma: PrismaService,
  ) {}

  /** 统一构造 1006 异常 */
  private invalidFile(message: string): BadRequestException {
    return new BadRequestException({ code: FILE_INVALID_CODE, message });
  }

  /**
   * 上传并绑定用户头像
   *
   * @param userId 当前登录用户 ID（来自 @CurrentUser().userId）
   * @param file multer 解析出的文件对象，可能为 undefined（未选文件 / 被 fileFilter 拒绝）
   * @returns 新头像 URL + 更新后的用户公开信息
   * @throws BadRequestException 1006 类型 / 大小 / 内容 / 缺失校验失败
   */
  async uploadAvatar(userId: string, file?: UploadedFileLike): Promise<UploadAvatarResult> {
    // ① 文件存在性
    if (!file || !file.buffer || file.buffer.length === 0) {
      throw this.invalidFile(FILE_MISSING_MESSAGE);
    }

    // ② 声明的 mimetype 白名单
    if (!ALLOWED_MIME.includes(file.mimetype)) {
      throw this.invalidFile(FILE_TYPE_MESSAGE);
    }

    // ③ 魔数嗅探真实类型（扩展名只信内容，不信 originalname）
    const ext = sniffImageExt(file.buffer);
    if (!ext) {
      throw this.invalidFile(FILE_CONTENT_MISMATCH_MESSAGE);
    }

    // ④ 大小上限（size 缺失时退化为 buffer 长度）
    const size = typeof file.size === 'number' ? file.size : file.buffer.length;
    if (size > MAX_SIZE) {
      throw this.invalidFile(FILE_SIZE_MESSAGE);
    }

    // ⑤ 落盘
    const stored = await this.storage.save(file.buffer, ext);

    // ⑥ 读旧头像，写新头像；旧文件删除放在写库之后、且不阻塞响应
    const previous = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { avatar: true },
    });

    const updated = await this.prisma.user.update({
      where: { id: userId },
      data: { avatar: stored.url },
    });

    this.cleanupPrevious(previous?.avatar ?? null, stored.url);

    return { url: stored.url, user: toUserPublic(updated) };
  }

  /**
   * fire-and-forget 清理旧头像文件。
   *
   * 删除失败只告警不抛错：用户的头像已经换成功了，
   * 没必要因为一个残留文件把整个请求判为失败（残留文件由运维定期清理）。
   *
   * @param previousUrl 旧头像 URL（可能为 null / 外链 / 历史脏数据）
   * @param currentUrl 刚写入的新头像 URL，防止自删
   */
  private cleanupPrevious(previousUrl: string | null, currentUrl: string): void {
    if (!previousUrl || previousUrl === currentUrl) {
      return;
    }
    if (!this.storage.canRemove(previousUrl)) {
      // 外链头像 / 非本驱动托管的地址，不做任何删除动作
      return;
    }
    const absPath = this.storage.resolvePath(previousUrl);
    void this.storage.remove(absPath).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(`旧头像文件删除失败（已忽略）: ${absPath} — ${message}`);
    });
  }
}
