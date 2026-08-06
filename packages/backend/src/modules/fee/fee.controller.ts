/**
 * 费用记录控制器（HOLD-B-P0-10 / 阶段 C · Q-1 A 恢复 + 增量 I-03）
 *
 * 路由前缀：/api/portfolios/:portfolioId/fees
 *
 * 接口：
 * - GET    /api/portfolios/:portfolioId/fees            — 费用列表（可按 securityId/scenario/日期范围过滤；grouped=1 按合并键聚合）
 * - POST   /api/portfolios/:portfolioId/fees            — 新增费用（scenario 服务层推断）
 * - PATCH  /api/portfolios/:portfolioId/fees/:id        — 编辑费用（修正场景/金额等，I-03）
 * - DELETE /api/portfolios/:portfolioId/fees/:id        — 删除费用
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
import {
  ApiBearerAuth,
  ApiOperation,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';
import { FeeService } from './fee.service';
import type { FeeRecordResponse, FeeGroupedRow } from './fee.service';
import { CreateFeeRecordDto } from './dto/create-fee-record.dto';
import { UpdateFeeRecordDto } from './dto/update-fee-record.dto';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../../common/decorators/current-user.decorator';
import { FeeScenario } from '@prisma/client';

@ApiTags('费用记录')
@ApiBearerAuth('JWT-auth')
@Controller('portfolios/:portfolioId/fees')
export class FeeController {
  constructor(private readonly feeService: FeeService) {}

  @Get()
  @ApiOperation({
    summary:
      '费用记录列表（可按标的/场景/日期范围过滤，grouped=1 按合并键聚合；不参与收益计算）',
  })
  @ApiQuery({ name: 'securityId', required: false, description: '标的 ID（支持逗号分隔多值）' })
  @ApiQuery({ name: 'scenario', required: false, enum: FeeScenario, description: '费用场景：BUY 买入时 / SELL 卖出时' })
  @ApiQuery({ name: 'startDate', required: false, description: '起始日期 YYYY-MM-DD（含）' })
  @ApiQuery({ name: 'endDate', required: false, description: '结束日期 YYYY-MM-DD（含）' })
  @ApiQuery({ name: 'grouped', required: false, description: 'grouped=1 按合并键聚合（I-03）；缺省返回明细行' })
  async findAll(
    @CurrentUser() user: AuthenticatedUser,
    @Param('portfolioId') portfolioId: string,
    @Query('securityId') securityId?: string,
    @Query('scenario') scenario?: FeeScenario,
    @Query('startDate') startDate?: string,
    @Query('endDate') endDate?: string,
    @Query('grouped') grouped?: string,
  ): Promise<FeeRecordResponse[] | FeeGroupedRow[]> {
    return this.feeService.findAll(portfolioId, user.userId, {
      securityId,
      scenario,
      startDate,
      endDate,
      grouped: grouped === '1',
    });
  }

  @Post()
  @ApiOperation({ summary: '新增费用记录（场景按 transactionId 推断，无法推断默认 BUY）' })
  async create(
    @CurrentUser() user: AuthenticatedUser,
    @Param('portfolioId') portfolioId: string,
    @Body() dto: CreateFeeRecordDto,
  ): Promise<FeeRecordResponse> {
    return this.feeService.create(portfolioId, user.userId, dto);
  }

  @Patch(':id')
  @ApiOperation({ summary: '编辑费用记录（可改 标的/日期/金额/类型/场景/备注，I-03）' })
  async update(
    @CurrentUser() user: AuthenticatedUser,
    @Param('portfolioId') portfolioId: string,
    @Param('id') id: string,
    @Body() dto: UpdateFeeRecordDto,
  ): Promise<FeeRecordResponse> {
    return this.feeService.update(portfolioId, id, user.userId, dto);
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
