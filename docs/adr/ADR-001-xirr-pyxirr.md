> 本文档已落地·作为架构决策记录（ADR）。2026-08-09 经用户要求增补 §6（落库前精度/量程论证）；其余章节维持原结论。

# XIRR 计算核心采用 pyxirr（PHASE-2-CALC-01）

> 架构师：dolphin738 ｜ 上游输入：Phase 2 计算层方案（对齐 `../app/docs/ARCHITECTURE.md` §7） ｜ 状态：已收口并落地
> 变更性质：**金融计算核心实现替换**，不触碰 NAV / 持仓推导口径，不违反 Phase 0/1 冻结
> 全部结论均基于本次实际代码与测试核实，非记忆推断

---

## 0. 决策现状核实（先于记录）

| 类别 | 位置 | 状态 |
|------|------|------|
| 实现代码 | `backend/app/finance_core/xirr.py` | ✅ 已委托 `pyxirr` |
| 依赖声明 | `backend/pyproject.toml`（`pyxirr==0.10.8`，见 `[project].dependencies`） | ✅ 已锁定 |
| 单测 | `backend/tests/test_finance_core.py`（XIRR 已知案例 + 边界） | ✅ 15 项纯函数测试含 XIRR |
| 集成测试 | `backend/tests/test_calculation_service.py` | ✅ 成立日 XIRR 退化断言已对齐 pyxirr 行为 |
| 上游文档 | `../app/docs/ARCHITECTURE.md §7.1` | ⚠️ **口径漂移源，见 §3** |

**结论**：本项目 XIRR 已实现层面以 `pyxirr` 为准，但 `app` 文档 §7.1 仍描述"自实现 Newton-Raphson"，存在文档漂移，本文档即为此留痕的权威真相源。

---

## 1. 背景与问题

Phase 2 计算层原计划（对齐 `app/docs/ARCHITECTURE.md §7.1`）是**自实现 Newton-Raphson** XIRR：初始猜测 0.1、最大 100 次迭代、阈值 1e-7、下限 -0.999。

实施后用户决策：**"使用 pyxirr，让口径和精度适应 pyxirr"**。理由：

1. **口径零容忍**：金融产品要求结果与文档单一真相源逐字一致；多 IRR、病态现金流等边界，自实现需自行处理且易被质疑。
2. **精度可控**：`pyxirr` 由 Pydantic 团队维护（原作者 Tom Christie，httpx/starlette/fastapi 生态同一人），Rust 编译扩展、无 numpy/scipy 重依赖，支持 Py3.14。
3. **确定性**：批量日维度计算（每组合每天一次、现金流通常几十笔），纯 Python 与 Rust 实现性能均充足，Rust 还更快。

---

## 2. 决策内容

| 项 | 决策 | 版本 | 理由 |
|----|------|------|------|
| XIRR 计算核心 | **`pyxirr`**（Rust 扩展） | `pyxirr==0.10.8` | 单一真相源、精度可控、官方维护、零重依赖 |
| 调用方式 | `backend/app/finance_core/xirr.py` 委托 `pyxirr.xirr(dates, amounts)` | — | 业务层不直接依赖第三方包，便于未来替换/对账 |
| 被移除 | ~~自实现 Newton-Raphson~~ | — | 用户明确要求以 pyxirr 为准，不保留双实现 |

### 2.1 口径对齐 pyxirr 的细节

- **调用形态**：`pyxirr.xirr([date, ...], [float, ...])`，返回 `float(f64)`。
- **默认算法**：内部 guess=0.1、ACT/365、多 IRR 失败时兜底取最低解（黑盒，不可调参）。
- **边界语义**：现金流 `<2` 条 / 全同号 → `pyxirr` 抛 `pyxirr.InvalidPaymentsError`，本层捕获后转 **`None`**（上层显式处理"不可计算"）。
- **退化案例修正**：成立日两笔同日期等量反向现金流（买入 1000 + 当日资产 1000）→ 旧自实现因 NPV 恒为 0 短路返回初始猜测 `0.1`（**bug**），pyxirr 正确返回 **`0.0`（当日无收益）**。测试断言已从 `0.1` 改为 `0.0`。
- **落库精度**：`Decimal(str(rate)).quantize(Decimal("1e-8"))` 量化到 8 位（对齐 PRD 8.1 `NUMERIC(20,8)`）。

### 2.2 现金流构造（不变，仍对齐 §7.1）

```
现金流 = [成立日~当日全部 CashFlow(BUY负 / SELL正)] + [当日资产快照正终值]
```
仅"如何求 IRR"这一步改用 pyxirr；现金流的取数口径与 §7.1 完全一致。

---

## 3. ⚠️ 口径漂移声明（必读）

`../app/docs/ARCHITECTURE.md §7.1` 当前仍描述：

> "XIRR … 采用 Newton-Raphson 自实现（不用现成包）"

**该描述已不适用于本 Python 项目。** 自 Phase 2 用户决策起，本项目 XIRR 的**唯一真相源是 `pyxirr`**，不再回退到自实现 Newton-Raphson。

