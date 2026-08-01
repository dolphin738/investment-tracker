/**
 * 文件上传控制器
 *
 * 路由前缀：/api/upload（全局前缀 /api + 控制器前缀 upload）
 *
 * 接口：
 * - POST /api/upload/avatar — 上传并绑定当前用户头像（需认证）
 *
 * 设计要点：
 * - 表单只接收 file 一个 part，不带任何额外字段，
 *   天然规避全局 ValidationPipe 的 forbidNonWhitelisted。
 * - multer 用内存存储（未配置 dest/storage），文件在 buffer 里，由 StorageService 决定落盘位置。
 * - fileFilter 直接 cb(BadRequestException)：Nest 的 transformException 对 HttpException 原样放行，
 *   这样「传了 PDF」能返回精确的 1006 类型文案，而不是退化成「请选择要上传的图片文件」。
 * - 直接 return 完整信封 { code, data, message }：TransformInterceptor 检测到 number 型 code 会跳过二次包装。
 */

import {
  BadRequestException,
  Controller,
  HttpCode,
  HttpStatus,
  Post,
  UploadedFile,
  UseFilters,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBearerAuth, ApiBody, ApiConsumes, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../../common/decorators/current-user.decorator';
import { FileUploadExceptionFilter } from './filters/file-upload-exception.filter';
import { UploadService } from './upload.service';
import type { UploadAvatarResult } from './upload.service';
import type { UploadedFileLike } from './upload.types';
import {
  ALLOWED_MIME,
  FILE_INVALID_CODE,
  FILE_TYPE_MESSAGE,
  MAX_SIZE,
} from './upload.constants';

/** 上传成功响应信封 */
interface UploadAvatarEnvelope {
  code: number;
  data: UploadAvatarResult;
  message: string;
}

@ApiTags('文件上传')
@Controller('upload')
export class UploadController {
  constructor(private readonly uploadService: UploadService) {}

  @Post('avatar')
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth('JWT-auth')
  @ApiConsumes('multipart/form-data')
  @ApiOperation({ summary: '上传头像（JPG / PNG / WebP，≤ 2MB）' })
  @ApiBody({
    schema: {
      type: 'object',
      required: ['file'],
      properties: {
        file: { type: 'string', format: 'binary', description: '头像图片文件' },
      },
    },
  })
  @UseInterceptors(
    FileInterceptor('file', {
      limits: { fileSize: MAX_SIZE },
      fileFilter: (
        _req: unknown,
        file: { mimetype: string },
        cb: (error: Error | null, acceptFile: boolean) => void,
      ): void => {
        if (ALLOWED_MIME.includes(file.mimetype)) {
          cb(null, true);
          return;
        }
        // 带业务码抛出，过滤器会原样透传精确文案
        cb(
          new BadRequestException({ code: FILE_INVALID_CODE, message: FILE_TYPE_MESSAGE }),
          false,
        );
      },
    }),
  )
  @UseFilters(FileUploadExceptionFilter)
  async uploadAvatar(
    @CurrentUser() user: AuthenticatedUser,
    @UploadedFile() file: UploadedFileLike,
  ): Promise<UploadAvatarEnvelope> {
    // M1：JWT 挂载的用户对象字段是 userId（不是 id）
    const result = await this.uploadService.uploadAvatar(user.userId, file);
    return { code: 0, data: result, message: '上传成功' };
  }
}
