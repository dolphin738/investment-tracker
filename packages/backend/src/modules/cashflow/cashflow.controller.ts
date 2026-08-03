/**
 * CashFlow Controller — 出入金流水 API
 *
 * 路由前缀：/api/portfolios/:portfolioId/cashflows
 *
 * 接口：
 * - GET    /api/portfolios/:portfolioId/cashflows     — 分页查询
 * - POST   /api/portfolios/:portfolioId/cashflows     — 创建
 * - GET    /api/portfolios/:portfolioId/cashflows/:id — 获取单条
 * - PATCH  /api/portfolios/:portfolioId/cashflows/:id — 更新
 * - DELETE /api/portfolios/:portfolioId/cashflows/:id — 删除
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
import { CashFlowService } from './cashflow.service';
import { CreateCashFlowDto, UpdateCashFlowDto, CashFlowQueryDto } from './cashflow.dto';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../../common/decorators/current-user.decorator';

@ApiTags('出入金管理')
@ApiBearerAuth('JWT-auth')
@Controller('portfolios/:portfolioId/cashflows')
export class CashFlowController {
  constructor(private readonly cashFlowService: CashFlowService) {}

  @Post()
  @ApiOperation({ summary: '创建出入金流水' })
  async create(
    @CurrentUser() user: AuthenticatedUser,
    @Param('portfolioId') portfolioId: string,
    @Body() dto: CreateCashFlowDto,
  ) {
    return this.cashFlowService.create(user.userId, portfolioId, dto);
  }

  @Get()
  @ApiOperation({ summary: '查询出入金流水列表（分页 + 日期范围）' })
  async findAll(
    @CurrentUser() user: AuthenticatedUser,
    @Param('portfolioId') portfolioId: string,
    @Query() query: CashFlowQueryDto,
  ) {
    return this.cashFlowService.findAll(user.userId, portfolioId, query);
  }

  @Get(':id')
  @ApiOperation({ summary: '获取单条出入金流水' })
  async findOne(
    @CurrentUser() user: AuthenticatedUser,
    @Param('portfolioId') portfolioId: string,
    @Param('id') id: string,
  ) {
    return this.cashFlowService.findOne(user.userId, portfolioId, id);
  }

  @Patch(':id')
  @ApiOperation({ summary: '更新出入金流水' })
  async update(
    @CurrentUser() user: AuthenticatedUser,
    @Param('portfolioId') portfolioId: string,
    @Param('id') id: string,
    @Body() dto: UpdateCashFlowDto,
  ) {
    return this.cashFlowService.update(user.userId, portfolioId, id, dto);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: '删除出入金流水' })
  async remove(
    @CurrentUser() user: AuthenticatedUser,
    @Param('portfolioId') portfolioId: string,
    @Param('id') id: string,
  ) {
    return this.cashFlowService.remove(user.userId, portfolioId, id);
  }
}
