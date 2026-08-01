/**
 * 持仓管理控制器
 *
 * 路由前缀：/api/portfolios/:portfolioId/holdings
 *
 * 接口：
 * - GET    /api/portfolios/:portfolioId/holdings          — 持仓明细（含派生字段 + 汇总）
 * - PUT    /api/portfolios/:portfolioId/holdings          — 持仓 upsert
 * - GET    /api/portfolios/:portfolioId/holdings/aggregate — 持仓汇总
 * - GET    /api/portfolios/:portfolioId/holdings/dates    — 有持仓数据的日期列表
 * - DELETE /api/portfolios/:portfolioId/holdings/:id       — 删除单条持仓
 *
 * ⚠️ 所有接口不触发计算引擎（C-09）
 */

import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Put,
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { HoldingService } from './holding.service';
import { UpsertHoldingDto } from './dto/upsert-holding.dto';
import { HoldingQueryDto } from './dto/holding-query.dto';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../../common/decorators/current-user.decorator';

@ApiTags('持仓管理')
@ApiBearerAuth('JWT-auth')
@Controller('portfolios/:portfolioId/holdings')
export class HoldingController {
  constructor(private readonly holdingService: HoldingService) {}

  @Get()
  @ApiOperation({ summary: '持仓明细（含派生字段 + 汇总）' })
  async findAll(
    @CurrentUser() user: AuthenticatedUser,
    @Param('portfolioId') portfolioId: string,
    @Query() query: HoldingQueryDto,
  ) {
    return this.holdingService.findAllByPortfolio(portfolioId, user.userId, query);
  }

  @Get('aggregate')
  @ApiOperation({ summary: '持仓汇总（总市值/总成本/总盈亏/标的数）' })
  async getAggregate(
    @CurrentUser() user: AuthenticatedUser,
    @Param('portfolioId') portfolioId: string,
    @Query('date') date?: string,
  ) {
    return this.holdingService.getAggregate(portfolioId, user.userId, date);
  }

  @Get('dates')
  @ApiOperation({ summary: '有持仓数据的日期列表' })
  async getDates(
    @CurrentUser() user: AuthenticatedUser,
    @Param('portfolioId') portfolioId: string,
  ) {
    return this.holdingService.getAvailableDates(portfolioId, user.userId);
  }

  @Put()
  @ApiOperation({ summary: '持仓 upsert（securityId + date 唯一）' })
  async upsert(
    @CurrentUser() user: AuthenticatedUser,
    @Param('portfolioId') portfolioId: string,
    @Body() dto: UpsertHoldingDto,
  ) {
    return this.holdingService.upsert(portfolioId, user.userId, dto);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: '删除单条持仓记录' })
  async remove(
    @CurrentUser() user: AuthenticatedUser,
    @Param('portfolioId') portfolioId: string,
    @Param('id') id: string,
  ) {
    return this.holdingService.remove(portfolioId, id, user.userId);
  }
}
