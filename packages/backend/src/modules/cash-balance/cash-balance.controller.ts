/**
 * CashBalance Controller — 现金余额 API
 *
 * 路由前缀：/api/portfolios/:portfolioId/cash-balances
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
import { CashBalanceService } from './cash-balance.service';
import { UpsertCashBalanceDto, CashBalanceQueryDto } from './cash-balance.dto';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../../common/decorators/current-user.decorator';

@ApiTags('现金余额')
@ApiBearerAuth('JWT-auth')
@Controller('portfolios/:portfolioId/cash-balances')
export class CashBalanceController {
  constructor(private readonly cashBalanceService: CashBalanceService) {}

  @Post()
  @ApiOperation({ summary: '录入/覆盖现金余额（同日期覆盖旧值）' })
  async upsert(
    @CurrentUser() user: AuthenticatedUser,
    @Param('portfolioId') portfolioId: string,
    @Body() dto: UpsertCashBalanceDto,
  ) {
    return this.cashBalanceService.upsert(user.userId, portfolioId, dto);
  }

  @Get()
  @ApiOperation({ summary: '查询现金余额列表（分页 + 日期范围）' })
  async findAll(
    @CurrentUser() user: AuthenticatedUser,
    @Param('portfolioId') portfolioId: string,
    @Query() query: CashBalanceQueryDto,
  ) {
    return this.cashBalanceService.findAll(user.userId, portfolioId, query);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: '删除现金余额记录' })
  async remove(
    @CurrentUser() user: AuthenticatedUser,
    @Param('portfolioId') portfolioId: string,
    @Param('id') id: string,
  ) {
    return this.cashBalanceService.remove(user.userId, portfolioId, id);
  }
}
