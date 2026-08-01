/**
 * 查询控制器
 *
 * 路由前缀：/api/portfolios/:portfolioId
 *
 * 接口：
 * - GET /api/portfolios/:portfolioId/xirr          — 查询 XIRR 时间序列（四维度聚合）
 * - GET /api/portfolios/:portfolioId/xirr/latest   — 获取最新 XIRR
 * - GET /api/portfolios/:portfolioId/nav           — 查询净值时间序列（四维度聚合）
 * - GET /api/portfolios/:portfolioId/nav/latest    — 获取最新净值
 *
 * 🆕 T03 增强端点：
 * - GET /api/portfolios/:portfolioId/nav/history   — 净值历史查询（带分页）
 * - GET /api/portfolios/:portfolioId/xirr/history  — XIRR 历史查询（带分页）
 *
 * 注意：交易多维聚合已移至 TransactionController
 * （GET /api/portfolios/:portfolioId/transactions/aggregated）
 * 以避免与 TransactionController 的 :id 路由冲突。
 */

import { Controller, Get, Param, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { QueryService } from './query.service';
import { XirrQueryDto, NavQueryDto } from './dto/query.dto';
import { NavHistoryQueryDto } from './dto/nav-history-query.dto';
import { XirrHistoryQueryDto } from './dto/xirr-history-query.dto';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../../common/decorators/current-user.decorator';

@ApiTags('查询分析')
@ApiBearerAuth('JWT-auth')
@Controller('portfolios/:portfolioId')
export class QueryController {
  constructor(private readonly queryService: QueryService) {}

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
  @ApiOperation({ summary: '净值历史查询（带分页，委托现有聚合逻辑）' })
  async getNavHistory(
    @CurrentUser() user: AuthenticatedUser,
    @Param('portfolioId') portfolioId: string,
    @Query() query: NavHistoryQueryDto,
  ) {
    return this.queryService.getNavHistory(user.userId, portfolioId, query);
  }

  @Get('xirr/history')
  @ApiOperation({ summary: 'XIRR 历史查询（带分页，委托现有聚合逻辑）' })
  async getXirrHistory(
    @CurrentUser() user: AuthenticatedUser,
    @Param('portfolioId') portfolioId: string,
    @Query() query: XirrHistoryQueryDto,
  ) {
    return this.queryService.getXirrHistory(user.userId, portfolioId, query);
  }
}
