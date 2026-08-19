/**
 * lib/cron.ts — 5 字段 cron 表达式的前端解析、中文说明与下次执行时间
 *
 * 仅供「定时任务」界面的时间设置的实时预览使用；真正的调度仍以后端
 * APScheduler（backend/.../schedule.py 的 _validate_cron）为准，本模块不做校验拦截。
 *
 * 支持 *、列表、范围、步长；星期域 0-7（7 归一为 0，均表示周日）。
 * 日期域（day-of-month）与星期域（day-of-week）按标准 cron 语义采用「或」匹配。
 * 时区口径：与后端一致固定为北京时间 UTC+8（中国无夏令时，恒定位移 +8h）。
 */

/** 解析后的各域允许取值（升序去重） */
export interface CronParts {
  minute: number[];
  hour: number[];
  dom: number[];
  month: number[];
  dow: number[];
}

const ZH_DOW = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

/** 解析单个 cron 域表达式（min..max 闭区间），非法返回 null */
function parseField(field: string, min: number, max: number): number[] | null {
  const out = new Set<number>();
  for (const raw of field.split(',')) {
    const part = raw.trim();
    if (!part) return null;
    if (part === '*') {
      for (let v = min; v <= max; v++) out.add(v);
      continue;
    }
    let m = /^\*\/(\d+)$/.exec(part);
    if (m) {
      const step = Number(m[1]);
      if (step < 1) return null;
      for (let v = min; v <= max; v += step) out.add(v);
      continue;
    }
    m = /^(\d+)(?:-(\d+))?(?:\/(\d+))?$/.exec(part);
    if (!m) return null;
    const a = Number(m[1]);
    const b = m[2] ? Number(m[2]) : a;
    const step = m[3] ? Number(m[3]) : 1;
    if (a < min || b > max || a > b || step < 1) return null;
    for (let v = a; v <= b; v += step) out.add(v);
  }
  return out.size ? Array.from(out).sort((x, y) => x - y) : null;
}

/**
 * 解析完整 5 字段 cron 表达式；非法（含域数量不对）返回 null。
 *
 * 星期域名归一：0 与 7 均视为周日，返回统一为 0..6。
 */
export function parseCron(expr: string): CronParts | null {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return null;
  const [minute, hour, dom, month, dow] = parts;
  const minuteArr = parseField(minute, 0, 59);
  const hourArr = parseField(hour, 0, 23);
  const domArr = parseField(dom, 1, 31);
  const monthArr = parseField(month, 1, 12);
  const dowArr = parseField(dow, 0, 7);
  if (!minuteArr || !hourArr || !domArr || !monthArr || !dowArr) return null;
  // 7 → 0（周日），去重
  dowArr.forEach((v, i) => {
    if (v === 7) dowArr[i] = 0;
  });
  let dowSet: number[] = [];
  const seen = new Set<number>();
  for (const v of dowArr) {
    if (!seen.has(v)) {
      seen.add(v);
      dowSet.push(v);
    }
  }
  dowSet.sort((x, y) => x - y);
  return { minute: minuteArr, hour: hourArr, dom: domArr, month: monthArr, dow: dowSet };
}

/** 两位数补零 */
function p2(n: number): string {
  return String(n).padStart(2, '0');
}

/** 把北京时间的真实时刻格式化为「YYYY-MM-DD HH:mm 周X」 */
function formatBeijing(real: Date): string {
  const bj = new Date(real.getTime() + 8 * 60 * 60 * 1000);
  const y = bj.getUTCFullYear();
  const mo = bj.getUTCMonth() + 1;
  const d = bj.getUTCDate();
  const h = bj.getUTCHours();
  const mi = bj.getUTCMinutes();
  const dow = new Date(Date.UTC(y, mo - 1, d)).getUTCDay();
  return `${y}-${p2(mo)}-${p2(d)} ${p2(h)}:${p2(mi)} ${ZH_DOW[dow]}`;
}

/**
 * 计算 cron 的下一次执行时间（北京时间），从 now（默认当前时刻）
 * 的下一个整分开始向前扫描；一年内找不 hit 基本可判定永不触发，返回 null。
 */
