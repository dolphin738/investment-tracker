/**
 * 组合管理控制器
 *
 * 路由前缀：/api/portfolios
 *
 * 接口：
 * - GET    /api/portfolios          — 获取当前用户组合列表
 * - GET    /api/portfolios/summary  — 全部组合摘要（name/id/总资产/持仓数/更新时间）
 * - POST   /api/portfolios          — 创建组合
 * - GET    /api/portfolios/:id      — 获取组合详情
 * - PATCH  /api/portfolios/:id      — 更新组合
 * - DELETE /api/portfolios/:id      — 删除组合（级联删除子数据）
 * - PATCH  /api/portfolios/:id/archive — 归档 / 取消归档组合
 * - POST   /api/portfolios/:id/recalculate — 全量重算净值与 XIRR
 *
 * 全局 JwtAuthGuard 已保证所有路由需鉴权；组合归属校验在 Service 层完成。
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
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { PortfolioService } from './portfolio.service';
import { CreatePortfolioDto } from './dto/create-portfolio.dto';
import { UpdatePortfolioDto } from './dto/update-portfolio.dto';
import { ArchivePortfolioDto } from './dto/archive-portfolio.dto';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../../common/decorators/current-user.decorator';

@ApiTags('组合管理')
@ApiBearerAuth('JWT-auth')
@Controller('portfolios')
export class PortfolioController {
  constructor(private readonly portfolioService: PortfolioService) {}

  @Get()
  @ApiOperation({ summary: '获取当前用户组合列表' })
  async findAll(@CurrentUser() user: AuthenticatedUser) {
    return this.portfolioService.findAll(user.userId);
  }

  @Get('summary')
  @ApiOperation({
    summary: '获取全部组合摘要（name/id/总资产/持仓数/最近更新时间）',
    description: '供概览页对比（DASH-P1-01）+ 账户页列表（ACC-P0-04）共用。一次查询返回全部组合摘要。',
  })
  async getSummary(@CurrentUser() user: AuthenticatedUser) {
    return this.portfolioService.getSummary(user.userId);
  }

  @Post()
  @ApiOperation({ summary: '创建组合' })
  async create(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CreatePortfolioDto,
  ) {
    return this.portfolioService.create(user.userId, dto.name, dto.description);
  }

  @Get(':id')
  @ApiOperation({ summary: '获取组合详情' })
  async findOne(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
  ) {
    return this.portfolioService.findOne(user.userId, id);
  }

  @Patch(':id')
  @ApiOperation({ summary: '更新组合' })
  async update(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: UpdatePortfolioDto,
  ) {
    return this.portfolioService.update(user.userId, id, dto);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: '删除组合（级联删除子数据）' })
  async remove(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
  ) {
    return this.portfolioService.remove(user.userId, id);
  }

  @Patch(':id/archive')
  @ApiOperation({
    summary: '归档 / 取消归档组合',
    description:
      'body.archived: true 或缺省 → 归档（archivedAt=now）；archived: false → 取消归档（archivedAt=null）。',
  })
  async archive(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: ArchivePortfolioDto,
  ) {
    return this.portfolioService.archive(user.userId, id, dto);
  }

  @Post(':id/recalculate')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: '全量重算组合净值与 XIRR',
    description:
      '从组合成立日（第一笔买入日）重算到最后一个有快照的日期。' +
      '用于计算口径变更或历史数据修复后重建全部净值/XIRR。组合尚无买入交易时返回 400。',
  })
  async recalculate(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
  ) {
    return this.portfolioService.recalculateAll(user.userId, id);
  }
}
