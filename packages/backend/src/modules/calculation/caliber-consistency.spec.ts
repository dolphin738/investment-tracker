/**
 * 跨引擎口径一致性测试（QA 独立验证 — 用户决策 D-06）
 *
 * 与既有 nav.service.spec.ts 的区别：
 * 那里用 jest.fn() 逐次 mock 查询返回值，只能验证「单日、给定输入 → 输出」。
 * 本文件用内存 Prisma 驱动**真实**的 NavService + XirrService + CalculationService
 * + RecalculationService，喂同一份数据、跑完整多日序列，用来回答两个 mock 答不了的问题：
 *   1. 两个引擎读同一份数据时，口径是否自洽？
 *   2. 多日结转后误差是否累积？
 *
 * ─────────────────────────────────────────────────────────────
 * 【判定标准的修正 — 重要，请勿直接套用「nav 因子 == xirr 因子」】
 *
 * 验收要求原文是「nav 隐含增长因子必须等于 xirr 隐含增长因子」。
 * 该标准在一般情形下**数学上不成立**，不能作为通过/失败的判据：
 *
 *   单位净值（unitNav/cumulativeNav）是**时间加权收益率 TWR**——按份额定价，
 *   刻意剔除申赎时点与金额的影响，衡量的是「策略本身表现」。
 *   XIRR 是**资金加权收益率 MWR**——正是要把申赎时点与金额算进去，
 *   衡量的是「这个人实际赚了多少钱」。
 *
 * 两者只在特定子集下相等（见 D 组、E 组），一般情形下必然不等。
 * 反例（本文件 F 组已固化）：
 *   d0 投 10000（快照 10000）→ d30 投 10000（快照 22000）→ d60 快照 22000
 *   TWR 因子 = 1.2000，MWR 因子 = 1.1348 —— 差 5.4 个百分点，两者都对。
 *   原因：第一笔小钱吃到了 +120% 的涨幅，第二笔大钱只吃到 0%，
 *   MWR 被大额晚投入拉低，TWR 不受影响。这是金融定义使然，不是 Bug。
 *
 * 因此本文件采用**口径锚点**作为普适判据（A 组），它才是本次修复真正的成败标准：
 *
 *   判定 A（普适）：shares_t × unitNav_t === totalAsset_t
 *     即「nav 引擎隐含的账户价值」必须等于「xirr 引擎使用的终值」。
 *     两个引擎必须对「这个账户现在值多少钱」达成一致——这是它们唯一必须一致的东西。
 *
 *   该判据非空洞：若实现漏掉 +sell（preAsset = A - B），则 shares×nav = A - S ≠ A，
 *   立即失败；若实现退回旧口径（preAsset = A），则 shares×nav = A + B - S ≠ A。
 *   换言之，在「份额按当日净值申赎」的规则下，判定 A 唯一地反解出
 *   preAsset = A - B + S，它等价于口径规格本身。
 *
 *   旧口径隐含终值通式 = A + B - S（QA 独立推导并验算）：
 *     用户算例中 = 15500 + 5000 = 20500，而 xirr 用 15500 → 凭空多出 5000 元，
 *     正是本次 Bug 报告中「同一份数据差 5000 元」的来源。B 组固化此回归防线。
 * ─────────────────────────────────────────────────────────────
 */

import { CalculationService } from './calculation.service';
import { NavService } from './nav.service';
import { RecalculationService } from './recalculation.service';
import { XirrService } from './xirr.service';
import { InMemoryPrisma, daysBetween, utc } from './testing/in-memory-prisma';

// ============================================================
// 场景定义
// ============================================================

interface Scenario {
  name: string;
  /** [日期, 类型, 金额] */
  txs: Array<[string, 'BUY' | 'SELL', number]>;
  /** [日期, 期末总资产] */
  snaps: Array<[string, number]>;
}

/**
 * 8 组差异化场景。
 *
 * 【刻意规避】每组的首笔买入日都有快照。
 * 原因：已知存在第三个口径缝隙——「首个快照日之前的交易」不进 nav 的份额结转
 * （净值只在有快照的日期生成），却会进 XIRR 的现金流（xirr 用 lte 查全部交易）。
 * 该缝隙不在本次修复范围，若测试数据踩中会产生误报。
 * 其影响幅度已在 G 组单独量化（仅作信息，不参与通过判定）。
 */
