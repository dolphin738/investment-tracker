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
 */

import { Controller, Get, Param, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { QueryService } from './query.service';
import { XirrQueryDto, NavQueryDto } from './dto/query.dto';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../../common/decorators/current-user.decorator';

@ApiTags('查询分析')
@ApiBearerAuth('JWT-auth')
@Controller('portfolios/:portfolioId')
export class QueryController {
  constructor(private readonly queryService: QueryService) {}

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
}
