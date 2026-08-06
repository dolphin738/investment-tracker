/**
 * 分红记录控制器（HOLD-B-P0-10 / 阶段 C · Q-1 A 恢复）
 *
 * 路由前缀：/api/portfolios/:portfolioId/dividends
 * （与前端 `api/dividend.api.ts` 既有调用完全一致，无需改动前端 URL）
 *
 * 接口：
 * - GET    /api/portfolios/:portfolioId/dividends       — 分红列表（可按 securityId 过滤）
 * - POST   /api/portfolios/:portfolioId/dividends       — 新增分红
 * - DELETE /api/portfolios/:portfolioId/dividends/:id   — 删除分红
 *
 * 全局 JwtAuthGuard 已生效，user 由 @CurrentUser() 注入，所有方法透传 userId 做隔离。
 */

import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { DividendService } from './dividend.service';
import type { DividendRecordResponse } from './dividend.service';
import { CreateDividendRecordDto } from './dto/create-dividend-record.dto';
import { UpdateDividendRecordDto } from './dto/update-dividend-record.dto';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../../common/decorators/current-user.decorator';

@ApiTags('分红记录')
@ApiBearerAuth('JWT-auth')
@Controller('portfolios/:portfolioId/dividends')
export class DividendController {
  constructor(private readonly dividendService: DividendService) {}

  @Get()
  @ApiOperation({ summary: '分红记录列表（可按标的过滤，不参与收益计算）' })
  async findAll(
    @CurrentUser() user: AuthenticatedUser,
    @Param('portfolioId') portfolioId: string,
    @Query('securityId') securityId?: string,
  ): Promise<DividendRecordResponse[]> {
    return this.dividendService.findAll(portfolioId, user.userId, securityId);
  }

  @Post()
  @ApiOperation({ summary: '新增分红记录' })
  async create(
    @CurrentUser() user: AuthenticatedUser,
    @Param('portfolioId') portfolioId: string,
    @Body() dto: CreateDividendRecordDto,
  ): Promise<DividendRecordResponse> {
    return this.dividendService.create(portfolioId, user.userId, dto);
  }

  @Patch(':id')
  @ApiOperation({ summary: '编辑分红记录（可改 标的/日期/税前金额/所得税/备注）' })
  async update(
    @CurrentUser() user: AuthenticatedUser,
    @Param('portfolioId') portfolioId: string,
    @Param('id') id: string,
    @Body() dto: UpdateDividendRecordDto,
  ): Promise<DividendRecordResponse> {
    return this.dividendService.update(portfolioId, id, user.userId, dto);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: '删除分红记录' })
  async remove(
    @CurrentUser() user: AuthenticatedUser,
    @Param('portfolioId') portfolioId: string,
    @Param('id') id: string,
  ): Promise<null> {
    return this.dividendService.remove(portfolioId, id, user.userId);
  }
}
