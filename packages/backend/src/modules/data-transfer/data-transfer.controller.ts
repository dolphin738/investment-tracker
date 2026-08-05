/**
 * 数据导入导出控制器（T05 · AL-042/079/080 + Excel 扩展）
 *
 * 路由（全局前缀 /api）：
 * - GET  /api/portfolios/:portfolioId/export?type=&format=     导出 7 类（csv|xlsx，文件直出不套信封）
 * - GET  /api/data-transfer/template?type=&format=            下载导入模板（csv|xlsx）
 * - POST /api/portfolios/:portfolioId/import/preview          预览（multipart：file + type，不落库）
 * - POST /api/portfolios/:portfolioId/import/commit           提交（type + token，单事务 + 单次重算）
 *
 * 🔴 文件下载接口（export / template）用 `@Res()` 直出文件，绕过全局 ResponseInterceptor 信封；
 *    前端以 responseType:'blob' 接收。preview / commit 返回业务对象，走标准信封。
 */

import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  Res,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBearerAuth, ApiConsumes, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import type {
  ImportPreviewResult,
  ImportCommitResult,
} from '@investment-tracker/shared';
import { DataTransferService, type ExportResult, type MulterFileLike } from './data-transfer.service';
import { ExportQueryDto } from './dto/export-query.dto';
import { TemplateQueryDto } from './dto/template-query.dto';
import { ImportPreviewDto } from './dto/import-preview.dto';
import { ImportCommitDto } from './dto/import-commit.dto';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../../common/decorators/current-user.decorator';

@ApiTags('数据导入导出')
@ApiBearerAuth('JWT-auth')
@Controller()
export class DataTransferController {
  constructor(private readonly dataTransferService: DataTransferService) {}

  @Get('portfolios/:portfolioId/export')
  @ApiOperation({
    summary: '导出数据（7 类，csv/xlsx）',
    description: '文件直出（Content-Disposition: attachment），不套响应信封',
  })
  async exportData(
    @CurrentUser() user: AuthenticatedUser,
    @Param('portfolioId') portfolioId: string,
    @Query() query: ExportQueryDto,
    @Res() res: Response,
  ): Promise<void> {
    const result = await this.dataTransferService.export(
      user.userId,
      portfolioId,
      query,
    );
    this.sendFile(res, result);
  }

  @Get('data-transfer/template')
  @ApiOperation({
    summary: '下载导入模板（3 类，csv/xlsx）',
    description: '表头 + 1 行示例；文件直出，不套响应信封',
  })
  async template(
    @CurrentUser() _user: AuthenticatedUser,
    @Query() query: TemplateQueryDto,
    @Res() res: Response,
  ): Promise<void> {
    const result = this.dataTransferService.template(
      query.type,
      query.format ?? 'csv',
    );
    this.sendFile(res, result);
  }

  @Post('portfolios/:portfolioId/import/preview')
  @HttpCode(HttpStatus.OK)
  @ApiConsumes('multipart/form-data')
  @ApiOperation({
    summary: '导入预览（不落库）',
    description: 'multipart：file（.csv/.xlsx/.xls）+ type；返回前 10 行 + 全量行级错误 + token',
  })
  @UseInterceptors(FileInterceptor('file'))
  async preview(
    @CurrentUser() user: AuthenticatedUser,
    @Param('portfolioId') portfolioId: string,
    @Body() dto: ImportPreviewDto,
    @UploadedFile() file: MulterFileLike | undefined,
  ): Promise<ImportPreviewResult> {
    return this.dataTransferService.preview(
      user.userId,
      portfolioId,
      dto.type,
      file,
    );
  }

  @Post('portfolios/:portfolioId/import/commit')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: '提交导入（单事务 + 单次重算）',
    description: 'type + token；返回 {inserted, updated, skipped, failed, recalculated}',
  })
  async commit(
    @CurrentUser() user: AuthenticatedUser,
    @Param('portfolioId') portfolioId: string,
    @Body() dto: ImportCommitDto,
  ): Promise<ImportCommitResult> {
    return this.dataTransferService.commit(
      user.userId,
      portfolioId,
      dto.type,
      dto.token,
    );
  }

  /** 直出文件（绕过信封） */
  private sendFile(res: Response, result: ExportResult): void {
    res.setHeader('Content-Type', result.contentType);
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${result.filename}"`,
    );
    res.send(result.content);
  }
}