const SCENARIOS: Scenario[] = [
  {
    name: 'S1 只买不卖（4 个快照日）',
    txs: [
      ['2024-01-01', 'BUY', 10000],
      ['2024-02-01', 'BUY', 5000],
    ],
    snaps: [
      ['2024-01-01', 10000],
      ['2024-01-15', 10500],
      ['2024-02-01', 16000],
      ['2024-03-01', 17000],
    ],
  },
  {
    name: 'S2 只卖不买（4 个快照日）',
    txs: [
      ['2024-01-01', 'BUY', 20000],
      ['2024-02-01', 'SELL', 5000],
    ],
    snaps: [
      ['2024-01-01', 20000],
      ['2024-01-15', 21000],
      ['2024-02-01', 17000],
      ['2024-03-01', 17500],
    ],
  },
  {
    name: 'S3 买卖同日并存',
    txs: [
      ['2024-01-01', 'BUY', 10000],
      ['2024-02-01', 'BUY', 4000],
      ['2024-02-01', 'SELL', 1000],
    ],
    snaps: [
      ['2024-01-01', 10000],
      ['2024-02-01', 14000],
      ['2024-03-01', 14500],
    ],
  },
  {
    name: 'S4 当日无交易（纯持有，单笔投入）',
    txs: [['2024-01-01', 'BUY', 10000]],
    snaps: [
      ['2024-01-01', 10000],
      ['2024-02-01', 11000],
      ['2024-03-01', 12000],
      ['2024-04-01', 13000],
    ],
  },
  {
    name: 'S5 亏损（期末资产 < 累计投入）',
    txs: [
      ['2024-01-01', 'BUY', 10000],
      ['2024-02-01', 'BUY', 5000],
    ],
    snaps: [
      ['2024-01-01', 10000],
      ['2024-02-01', 13500],
      ['2024-03-01', 12000],
    ],
  },
  {
    name: 'S6 除不尽的金额（制造浮点误差）',
    txs: [
      ['2024-01-01', 'BUY', 3333.33],
      ['2024-02-01', 'BUY', 1111.11],
    ],
    snaps: [
      ['2024-01-01', 3333.33],
      ['2024-01-20', 3456.78],
      ['2024-02-01', 4691.23],
      ['2024-03-07', 4777.77],
    ],
  },
  {
    name: 'S7 跨年（验证 yearNav 分支不破坏一致性）',
    // 日期刻意远离 1/1：isYearFirstTradingDay 用本地时区 getFullYear，
    // 而日期以 UTC 午夜存储。12-20 / 01-10 在 UTC-12 ~ UTC+14 任一时区下
    // 年份判定都一致，避免测试受 CI 时区影响（详见 H 组附加发现）。
    txs: [
      ['2024-11-01', 'BUY', 10000],
      ['2025-02-01', 'BUY', 5000],
    ],
    snaps: [
      ['2024-11-01', 10000],
      ['2024-12-20', 11000],
      ['2025-01-10', 11200],
      ['2025-02-01', 16500],
      ['2025-03-01', 17000],
    ],
  },
  {
    name: 'S8 长序列 6 个快照日 + 买卖混合',
    txs: [
      ['2024-01-01', 'BUY', 10000],
      ['2024-01-15', 'BUY', 3000],
      ['2024-01-22', 'SELL', 2000],
      ['2024-02-05', 'BUY', 1500],
      ['2024-02-05', 'SELL', 500],
    ],
    snaps: [
      ['2024-01-01', 10000],
      ['2024-01-08', 10200],
      ['2024-01-15', 13400],
      ['2024-01-22', 11600],
      ['2024-01-29', 11800],
      ['2024-02-05', 12900],
    ],
  },
  {
    name: 'S9 用户原始算例（7/1 买 10000 → 7/15 买 5000，快照 15500）',
    txs: [
      ['2024-07-01', 'BUY', 10000],
      ['2024-07-15', 'BUY', 5000],
    ],
    snaps: [
      ['2024-07-01', 10000],
      ['2024-07-15', 15500],
    ],
  },
];

