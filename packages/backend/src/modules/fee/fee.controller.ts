/**
 * 费用记录控制器（HOLD-B-P0-10 / 阶段 C · Q-1 A 恢复）
 *
 * 路由前缀：/api/portfolios/:portfolioId/fees
 * （与前端 `api/fee.api.ts` 既有调用完全一致，无需改动前端 URL）
 *
 * 接口：
 * - GET    /api/portfolios/:portfolioId/fees       — 费用列表（可按 securityId 过滤）
 * - POST   /api/portfolios/:portfolioId/fees       — 新增费用
 * - DELETE /api/portfolios/:portfolioId/fees/:id   — 删除费用
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
  Post,
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { FeeService } from './fee.service';
import type { FeeRecordResponse } from './fee.service';
import { CreateFeeRecordDto } from './dto/create-fee-record.dto';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../../common/decorators/current-user.decorator';

@ApiTags('费用记录')
@ApiBearerAuth('JWT-auth')
@Controller('portfolios/:portfolioId/fees')
export class FeeController {
  constructor(private readonly feeService: FeeService) {}

  @Get()
  @ApiOperation({ summary: '费用记录列表（可按标的过滤，不参与收益计算）' })
  async findAll(
    @CurrentUser() user: AuthenticatedUser,
    @Param('portfolioId') portfolioId: string,
    @Query('securityId') securityId?: string,
  ): Promise<FeeRecordResponse[]> {
    return this.feeService.findAll(portfolioId, user.userId, securityId);
  }

  @Post()
  @ApiOperation({ summary: '新增费用记录' })
  async create(
    @CurrentUser() user: AuthenticatedUser,
    @Param('portfolioId') portfolioId: string,
    @Body() dto: CreateFeeRecordDto,
  ): Promise<FeeRecordResponse> {
    return this.feeService.create(portfolioId, user.userId, dto);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: '删除费用记录' })
  async remove(
    @CurrentUser() user: AuthenticatedUser,
    @Param('portfolioId') portfolioId: string,
    @Param('id') id: string,
  ): Promise<null> {
    return this.feeService.remove(portfolioId, id, user.userId);
  }
}
