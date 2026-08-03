/**
 * 多组合对比控制器
 *
 * 路由前缀：/api/portfolios
 *
 * GET /api/portfolios/summary — 多组合对比摘要
 */

import { Controller, Get } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { QueryServiceEnhanced } from './query-enhanced.service';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../../common/decorators/current-user.decorator';

@ApiTags('查询分析')
@ApiBearerAuth('JWT-auth')
@Controller('portfolios')
export class PortfolioSummaryController {
  constructor(private readonly queryEnhanced: QueryServiceEnhanced) {}

  @Get('summary')
  @ApiOperation({ summary: '多组合对比摘要' })
  async getMultiPortfolioSummary(@CurrentUser() user: AuthenticatedUser) {
    return this.queryEnhanced.getMultiPortfolioSummary(user.userId);
  }
}