// ============================================================
// 测试装置
// ============================================================

const PID = 'p-consistency';

interface Harness {
  db: InMemoryPrisma;
  recalc: RecalculationService;
}

function buildHarness(): Harness {
  const db = new InMemoryPrisma();
  db.seedPortfolio(PID);
  const nav = new NavService(db as never);
  const xirr = new XirrService(db as never);
  const calc = new CalculationService(db as never, nav, xirr);
  const recalc = new RecalculationService(db as never, calc);
  return { db, recalc };
}

/** 装载场景数据并执行全量重算 */
async function runScenario(sc: Scenario): Promise<InMemoryPrisma> {
  const { db, recalc } = buildHarness();
  for (const [date, type, amount] of sc.txs) db.seedTx(PID, date, type, amount);
  for (const [date, asset] of sc.snaps) db.seedSnap(PID, date, asset);
  await recalc.recalculateAll(PID);
  return db;
}

/** 截至某日的累计买入 / 卖出 */
function cumulativeFlows(sc: Scenario, upto: string) {
  const t = utc(upto).getTime();
  let buy = 0;
  let sell = 0;
  for (const [date, type, amount] of sc.txs) {
    if (utc(date).getTime() > t) continue;
    if (type === 'BUY') buy += amount;
    else sell += amount;
  }
  return { buy, sell, net: buy - sell };
}

/** XIRR 隐含的「持有期增长因子」= (1+xirr)^(持有天数/365) */
function xirrGrowthFactor(xirr: number, firstFlowDate: string, valuationDate: string): number {
  const days = daysBetween(utc(firstFlowDate), utc(valuationDate));
  return Math.pow(1 + xirr, days / 365);
}

// ============================================================
// A 组：口径锚点 —— 普适判据
// ============================================================

describe('A 组｜口径锚点：nav 隐含账户价值 === xirr 终值 === totalAsset', () => {
  it.each(SCENARIOS.map((s) => [s.name, s] as const))(
    '%s — 每个快照日都满足 shares × unitNav === totalAsset',
    async (_name, sc) => {
      const db = await runScenario(sc);

      for (const [dateStr, totalAsset] of sc.snaps) {
        const nav = db.getNav(PID, dateStr);
        expect(nav).toBeDefined();

        // 核心：nav 引擎隐含的账户价值必须等于 xirr 引擎当作终值使用的那个数
        expect(nav!.shares * nav!.unitNav).toBeCloseTo(totalAsset, 6);

        // 数值卫生：全链路不得泄漏 NaN / Infinity
        expect(Number.isFinite(nav!.unitNav)).toBe(true);
        expect(Number.isFinite(nav!.cumulativeNav)).toBe(true);
        expect(Number.isFinite(nav!.yearNav)).toBe(true);
        expect(Number.isFinite(nav!.shares)).toBe(true);
        expect(nav!.unitNav).toBeGreaterThan(0);
        expect(nav!.shares).toBeGreaterThan(0);

        const xirrRow = db.getXirr(PID, dateStr);
        expect(xirrRow).toBeDefined();
        if (xirrRow!.xirrValue !== null) {
          expect(Number.isFinite(xirrRow!.xirrValue)).toBe(true);
        }
      }
    },
  );

  it.each(SCENARIOS.map((s) => [s.name, s] as const))(
    '%s — 多日结转后不变量不漂移（末日精度 ≥ 1e-6 相对误差）',
    async (_name, sc) => {
      const db = await runScenario(sc);
      const [lastDate, lastAsset] = sc.snaps[sc.snaps.length - 1];
      const nav = db.getNav(PID, lastDate)!;

      const relativeError = Math.abs(nav.shares * nav.unitNav - lastAsset) / lastAsset;
      expect(relativeError).toBeLessThan(1e-6);
    },
  );
});

// ============================================================
// B 组：旧口径回归防线
// ============================================================

