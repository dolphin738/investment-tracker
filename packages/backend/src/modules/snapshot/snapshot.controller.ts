/**
 * 资产快照控制器（方案B）
 *
 * 路由前缀：/api/portfolios/:portfolioId/snapshots
 *
 * 接口：
 * - POST   /api/portfolios/:portfolioId/snapshots              — 手工录入快照（source=MANUAL）
 * - GET    /api/portfolios/:portfolioId/snapshots              — 分页查询
 * - PATCH  /api/portfolios/:portfolioId/snapshots/:id          — 更新手工记录
 * - DELETE /api/portfolios/:portfolioId/snapshots/:id          — 删除记录（事件日回填 DERIVED）
 * - POST   /api/portfolios/:portfolioId/snapshots/:date/reset  — 重置为 DERIVED
 *
 * 🆕 AL-054（决策 Q-1 甲）：除 DELETE 外，**所有**返回快照实体的端点
 * （列表 / 录入 / 更新 / 重置）每项均携带 `derivedTotalAsset: string | null`
 * ——「若该日不使用手工快照，系统会算出多少」，供快照页做
 * 「手工值 / 派生值 / 差异」三列对比。计算失败时该字段为 null，
 * 接口本身**照常 200**（派生值是增强信息，不是核心数据）。
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
import { SnapshotService } from './snapshot.service';
import type { SnapshotResponse } from './snapshot.service';
import { UpsertSnapshotDto, SnapshotQueryDto } from './dto/upsert-snapshot.dto';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../../common/decorators/current-user.decorator';

@ApiTags('资产快照')
@ApiBearerAuth('JWT-auth')
@Controller('portfolios/:portfolioId/snapshots')
export class SnapshotController {
  constructor(private readonly snapshotService: SnapshotService) {}

  @Post()
  @ApiOperation({
    summary: '手工录入资产快照（source=MANUAL）',
    description: '响应含 derivedTotalAsset（该日系统派生总资产，计算失败为 null）',
  })
  async upsertManual(
    @CurrentUser() user: AuthenticatedUser,
    @Param('portfolioId') portfolioId: string,
    @Body() dto: UpsertSnapshotDto,
  ): Promise<SnapshotResponse> {
    return this.snapshotService.upsertManual(user.userId, portfolioId, dto);
  }

  @Get()
  @ApiOperation({
    summary: '查询快照列表（分页 + 日期范围）',
    description:
      '每项含 derivedTotalAsset：DERIVED 行 = totalAsset，MANUAL 行 = 实时派生值，计算失败为 null（列表仍 200）',
  })
  async findAll(
    @CurrentUser() user: AuthenticatedUser,
    @Param('portfolioId') portfolioId: string,
    @Query() query: SnapshotQueryDto,
  ): Promise<{
    items: SnapshotResponse[];
    total: number;
    page: number;
    pageSize: number;
  }> {
    return this.snapshotService.findAll(user.userId, portfolioId, query);
  }

  @Get(':date')
  @ApiOperation({
    summary: '查询指定日期单条快照（A3）',
    description:
      '响应含 derivedTotalAsset（该日系统派生总资产，计算失败为 null）；该日无记录 → 404',
  })
  async findOne(
    @CurrentUser() user: AuthenticatedUser,
    @Param('portfolioId') portfolioId: string,
    @Param('date') date: string,
  ): Promise<SnapshotResponse> {
    return this.snapshotService.findOne(user.userId, portfolioId, date);
  }

  @Patch(':id')
  @ApiOperation({
    summary: '更新手工快照记录',
    description: '响应含 derivedTotalAsset（该日系统派生总资产，计算失败为 null）',
  })
  async update(
    @CurrentUser() user: AuthenticatedUser,
    @Param('portfolioId') portfolioId: string,
    @Param('id') id: string,
    @Body() dto: UpsertSnapshotDto,
  ): Promise<SnapshotResponse> {
    return this.snapshotService.update(user.userId, portfolioId, id, dto);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: '删除快照记录（事件日自动回填 DERIVED）' })
  async deleteRecord(
    @CurrentUser() user: AuthenticatedUser,
    @Param('portfolioId') portfolioId: string,
    @Param('id') id: string,
  ) {
    return this.snapshotService.deleteRecord(user.userId, portfolioId, id);
  }

  @Post(':date/reset')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: '重置指定日期快照为 DERIVED',
    description:
      '响应含 derivedTotalAsset；重置后 source=DERIVED，故该值等于 totalAsset',
  })
  async resetToDerived(
    @CurrentUser() user: AuthenticatedUser,
    @Param('portfolioId') portfolioId: string,
    @Param('date') date: string,
  ): Promise<SnapshotResponse> {
    return this.snapshotService.resetToDerived(user.userId, portfolioId, date);
  }
}
