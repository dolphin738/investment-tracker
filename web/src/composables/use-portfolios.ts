/**
 * composables/use-portfolios.ts — 组合 CRUD hooks 统一出口（re-export 薄层）
 *
 * 完整实现已随 B3 批次迁至 modules/portfolio/composables/use-portfolios.ts
 * （列表 query + 创建/更新/归档/删除/清空/默认组合全部 hooks）。
 * 此处保留旧导入路径，出入金等既有模块仍从 '@/composables/use-portfolios' 引用。
 */

export * from '@/modules/portfolio/composables/use-portfolios';