describe('B 组｜旧口径回归防线：隐含终值不得退回 A + B − S', () => {
  it.each(
    SCENARIOS.filter((sc) =>
      // 只挑「当日存在净申购/净赎回」的日期才有区分度：净流为 0 时新旧口径重合
      sc.snaps.some(([dateStr]) => {
        const same = sc.txs.filter(([d]) => d === dateStr);
        const net = same.reduce((s, [, t, a]) => s + (t === 'BUY' ? a : -a), 0);
        return net !== 0 && dateStr !== sc.snaps[0][0];
      }),
    ).map((s) => [s.name, s] as const),
  )('%s — 有净申赎的非成立日，隐含终值必须是 A 而不是 A+B−S', async (_name, sc) => {
    const db = await runScenario(sc);

    for (const [dateStr, totalAsset] of sc.snaps.slice(1)) {
      const sameDay = sc.txs.filter(([d]) => d === dateStr);
      const netFlow = sameDay.reduce((s, [, t, a]) => s + (t === 'BUY' ? a : -a), 0);
      if (netFlow === 0) continue;

      const nav = db.getNav(PID, dateStr)!;
      const implied = nav.shares * nav.unitNav;

      expect(implied).toBeCloseTo(totalAsset, 6);
      // 旧实现会得到 A + B − S，差额恰为当日净申购额
      expect(Math.abs(implied - (totalAsset + netFlow))).toBeGreaterThan(
        Math.abs(netFlow) * 0.5,
      );
    }
  });

  it('用户算例：新口径隐含终值 15500，旧口径为 20500，差额 5000 元', async () => {
    const sc = SCENARIOS.find((s) => s.name.startsWith('S9'))!;
    const db = await runScenario(sc);
    const nav = db.getNav(PID, '2024-07-15')!;

    expect(nav.unitNav).toBeCloseTo(1.05, 8);
    expect(nav.shares).toBeCloseTo(14761.904762, 5);
    expect(nav.shares * nav.unitNav).toBeCloseTo(15500, 6);

    // 旧口径：unitNav = 15500/10000 = 1.55，隐含终值 20500
    const oldUnitNav = 15500 / 10000;
    const oldShares = 10000 + 5000 / oldUnitNav;
    expect(oldShares * oldUnitNav).toBeCloseTo(20500, 6);
    expect(oldShares * oldUnitNav - nav.shares * nav.unitNav).toBeCloseTo(5000, 6);

    // 收益 500 元而非 5500 元
    expect(15500 - 15000).toBe(500);
    expect(nav.unitNav).not.toBeCloseTo(1.55, 3);
  });
});

// ============================================================
// C 组：两引擎对「实际盈亏」的认定必须一致
// ============================================================

describe('C 组｜盈亏方向一致性：两引擎看到同一笔钱', () => {
  it.each(SCENARIOS.map((s) => [s.name, s] as const))(
    '%s — 末日 XIRR 的正负号与「期末资产 vs 净投入」一致',
    async (_name, sc) => {
      const db = await runScenario(sc);
      const [lastDate, lastAsset] = sc.snaps[sc.snaps.length - 1];
      const { net } = cumulativeFlows(sc, lastDate);
      const xirrValue = db.getXirr(PID, lastDate)!.xirrValue;

      expect(xirrValue).not.toBeNull();

      const realPnl = lastAsset - net;
      if (Math.abs(realPnl) < 1e-9) return; // 恰好打平，跳过

      // XIRR 是资金加权：赚钱必为正、亏钱必为负，这一点与 TWR 不同，是普适的
      if (realPnl > 0) expect(xirrValue!).toBeGreaterThan(0);
      else expect(xirrValue!).toBeLessThan(0);
    },
  );

  it('S5 亏损场景：投入 15000 / 期末 12000 → XIRR 为负且 cumulativeNav < 1', async () => {
    const sc = SCENARIOS.find((s) => s.name.startsWith('S5'))!;
    const db = await runScenario(sc);

    const nav = db.getNav(PID, '2024-03-01')!;
    const xirrValue = db.getXirr(PID, '2024-03-01')!.xirrValue!;

    expect(nav.cumulativeNav).toBeCloseTo(0.755555555, 6);
    expect(nav.cumulativeNav).toBeLessThan(1);
    expect(xirrValue).toBeLessThan(0);
    expect(nav.shares * nav.unitNav).toBeCloseTo(12000, 6);
  });
});

