/**
 * api/snapshot.api.ts — 资产快照 API
 *
 * 对应后端 /api/portfolios/:portfolioId/snapshots：
 * - POST   /snapshots              — upsert（每日唯一，重复则覆盖）
 * - GET    /snapshots              — 列表（分页 + 日期范围）
 * - PATCH  /snapshots/:id          — 更新手工记录
 * - DELETE /snapshots/:id          — 删除
 * - POST   /snapshots/:date/reset  — 重置为 DERIVED
 */

import { http } from '@/lib/api-client';
import type {
  PaginatedResponse,
  SnapshotQuery,
  SnapshotResponse,
  UpsertSnapshotRequest,
} from './types';

/** 录入/覆盖快照（upsert 语义：每日唯一，重复录入则覆盖） */
export function upsertSnapshot(
  portfolioId: string,
  payload: UpsertSnapshotRequest,
): Promise<SnapshotResponse> {
  return http.post<SnapshotResponse>(
    `/portfolios/${portfolioId}/snapshots`,
    payload,
  );
}

/** 获取快照列表 */
export function listSnapshots(
  portfolioId: string,
  query: SnapshotQuery = {},
): Promise<PaginatedResponse<SnapshotResponse>> {
  return http.get<PaginatedResponse<SnapshotResponse>>(
    `/portfolios/${portfolioId}/snapshots`,
    { params: query },
  );
}

/** 删除快照 */
export function deleteSnapshot(
  portfolioId: string,
  id: string,
): Promise<null> {
  return http.delete<null>(`/portfolios/${portfolioId}/snapshots/${id}`);
}

/** 更新手工快照记录 */
export function updateSnapshot(
  portfolioId: string,
  id: string,
  payload: UpsertSnapshotRequest,
): Promise<SnapshotResponse> {
  return http.patch<SnapshotResponse>(
    `/portfolios/${portfolioId}/snapshots/${id}`,
    payload,
  );
}

/** 重置指定日期快照为 DERIVED */
export function resetToDerived(
  portfolioId: string,
  date: string,
): Promise<SnapshotResponse> {
  return http.post<SnapshotResponse>(
    `/portfolios/${portfolioId}/snapshots/${date}/reset`,
  );
}
