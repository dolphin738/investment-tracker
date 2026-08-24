# 清理 Backlog（AI代码清理与瘦身）

> 记录各阶段裁决产出的非删除类事项。删除类候选见《功能验收表》第三节裁决表。
> 纪律：阶段 3 执行删除时发现别类问题「只记账不顺手修」，一律追加到这里。

## 缺陷修复池

- **BF-01** [BE-SCH-07] 任务执行日志权限缺失：`backend/app/modules/admin/schedule.py:346` 的 `GET /api/admin/tasks/{id}/logs` 只挂 `get_current_user`，同组其余端点均 `require_admin`，与模块 docstring（schedule.py:12）矛盾。修复：一行改为 `require_admin`。
- **BF-02** [FE-SET-06] 设置页文案过时：`web/src/modules/settings/pages/SettingsPage.vue:554` 写「SET-P0-07，即将上线」，但 FLOW-P0-06 软提示已实现（`use-transactions.ts:125,175,246`）。修复：删去「即将上线」措辞。
- **BF-03** [BE-SNP-02/06] 快照路由类型注解不规范：`backend/app/modules/data/router.py:399,434` `snap_date: date = None`（路径参数默认值不可达）。修复：规范化为必填 `date` 或显式 `Optional[date]`。
- **BF-04** [BE-AUTH] auth 模块内联 user dict 缺 createdAt：8 处中 7 处缺字段（register/login/restore/me/PATCH profile/PATCH password/PATCH email），与 response_model 必填声明及前端契约（lib/types.ts:413）不符；login/改密/改邮箱响应写 localStorage 形成缺字段脏缓存。✅ **已修复（2026-08-25）**：7 处各补 `"createdAt"` 一行，pytest 通过。

## 改进项

- **IMP-01** [BE-PF-08] prices/refresh-async 韧性：`portfolio/router.py:107-115` fire-and-forget 后台任务异常仅 rollback、无日志无通知；进程重启丢任务。裁决接受现状锁定；如后续改进：补异常日志 + 同步状态落库供 sync-status 查询。
- **IMP-02** [BE-AGG-04] range/granularity/aggregation 非法值静默回退（aggregation.py:529-542 等）：宽松容错设计、对齐上游 app/，裁决**不改码**，按现状记录于验收表；仅当未来 API 外部化时再评估严格 400 校验。

## 删除池（阶段 3 执行）

- **DEL-01** [BE-HLTH-07] 删除 `GET /api/token`（health/router.py:75-92）：公开签发 demo token 属安全面 P0 隐患；冒烟改走 `/api/auth/login`。同步清理 health 模块中 demo 用户自动创建逻辑。
- **DEL-02** [FE-XIRR-05] 删除 XIRR 页 yearlyData 冗余 computed（XirrAnalysisPage.vue:129-133）：柱状图实际用 `aggregateByYear(seriesData)`，v-if 中的 length 判断与第一条件语义重复；删除零行为变化。

## 其他已知事实（不构成行动项）

- main.py 字面路由须先于参数路由注册（main.py:99），任何 router 注册重排会破坏匹配——阶段 3 涉及路由增删时必须保持注册顺序。
- health 模块 7 个端点中 5 个为演示性质，可在阶段 2 体检中评估整体瘦身。
- docs/openapi.json 严重过时（缺 9 组端点、含 2 个已删端点），不可作为任何验收依据。