// ============================================================
// D 组：TWR === MWR 的可证子集（严格数值相等）
// ============================================================

describe('D 组｜单笔投入无后续现金流 → TWR 因子严格等于 MWR 因子', () => {
  it('S4 纯持有：cumulativeNav 与 (1+xirr)^(days/365) 逐日相等', async () => {
    const sc = SCENARIOS.find((s) => s.name.startsWith('S4'))!;
    const db = await runScenario(sc);

    // 成立日只有一天现金流（买入 + 终值同日）→ XIRR 无解，返回 null，符合预期
    expect(db.getXirr(PID, '2024-01-01')!.xirrValue).toBeNull();

    for (const dateStr of ['2024-02-01', '2024-03-01', '2024-04-01']) {
      const nav = db.getNav(PID, dateStr)!;
      const xirrValue = db.getXirr(PID, dateStr)!.xirrValue!;
      const mwr = xirrGrowthFactor(xirrValue, '2024-01-01', dateStr);

      expect(mwr).toBeCloseTo(nav.cumulativeNav, 6);
    }
  });

  it('单笔投入跨年长持：一致性不被 yearNav 分支破坏', async () => {
    const { db, recalc } = buildHarness();
    db.seedTx(PID, '2024-11-01', 'BUY', 10000);
    db.seedSnap(PID, '2024-11-01', 10000);
    db.seedSnap(PID, '2024-12-20', 11000);
    db.seedSnap(PID, '2025-01-10', 11500);
    db.seedSnap(PID, '2025-06-15', 13000);
    await recalc.recalculateAll(PID);

    const nav = db.getNav(PID, '2025-06-15')!;
    const xirrValue = db.getXirr(PID, '2025-06-15')!.xirrValue!;

    expect(nav.cumulativeNav).toBeCloseTo(1.3, 8);
    expect(xirrGrowthFactor(xirrValue, '2024-11-01', '2025-06-15')).toBeCloseTo(1.3, 6);
    // 跨年后 yearNav 以 2024 年末累计净值为基准
    expect(nav.baseCumulativeNav).toBeCloseTo(1.1, 6);
  });
});

// ============================================================
// E 组：等周期恒定收益率 → TWR === MWR（第二个可证子集）
// ============================================================

describe('E 组｜等长周期且每期收益率相同 → TWR 因子严格等于 MWR 因子', () => {
  it('两个 30 日周期各 +10%，两笔等额投入：TWR = MWR = 1.21', async () => {
    const { db, recalc } = buildHarness();
    // 2024-01-01 → 01-31 → 03-01，各 30 天（2024 为闰年）
    db.seedTx(PID, '2024-01-01', 'BUY', 10000);
    db.seedTx(PID, '2024-01-31', 'BUY', 10000);
    db.seedSnap(PID, '2024-01-01', 10000);
    db.seedSnap(PID, '2024-01-31', 21000); // preAsset 11000 → +10%
    db.seedSnap(PID, '2024-03-01', 23100); // 19090.909 份 → +10%
    await recalc.recalculateAll(PID);

    expect(daysBetween(utc('2024-01-01'), utc('2024-01-31'))).toBe(30);
    expect(daysBetween(utc('2024-01-31'), utc('2024-03-01'))).toBe(30);

    const nav = db.getNav(PID, '2024-03-01')!;
    const xirrValue = db.getXirr(PID, '2024-03-01')!.xirrValue!;

    expect(nav.cumulativeNav).toBeCloseTo(1.21, 8);
    expect(xirrGrowthFactor(xirrValue, '2024-01-01', '2024-03-01')).toBeCloseTo(1.21, 6);
    expect(nav.shares * nav.unitNav).toBeCloseTo(23100, 6);
  });
});

// ============================================================
// F 组：TWR ≠ MWR 的反例 —— 固化为「正确行为」
// ============================================================

