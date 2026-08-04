/**
 * 查询控制器（组合级）
 *
 * 路由前缀：/api/portfolios/:portfolioId
 *
 * 接口：
 * - GET /api/portfolios/:portfolioId/xirr          — 查询 XIRR 时间序列
 * - GET /api/portfolios/:portfolioId/xirr/latest   — 获取最新 XIRR
 * - GET /api/portfolios/:portfolioId/nav           — 查询净值时间序列
 * - GET /api/portfolios/:portfolioId/nav/latest    — 获取最新净值
 * - GET /api/portfolios/:portfolioId/nav/history   — 净值历史（带分页）
 * - GET /api/portfolios/:portfolioId/xirr/history  — XIRR 历史（带分页）
 * - GET /api/portfolios/:portfolioId/summary       — 组合统计摘要
 * - POST /api/portfolios/:portfolioId/recalculate-range  — 手动触发区间重算
 * - GET /api/portfolios/:portfolioId/metrics/drawdown — 最大回撤
 */

import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { QueryService } from './query.service';
import { QueryServiceEnhanced } from './query-enhanced.service';
import { XirrQueryDto, NavQueryDto } from './dto/query.dto';
import { NavHistoryQueryDto } from './dto/nav-history-query.dto';
import { XirrHistoryQueryDto } from './dto/xirr-history-query.dto';
import { RecalculateDto, DrawdownQueryDto } from './dto/query-ext.dto';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../../common/decorators/current-user.decorator';

@ApiTags('查询分析')
@ApiBearerAuth('JWT-auth')
@Controller('portfolios/:portfolioId')
export class QueryController {
  constructor(
    private readonly queryService: QueryService,
    private readonly queryEnhanced: QueryServiceEnhanced,
  ) {}

  // ─────────────── 现有端点 ───────────────

  @Get('xirr')
  @ApiOperation({ summary: '查询 XIRR 时间序列（日/周/月/年聚合）' })
  async queryXirrSeries(
    @CurrentUser() user: AuthenticatedUser,
    @Param('portfolioId') portfolioId: string,
    @Query() query: XirrQueryDto,
  ) {
    return this.queryService.queryXirrSeries(user.userId, portfolioId, query);
  }

  @Get('xirr/latest')
  @ApiOperation({ summary: '获取最新 XIRR' })
  async getLatestXirr(
    @CurrentUser() user: AuthenticatedUser,
    @Param('portfolioId') portfolioId: string,
  ) {
    return this.queryService.getLatestXirr(user.userId, portfolioId);
  }

  @Get('nav')
  @ApiOperation({ summary: '查询净值时间序列（日/周/月/年聚合）' })
  async queryNavSeries(
    @CurrentUser() user: AuthenticatedUser,
    @Param('portfolioId') portfolioId: string,
    @Query() query: NavQueryDto,
  ) {
    return this.queryService.queryNavSeries(user.userId, portfolioId, query);
  }

  @Get('nav/latest')
  @ApiOperation({ summary: '获取最新净值' })
  async getLatestNav(
    @CurrentUser() user: AuthenticatedUser,
    @Param('portfolioId') portfolioId: string,
  ) {
    return this.queryService.getLatestNav(user.userId, portfolioId);
  }

  // ─────────────── 🆕 T03 增强端点 ───────────────

  @Get('nav/history')
  @ApiOperation({ summary: '净值历史查询（带分页）' })
  async getNavHistory(
    @CurrentUser() user: AuthenticatedUser,
    @Param('portfolioId') portfolioId: string,
    @Query() query: NavHistoryQueryDto,
  ) {
    return this.queryService.getNavHistory(user.userId, portfolioId, query);
  }

  @Get('xirr/history')
  @ApiOperation({ summary: 'XIRR 历史查询（带分页）' })
  async getXirrHistory(
    @CurrentUser() user: AuthenticatedUser,
    @Param('portfolioId') portfolioId: string,
    @Query() query: XirrHistoryQueryDto,
  ) {
    return this.queryService.getXirrHistory(user.userId, portfolioId, query);
  }

  @Get('summary')
  @ApiOperation({ summary: '获取组合统计摘要（Dashboard 卡片）' })
  async getPortfolioSummary(
    @CurrentUser() user: AuthenticatedUser,
    @Param('portfolioId') portfolioId: string,
  ) {
    return this.queryEnhanced.getPortfolioSummary(user.userId, portfolioId);
  }

  @Post('recalculate-range')
  @ApiOperation({ summary: '手动触发区间批量重算' })
  async recalculate(
    @CurrentUser() user: AuthenticatedUser,
    @Param('portfolioId') portfolioId: string,
    @Body() body: RecalculateDto,
  ) {
    return this.queryEnhanced.triggerRecalculate(
      user.userId,
      portfolioId,
      body.startDate,
      body.endDate,
    );
  }

  @Get('metrics/drawdown')
  @ApiOperation({ summary: '最大回撤时间序列' })
  async getDrawdown(
    @CurrentUser() user: AuthenticatedUser,
    @Param('portfolioId') portfolioId: string,
    @Query() query: DrawdownQueryDto,
  ) {
    return this.queryEnhanced.getDrawdown(
      user.userId,
      portfolioId,
      query.startDate,
      query.endDate,
    );
  }
}
