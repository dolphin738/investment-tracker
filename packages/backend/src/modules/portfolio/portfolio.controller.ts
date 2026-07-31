/**
 * 组合管理控制器
 *
 * 路由前缀：/api/portfolios
 *
 * 接口：
 * - GET    /api/portfolios          — 获取当前用户组合列表
 * - POST   /api/portfolios          — 创建组合
 * - GET    /api/portfolios/:id      — 获取组合详情
 * - PATCH  /api/portfolios/:id      — 更新组合
 * - DELETE /api/portfolios/:id      — 删除组合（级联删除子数据）
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
}