describe('F 组｜变动收益率下 TWR 与 MWR 必然背离（金融定义使然，非 Bug）', () => {
  it('大额资金晚投入错过涨幅：TWR=1.2000 而 MWR=1.1348，两者都对', async () => {
    const { db, recalc } = buildHarness();
    db.seedTx(PID, '2024-01-01', 'BUY', 10000);
    db.seedTx(PID, '2024-01-31', 'BUY', 10000);
    db.seedSnap(PID, '2024-01-01', 10000);
    db.seedSnap(PID, '2024-01-31', 22000); // preAsset 12000 → +20%
    db.seedSnap(PID, '2024-03-01', 22000); // 持平 → 0%
    await recalc.recalculateAll(PID);

    const nav = db.getNav(PID, '2024-03-01')!;
    const xirrValue = db.getXirr(PID, '2024-03-01')!.xirrValue!;
    const mwr = xirrGrowthFactor(xirrValue, '2024-01-01', '2024-03-01');

    // 口径锚点依然成立 —— 这才是必须一致的东西
    expect(nav.shares * nav.unitNav).toBeCloseTo(22000, 6);

    // 两个指标本身不相等，且差距显著
    expect(nav.cumulativeNav).toBeCloseTo(1.2, 8);
    expect(mwr).toBeCloseTo(1.1347524157, 6);
    expect(Math.abs(nav.cumulativeNav - mwr)).toBeGreaterThan(0.05);
  });

  it('TWR 为正但实际亏钱：小钱吃涨幅、大钱吃跌幅（符号可以合法背离）', async () => {
    const { db, recalc } = buildHarness();
    db.seedTx(PID, '2024-01-01', 'BUY', 100);
    db.seedTx(PID, '2024-02-01', 'BUY', 10000);
    db.seedSnap(PID, '2024-01-01', 100);
    db.seedSnap(PID, '2024-02-01', 10200); // preAsset 200 → 翻倍
    db.seedSnap(PID, '2024-03-01', 9180); // −10%
    await recalc.recalculateAll(PID);

    const nav = db.getNav(PID, '2024-03-01')!;
    const xirrValue = db.getXirr(PID, '2024-03-01')!.xirrValue!;

    expect(nav.shares * nav.unitNav).toBeCloseTo(9180, 6);
    expect(nav.cumulativeNav).toBeCloseTo(1.8, 6); // TWR +80%
    expect(xirrValue).toBeLessThan(0); // 实际亏 920 元
    expect(9180 - 10100).toBe(-920);
  });
});

// ============================================================
// G 组：已知缝隙量化（附加信息，不参与通过判定）
// ============================================================

describe('G 组｜已知缝隙量化：首个快照日之前的交易（本次不修）', () => {
  it('7/1 买入但无快照、7/5 才首个快照 → 两引擎对同一账户给出不同本金认定', async () => {
    const { db, recalc } = buildHarness();
    // 7/1 买入 10000，但当天没有录快照
    db.seedTx(PID, '2024-07-01', 'BUY', 10000);
    // 7/5 首个快照，当天又买 5000
    db.seedTx(PID, '2024-07-05', 'BUY', 5000);
    db.seedSnap(PID, '2024-07-05', 15500);
    db.seedSnap(PID, '2024-07-31', 16000);
    await recalc.recalculateAll(PID);

    // nav 侧：7/5 被当成成立日，份额 = 当日买入额 5000，完全无视 7/1 那笔
    const nav0705 = db.getNav(PID, '2024-07-05')!;
    expect(nav0705.unitNav).toBe(1.0);
    expect(nav0705.shares).toBe(5000);

    // 口径锚点在此场景下被打破：5000 × 1.0 = 5000 ≠ 快照 15500
    const impliedByNav = nav0705.shares * nav0705.unitNav;
    expect(impliedByNav).toBe(5000);
    const gap = 15500 - impliedByNav;
    expect(gap).toBe(10500); // 恰为「首日之前的 10000」+「当日买入 5000 未计入定价」

    // xirr 侧：用 lte 查全部交易，7/1 的 10000 被计入现金流
    const xirrValue = db.getXirr(PID, '2024-07-31')!.xirrValue!;
    expect(Number.isFinite(xirrValue)).toBe(true);

    // 量化偏差：nav 认定本金 5000、xirr 认定本金 15000，相差 10000 元（=首日前交易额）
    const navPrincipal = 5000;
    const xirrPrincipal = 15000;
    expect(xirrPrincipal - navPrincipal).toBe(10000);
  });
});
