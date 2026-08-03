/**
 * SecurityTrade Controller — 证券买卖流水 API
 *
 * 路由前缀：/api/portfolios/:portfolioId/security-trades
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
import { SecurityTradeService } from './security-trade.service';
import {
  CreateSecurityTradeDto,
  UpdateSecurityTradeDto,
  SecurityTradeQueryDto,
} from './security-trade.dto';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../../common/decorators/current-user.decorator';

@ApiTags('证券买卖')
@ApiBearerAuth('JWT-auth')
@Controller('portfolios/:portfolioId/security-trades')
export class SecurityTradeController {
  constructor(private readonly securityTradeService: SecurityTradeService) {}

  @Post()
  @ApiOperation({ summary: '创建证券买卖流水' })
  async create(
    @CurrentUser() user: AuthenticatedUser,
    @Param('portfolioId') portfolioId: string,
    @Body() dto: CreateSecurityTradeDto,
  ) {
    return this.securityTradeService.create(user.userId, portfolioId, dto);
  }

  @Get()
  @ApiOperation({ summary: '查询证券买卖流水列表（分页 + 日期范围 + 标的筛选）' })
  async findAll(
    @CurrentUser() user: AuthenticatedUser,
    @Param('portfolioId') portfolioId: string,
    @Query() query: SecurityTradeQueryDto,
  ) {
    return this.securityTradeService.findAll(user.userId, portfolioId, query);
  }

  @Get(':id')
  @ApiOperation({ summary: '获取单条证券买卖流水' })
  async findOne(
    @CurrentUser() user: AuthenticatedUser,
    @Param('portfolioId') portfolioId: string,
    @Param('id') id: string,
  ) {
    return this.securityTradeService.findOne(user.userId, portfolioId, id);
  }

  @Patch(':id')
  @ApiOperation({ summary: '更新证券买卖流水' })
  async update(
    @CurrentUser() user: AuthenticatedUser,
    @Param('portfolioId') portfolioId: string,
    @Param('id') id: string,
    @Body() dto: UpdateSecurityTradeDto,
  ) {
    return this.securityTradeService.update(user.userId, portfolioId, id, dto);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: '删除证券买卖流水' })
  async remove(
    @CurrentUser() user: AuthenticatedUser,
    @Param('portfolioId') portfolioId: string,
    @Param('id') id: string,
  ) {
    return this.securityTradeService.remove(user.userId, portfolioId, id);
  }
}