export function cronNextRun(expr: string, now: Date = new Date()): string | null {
  const p = parseCron(expr);
  if (!p) return null;
  let t = new Date(now);
  t.setSeconds(0, 0);
  t = new Date(t.getTime() + 60_000);
  const domRestricted = p.dom.length < 31;
  const dowRestricted = p.dow.length < 7;
  const cap = 60 * 24 * 400; // 约 400 天上限，避免近似永真问题的死循环
  for (let i = 0; i < cap; i++) {
    const bj = new Date(t.getTime() + 8 * 60 * 60 * 1000);
    const mo = bj.getUTCMonth() + 1;
    const domOk = p.dom.includes(bj.getUTCDate());
    const monthOk = p.month.includes(mo);
    const timeOk = p.minute.includes(bj.getUTCMinutes()) && p.hour.includes(bj.getUTCHours());
    let dayOk: boolean;
    if (domRestricted && dowRestricted) dayOk = domOk || p.dow.includes(bj.getUTCDay());
    else if (domRestricted) dayOk = domOk;
    else if (dowRestricted) dayOk = p.dow.includes(bj.getUTCDay());
    else dayOk = true;
    if (timeOk && monthOk && dayOk) return formatBeijing(t);
    t = new Date(t.getTime() + 60_000);
  }
  return null;
}

/** 生成「执行频率」对应的时刻描述（HH:MM 组合；超限则以「等」省略） */
function renderTime(p: CronParts): string {
  const hrs = p.hour;
  const mins = p.minute;
  if (hrs.length >= 24) {
    if (mins.length === 1) return `每小时第 ${mins[0]} 分`;
    return `每小时第 ${mins.join('、')} 分`;
  }
  if (mins.length >= 60) {
    if (hrs.length === 1) return `${p2(hrs[0])}:00`;
    return `${hrs.map(p2).join('、')} 点整`;
  }
  const combos: string[] = [];
  for (const h of hrs) for (const m of mins) combos.push(`${p2(h)}:${p2(m)}`);
  if (combos.length <= 8) return combos.join('、');
  return `${combos.slice(0, 8).join('、')} 等`;
}

/**
 * 生成 cron 的人类可读中文说明；无法识别（如月域/复杂组合）返回 null，
 * 由调用方回退展示原始表达式。
 */
export function describeCron(expr: string): string | null {
  const p = parseCron(expr);
  if (!p) return null;
  const [minS, hourS, domS, monS, dowS] = expr.trim().split(/\s+/);
  const minStep = /^\*\/(\d+)$/.exec(minS);
  const hourStep = /^\*\/(\d+)$/.exec(hourS);
  const domStep = /^\*\/(\d+)$/.exec(domS);
  const monStep = /^\*\/(\d+)$/.exec(monS);
  const domWild = domS === '*';
  const dowWild = dowS === '*';
  const monWild = monS === '*';

  // 固定间隔（月）：每月 1 号、每隔 N 月（cron: 0 0 1 */N *）
  if (monStep && minS === '0' && hourS === '0' && domS === '1' && dowWild) {
    return `每隔 ${Number(monStep[1])} 月执行一次`;
  }
  // 固定间隔（周）：每隔 7N 天 ≈ 每隔 N 周（cron: 0 0 */7N * *，以每月 1 号为锚）
  if (domStep && minS === '0' && hourS === '0' && monWild && dowWild) {
    const d = Number(domStep[1]);
    if (d % 7 === 0) return `每隔 ${d / 7} 周执行一次`;
    return `每隔 ${d} 天执行一次`;
  }
  // 固定间隔（分钟 / 小时 / 天）
  if (minStep && hourS === '*' && domWild && monWild && dowWild) {
    return `每隔 ${Number(minStep[1])} 分钟执行一次`;
  }
  if (hourStep && minS === '0' && domWild && monWild && dowWild) {
    return `每隔 ${Number(hourStep[1])} 小时执行一次`;
  }
  if (minS === '*' && hourS === '*' && domWild && monWild && dowWild) {
    return '每分钟执行一次';
  }

  const timeText = renderTime(p);
  // 每天
  if (domWild && monWild && dowWild) {
    return `每天 ${timeText} 执行`;
  }
  // 每周
  if (domWild && monWild && !dowWild) {
    const dowText = p.dow.map((d) => ZH_DOW[d]).join('、');
    return `每周 ${dowText} ${timeText} 执行`;
  }
  // 每月
  if (dowWild && monWild && !domWild) {
    return `每月 ${p.dom.map((d) => `${d} 号`).join('、')} ${timeText} 执行`;
  }
  // 仅在指定月份
  if (!monWild) {
    const moText = p.month.map((m) => `${m} 月`).join('、');
    return `（仅在 ${moText}）`;
  }
  return null;
}

/**
 * 生成界面底部常驻的「执行计划」预览文案。
 *
 * 返回 { text }；解析失败时 text 为「按表达式执行」并附原始 cron，
 * 供底部预览始终有内容、且高级模式输入非法时也能即时反馈。
 */
export function previewCron(expr: string, now?: Date): { plan: string; next: string | null } {
  const trimmed = expr.trim();
  const desc = describeCron(trimmed);
  const next = cronNextRun(trimmed, now);
  const plan = desc ?? `按表达式执行（${trimmed || '空'}）`;
  return { plan, next };
}