约束：
- 工程师修改 XIRR 时，**只允许调整现金流取数口径或 pyxirr 调用封装**，**不得重新引入自实现 XIRR 算法**（除非用户明确撤销本决策）。
- 若 `app` 文档未来同步更新为 pyxirr，则以 `app` 文档为准；在此之前，本 ADR 优先级高于 `app/docs/ARCHITECTURE.md §7.1`。
- 如未来需要"独立对账"，可新增一个**纯 Decimal 参考实现**做交叉验证（断言两者差 `< 1e-6`），但**不改变** pyxirr 的权威地位。当前未做，非必须。

---

## 4. 后果与回退

| 维度 | 影响 | 处理 |
|------|------|------|
| 数值结果 | 与旧自实现在常规现金流下一致（测试 1 年 10% / 半年 21% 均在 `1e-6` 内）；成立日退化案例由 0.1（bug）修正为 0.0 | ✅ 更符合经济含义 |
| 精度 | pyxirr 返回 f64，经 `Decimal(str(...))` 量化 8 位，跨平台确定性 | ✅ 满足 PRD |
| 依赖风险 | Rust 编译 wheel，需对应平台预编译包；缺 wheel 时需本地 Rust 工具链从 sdist 编 | ⚠️ 当前 Windows/Py3.13 已验证可用 |
| 可审计性 | 算法藏在 Rust 二进制，回归靠外围测试兜底 | 已由 `test_finance_core.py` 15 项 + 集成测试覆盖 |
| 回退 | 如需回退自实现，需恢复 Newton-Raphson 代码并改测试断言 | 不建议，除非 pyxirr 停止维护 |

---

## 6. 落库前的精度/量程论证（2026-08-09 增补）

> 议题：H1 为何选择「超量程 → `None`」而非「加宽 `NUMERIC(20,8)` 列」来"解决" XIRR 溢出。

### 6.1 关键事实：float64（IEEE 754 binary64）的精度

- 53 位有效位 → 机器精度 ε = 2⁻⁵² ≈ 2.2204×10⁻¹⁶；有效数字约 **15~17 位十进制**。
- **相对精度**，非绝对位数：数值越大，可可靠表示的绝对间隔越大（×2.2e-16）。
- 可精确表示整数上限 2⁵³ ≈ 9.0×10¹⁵；有限最大值 (2−2⁻⁵²)·2¹⁰²³ ≈ **1.7977×10³⁰⁸**。

### 6.2 为何"加宽精度"治标不治本

1. **溢出主战场在 DB，不在 float**：`pyxirr` 返回的 1e13 量级年化率在 float64 中完全合法（远小于 1.8e308），落库 `NUMERIC(20,8)` 才越界。
2. **float64 在极端量级无 8 位小数可言**：1e13 量级下 float 绝对分辨率 ≈ 1e13 × 2.2e-16 ≈ 0.012，把 `Decimal(str(rate)).quantize(1e-8)` 的 8 位小数视为"精度"是伪造的——`54000000000000.00000000` 实为噪声。
3. **想"匹配 float64 范围"会把垃圾请回来**：float 最大有限 ≈1.8e308（整数 309 位）→ 需 `NUMERIC(317,8)`；若连最小次正规 4.9e-324 都覆盖需 `NUMERIC(633,324)`。但 float 在 1e300 处绝对分辨率约 1e284，**根本不存在 8 位小数**——宽列只会伪造精度，且年化率到 1e300 量级作为"年化收益"已无业务意义。
4. **1 日收益 ≳598% 时**年化率冲过 1e308 变 `inf`（float 无意义）；更宽列也接不住 `inf`。

### 6.3 结论（与 H1 一致）

不放大精度、不改 DB 列宽；超 `NUMERIC(20,8)` 整数位 12 位精确上限（≈1e12）的 XIRR 统一判 `None`（不可计算），与本 ADR §2.1「现金流<2/全同号→None」口径一致，亦对齐 PRD `C-01`（口径唯一、不可计算即空）。量程阈值 `_XIRR_MAX=1e12` 与 `app/` 的 ±1e11 原理相同、仅阈值点差一个数量级（见 N1 决策记录）。若未来要保留极端值，正确做法是**封顶**或"落库日收益、展示时再年化"，而非加宽数值列。

## 5. 参考

- `backend/app/finance_core/xirr.py` — 委托实现
- `backend/pyproject.toml` — `pyxirr==0.10.8`（依赖真相源，取代原 requirements.txt）
- `backend/tests/test_finance_core.py` — XIRR 单测（已知案例 + 边界 + 退化）
- `backend/tests/test_calculation_service.py` — 成立日 XIRR=0.0 集成断言
- `../app/docs/ARCHITECTURE.md §7.1` — 上游口径（注意 §3 漂移声明）
- 本地留痕（非仓库）：`.workbuddy/memory/MEMORY.md`「XIRR 计算真相源」段
