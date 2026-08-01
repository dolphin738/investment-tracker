/**
 * 证券管理控制器
 *
 * 路由前缀：/api/portfolios/:portfolioId/securities
 *
 * 接口：
 * - GET    /api/portfolios/:portfolioId/securities       — 获取组合下所有标的
 * - POST   /api/portfolios/:portfolioId/securities       — 新增标的
 * - GET    /api/portfolios/:portfolioId/securities/:id   — 获取标的详情
 * - PATCH  /api/portfolios/:portfolioId/securities/:id   — 更新标的
 * - DELETE /api/portfolios/:portfolioId/securities/:id   — 删除标的
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
import { SecurityService } from './security.service';
import { CreateSecurityDto } from './dto/create-security.dto';
import { UpdateSecurityDto } from './dto/update-security.dto';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../../common/decorators/current-user.decorator';

@ApiTags('证券管理')
@ApiBearerAuth('JWT-auth')
@Controller('portfolios/:portfolioId/securities')
export class SecurityController {
  constructor(private readonly securityService: SecurityService) {}

  @Get()
  @ApiOperation({ summary: '获取组合下所有标的' })
  async findAll(
    @CurrentUser() user: AuthenticatedUser,
    @Param('portfolioId') portfolioId: string,
  ) {
    return this.securityService.findAll(portfolioId, user.userId);
  }

  @Post()
  @ApiOperation({ summary: '新增标的' })
  async create(
    @CurrentUser() user: AuthenticatedUser,
    @Param('portfolioId') portfolioId: string,
    @Body() dto: CreateSecurityDto,
  ) {
    return this.securityService.create(portfolioId, user.userId, dto);
  }

  @Get(':id')
  @ApiOperation({ summary: '获取标的详情' })
  async findOne(
    @CurrentUser() user: AuthenticatedUser,
    @Param('portfolioId') portfolioId: string,
    @Param('id') id: string,
  ) {
    return this.securityService.findOne(portfolioId, id, user.userId);
  }

  @Patch(':id')
  @ApiOperation({ summary: '更新标的' })
  async update(
    @CurrentUser() user: AuthenticatedUser,
    @Param('portfolioId') portfolioId: string,
    @Param('id') id: string,
    @Body() dto: UpdateSecurityDto,
  ) {
    return this.securityService.update(portfolioId, id, user.userId, dto);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: '删除标的（级联删除关联持仓/分红/费用记录）' })
  async remove(
    @CurrentUser() user: AuthenticatedUser,
    @Param('portfolioId') portfolioId: string,
    @Param('id') id: string,
  ) {
    return this.securityService.remove(portfolioId, id, user.userId);
  }
}
