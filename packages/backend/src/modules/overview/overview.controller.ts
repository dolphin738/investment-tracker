/**
 * 概览数据聚合控制器
 *
 * 路由前缀：/api/portfolios/:portfolioId/overview
 *
 * 接口：
 * - GET /api/portfolios/:portfolioId/overview — 组合概览聚合数据
 *
 * 只读接口，组合调用现有 service，不写任何数据。
 */

import { Controller, Get, Param } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { OverviewService } from './overview.service';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../../common/decorators/current-user.decorator';

@ApiTags('概览聚合')
@ApiBearerAuth('JWT-auth')
@Controller('portfolios/:portfolioId/overview')
export class OverviewController {
  constructor(private readonly overviewService: OverviewService) {}

  @Get()
  @ApiOperation({ summary: '获取组合概览数据（总资产/净值/XIRR/持仓汇总/近期交易）' })
  async getOverview(
    @CurrentUser() user: AuthenticatedUser,
    @Param('portfolioId') portfolioId: string,
  ) {
    return this.overviewService.getOverview(portfolioId, user.userId);
  }
}
