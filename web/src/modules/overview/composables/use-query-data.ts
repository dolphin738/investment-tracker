/**
 * modules/overview/composables/use-query-data.ts — 概览页 XIRR / 净值查询 hooks
 *
 * 五件套（useXirrSeries / useNavSeries / useLatestXirr / useLatestNav /
 * useYearStartXirr）与 analysis 版逐字一致，归并到 analysis 版为单一真相源
 * （REP-045）；本文件仅做再导出，保持概览页 import 路径稳定、零行为差异
 * （disabled 态 queryKey 改为 'disabled' 哨兵，但 enabled 态 key 完全一致，
 *  且 disabled 态 query 永不触发，无缓存 / 数据影响）。
 *
 * 历史说明：原 `useNavTotalAssetMap` 属资产快照域，已平移至
 * modules/snapshot/composables/use-snapshots.ts（被 SnapshotForm 消费），
 * 此处不再保留副本（亦无消费者）。
 */

export {
  useXirrSeries,
  useNavSeries,
  useLatestXirr,
  useLatestNav,
  useYearStartXirr,
} from '@/modules/analysis/composables/use-query-data';
