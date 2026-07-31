/**
 * 资产快照 API — upsert / list / delete
 *
 * 对应后端端点：
 * - GET    /api/portfolios/:portfolioId/snapshots         获取快照列表
 * - PUT    /api/portfolios/:portfolioId/snapshots         录入/覆盖快照（upsert 语义）
 * - DELETE /api/portfolios/:portfolioId/snapshots/:id     删除快照
 *
 * 副作用：录入/覆盖快照后，后端自动触发当日净值+XIRR 计算。
 *        编辑/删除历史快照触发从该日期起的批量重算。
 *
 * 注意：快照使用 PUT upsert 语义，同日重复录入会覆盖。
 */

import { HttpClient } from '../net/http-client';
import { ApiConfig } from '../net/api-config';
import type { AssetSnapshot, Paginated, UpsertSnapshotRequest } from '../net/api-types';

export class SnapshotApi {
  /**
   * 获取快照列表（分页）
   * @param portfolioId 组合 ID
   * @param page 页码（默认 1）
   * @param pageSize 每页条数（默认 50）
   * @param startDate 起始日期（可选）
   * @param endDate 结束日期（可选）
   */
  static async list(
    portfolioId: string,
    page: number = 1,
    pageSize: number = 50,
    startDate?: string,
    endDate?: string,
  ): Promise<Paginated<AssetSnapshot>> {
    let path: string = `${ApiConfig.snapshots(portfolioId)}?page=${page}&pageSize=${pageSize}`;
    if (startDate) {
      path += `&startDate=${startDate}`;
    }
    if (endDate) {
      path += `&endDate=${endDate}`;
    }
    return HttpClient.get<Paginated<AssetSnapshot>>(path);
  }

  /**
   * 录入/覆盖快照（upsert 语义）
   * 同日重复录入会覆盖已有快照。
   * @param portfolioId 组合 ID
   * @param date 快照日期 YYYY-MM-DD
   * @param totalAsset 当日持仓总市值（字符串，如 "12000.00"）
   * @param note 备注（可选）
   * @returns 快照实体（可能是新建或覆盖后的）
   */
  static async upsert(
    portfolioId: string,
    date: string,
    totalAsset: string,
    note?: string,
  ): Promise<AssetSnapshot> {
    const body: UpsertSnapshotRequest = {
      date: date,
      totalAsset: totalAsset,
    };
    if (note && note.length > 0) {
      body.note = note;
    }
    return HttpClient.put<AssetSnapshot>(ApiConfig.snapshots(portfolioId), body);
  }

  /**
   * 删除快照
   */
  static async delete(portfolioId: string, snapshotId: string): Promise<void> {
    await HttpClient.delete<void>(ApiConfig.snapshotDetail(portfolioId, snapshotId));
  }
}
