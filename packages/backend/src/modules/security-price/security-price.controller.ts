/**
 * SecurityPrice Controller — 标的最新价 API
 *
 * 路由前缀：/api/portfolios/:portfolioId/security-prices
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
import { SecurityPriceService } from './security-price.service';
import { UpsertSecurityPriceDto, SecurityPriceQueryDto } from './security-price.dto';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../../common/decorators/current-user.decorator';

@ApiTags('标的最新价')
@ApiBearerAuth('JWT-auth')
@Controller('portfolios/:portfolioId/security-prices')
export class SecurityPriceController {
  constructor(private readonly securityPriceService: SecurityPriceService) {}

  @Post()
  @ApiOperation({ summary: '录入/覆盖标的最新价（同日期覆盖旧值）' })
  async upsert(
    @CurrentUser() user: AuthenticatedUser,
    @Param('portfolioId') portfolioId: string,
    @Body() dto: UpsertSecurityPriceDto,
  ) {
    return this.securityPriceService.upsert(user.userId, portfolioId, dto);
  }

  @Get()
  @ApiOperation({ summary: '查询标的最新价列表（分页 + 日期范围 + 标的筛选）' })
  async findAll(
    @CurrentUser() user: AuthenticatedUser,
    @Param('portfolioId') portfolioId: string,
    @Query() query: SecurityPriceQueryDto,
  ) {
    return this.securityPriceService.findAll(user.userId, portfolioId, query);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: '删除价格记录' })
  async remove(
    @CurrentUser() user: AuthenticatedUser,
    @Param('portfolioId') portfolioId: string,
    @Param('id') id: string,
  ) {
    return this.securityPriceService.remove(user.userId, portfolioId, id);
  }
}
