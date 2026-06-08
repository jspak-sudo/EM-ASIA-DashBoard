import { Router, Request, Response } from 'express';
import https from 'https';

const router = Router();

// ── Yahoo Finance fetch ──────────────────────────────────────────────────────
function get(url: string, timeoutMs = 30000): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, res => {
      const chunks: Buffer[] = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks).toString()));
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => req.destroy(new Error('timeout')));
  });
}

interface Bar { date: string; close: number; ret: number }

const _cache: Record<string, { bars: Bar[]; ts: number }> = {};
const CACHE_TTL = 6 * 3600 * 1000; // 6h

async function fetchSymbol(sym: string): Promise<Bar[]> {
  const c = _cache[sym];
  if (c && Date.now() - c.ts < CACHE_TTL) return c.bars;

  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?period1=473385600&period2=1843200000&interval=1d`;
  const txt = await get(url);
  const j = JSON.parse(txt);
  const r = j.chart.result?.[0];
  if (!r) throw new Error('No data');
  const ts: number[] = r.timestamp;
  const closes: (number|null)[] = r.indicators.quote[0].close;

  const bars: Bar[] = [];
  let prev: number | null = null;
  for (let i = 0; i < ts.length; i++) {
    const close = closes[i];
    if (close == null) continue;
    const date = new Date(ts[i] * 1000).toISOString().slice(0, 10);
    const ret = prev != null ? (close / prev - 1) * 100 : 0;
    bars.push({ date, close, ret });
    prev = close;
  }
  _cache[sym] = { bars, ts: Date.now() };
  return bars;
}

// ── 통계 헬퍼 ────────────────────────────────────────────────────────────────
function maxDrawdown(equity: number[]): number {
  let peak = equity[0], mdd = 0;
  for (const v of equity) { if (v > peak) peak = v; const d = (v - peak) / peak; if (d < mdd) mdd = d; }
  return mdd * 100;
}
function cagr(equity: number[], years: number): number {
  return (Math.pow(equity[equity.length - 1] / equity[0], 1 / years) - 1) * 100;
}
function movingAverage(bars: Bar[], window: number): (number|null)[] {
  const ma: (number|null)[] = [];
  let sum = 0;
  for (let i = 0; i < bars.length; i++) {
    sum += bars[i].close;
    if (i >= window) sum -= bars[i - window].close;
    ma.push(i >= window - 1 ? sum / window : null);
  }
  return ma;
}
function runningDrawdown(bars: Bar[]): number[] {
  const dd: number[] = [];
  let peak = bars[0].close;
  for (const b of bars) { if (b.close > peak) peak = b.close; dd.push((b.close - peak) / peak * 100); }
  return dd;
}

// ── 회피 전략 ────────────────────────────────────────────────────────────────
type ReentryRule =
  | { kind: 'fixed_days'; days: number }
  | { kind: 'consecutive_up'; n: number }
  | { kind: 'recover_from_low'; pct: number }
  | { kind: 'above_ma'; window: number }
  | { kind: 'fixed_and_ma'; days: number; window: number };

function simulateAvoid(bars: Bar[], threshold: number, rule: ReentryRule) {
  const ma20 = movingAverage(bars, 20);
  const ma200 = movingAverage(bars, 200);
  const equity: number[] = [1];
  let position = 1, exitIdx = -1, trades = 0;

  for (let i = 1; i < bars.length; i++) {
    const b = bars[i];
    equity.push(equity[equity.length - 1] * (position === 1 ? (1 + b.ret / 100) : 1));

    if (position === 1 && b.ret <= threshold) {
      position = 0; exitIdx = i; trades++;
    } else if (position === 0) {
      let reenter = false;
      const since = i - exitIdx;
      if (rule.kind === 'fixed_days') reenter = since >= rule.days;
      else if (rule.kind === 'consecutive_up') {
        if (i >= rule.n) { reenter = true; for (let k = 0; k < rule.n; k++) if (bars[i-k].ret <= 0) { reenter = false; break; } }
      } else if (rule.kind === 'recover_from_low') {
        let low = bars[exitIdx].close;
        for (let k = exitIdx + 1; k <= i; k++) if (bars[k].close < low) low = bars[k].close;
        reenter = (bars[i].close / low - 1) * 100 >= rule.pct;
      } else if (rule.kind === 'above_ma') {
        const ma = rule.window === 20 ? ma20 : ma200;
        reenter = ma[i] != null && bars[i].close > (ma[i] as number);
      } else if (rule.kind === 'fixed_and_ma') {
        const ma = rule.window === 20 ? ma20 : ma200;
        reenter = since >= rule.days && ma[i] != null && bars[i].close > (ma[i] as number);
      }
      if (reenter) { position = 1; trades++; }
    }
  }
  const years = (new Date(bars[bars.length-1].date).getTime() - new Date(bars[0].date).getTime()) / (365.25 * 86400000);
  return { finalEquity: equity[equity.length-1], cagr: cagr(equity, years), mdd: maxDrawdown(equity), trades, equityCurve: equity };
}

// ── 추가매수 전략 ────────────────────────────────────────────────────────────
type DipRule =
  | { kind: 'dca_only' }
  | { kind: 'on_drop'; drop: number; extra: number } // -drop% 일 시 extra
  | { kind: 'tiered_dd'; tiers: { dd: number; extra: number }[] };

function simulateDip(bars: Bar[], monthly: number, rule: DipRule) {
  const dd = runningDrawdown(bars);
  let shares = 0, totalInvested = 0, lastMonth = '';

  for (let i = 0; i < bars.length; i++) {
    const b = bars[i];
    const m = b.date.slice(0, 7);
    if (m !== lastMonth) { shares += monthly / b.close; totalInvested += monthly; lastMonth = m; }

    let extra = 0;
    if (rule.kind === 'on_drop' && b.ret <= -rule.drop) extra = rule.extra;
    else if (rule.kind === 'tiered_dd') {
      for (const t of rule.tiers) {
        if (dd[i] <= -t.dd && (i === 0 || dd[i-1] > -t.dd)) extra += t.extra;
      }
    }
    if (extra > 0) { shares += extra / b.close; totalInvested += extra; }
  }
  const finalValue = shares * bars[bars.length-1].close;
  const years = (new Date(bars[bars.length-1].date).getTime() - new Date(bars[0].date).getTime()) / (365.25 * 86400000);
  return {
    totalInvested,
    finalValue,
    multiplier: finalValue / totalInvested,
    moneyWeightedAnnual: (Math.pow(finalValue / totalInvested, 1 / years) - 1) * 100,
  };
}

// ── 회복기간 분석 ────────────────────────────────────────────────────────────
function analyzeBottoming(bars: Bar[], threshold: number, lookahead = 60) {
  const out: { daysToLow: number; additionalDrop: number }[] = [];
  for (let i = 0; i < bars.length; i++) {
    if (bars[i].ret > threshold) continue;
    const trigger = bars[i].close;
    let low = trigger, daysToLow = 0;
    for (let k = 1; k <= lookahead && i + k < bars.length; k++) {
      if (bars[i + k].close < low) { low = bars[i + k].close; daysToLow = k; }
    }
    out.push({ daysToLow, additionalDrop: (low / trigger - 1) * 100 });
  }
  return out;
}

// ── 기간 필터링 ──────────────────────────────────────────────────────────────
function filterByPeriod(bars: Bar[], period: string): Bar[] {
  if (period === 'all' || !period) return bars;
  const now = new Date(bars[bars.length-1].date).getTime();
  let yearsBack = 0;
  if (period === '1y') yearsBack = 1;
  else if (period === '3y') yearsBack = 3;
  else if (period === '5y') yearsBack = 5;
  else if (period === '10y') yearsBack = 10;
  else if (period === '20y') yearsBack = 20;
  else if (period === '30y') yearsBack = 30;
  if (yearsBack === 0) return bars;
  const cutoff = now - yearsBack * 365.25 * 86400000;
  const result = bars.filter(b => new Date(b.date).getTime() >= cutoff);
  // 첫 봉 ret=0으로 재계산
  if (result.length > 0) {
    result[0] = { ...result[0], ret: 0 };
    for (let i = 1; i < result.length; i++) {
      result[i] = { ...result[i], ret: (result[i].close / result[i-1].close - 1) * 100 };
    }
  }
  return result;
}

// ── 메인 라우트 ──────────────────────────────────────────────────────────────
router.get('/', async (req: Request, res: Response) => {
  try {
    const symbol = (req.query.symbol as string) || '^IXIC';
    const period = (req.query.period as string) || 'all';
    const threshold = parseFloat((req.query.threshold as string) || '-3');

    const allBars = await fetchSymbol(symbol);
    const bars = filterByPeriod(allBars, period);
    if (bars.length < 100) return res.status(400).json({ error: '데이터 부족' });

    const years = (new Date(bars[bars.length-1].date).getTime() - new Date(bars[0].date).getTime()) / (365.25 * 86400000);

    // Buy & Hold
    const bhEquity = [1];
    for (let i = 1; i < bars.length; i++) bhEquity.push(bhEquity[i-1] * (1 + bars[i].ret / 100));
    const bhResult = { label: 'Buy & Hold', finalEquity: bhEquity[bhEquity.length-1], cagr: cagr(bhEquity, years), mdd: maxDrawdown(bhEquity), trades: 0 };

    // 회피 전략들
    const avoidStrats: { label: string; rule: ReentryRule }[] = [
      { label: `${threshold}% 매도, 5일 후 재진입`, rule: { kind: 'fixed_days', days: 5 } },
      { label: `${threshold}% 매도, 20일(1개월) 후 재진입`, rule: { kind: 'fixed_days', days: 20 } },
      { label: `${threshold}% 매도, 60일(3개월) 후 재진입`, rule: { kind: 'fixed_days', days: 60 } },
      { label: `${threshold}% 매도, 연속 3일 상승 시 재진입`, rule: { kind: 'consecutive_up', n: 3 } },
      { label: `${threshold}% 매도, 연속 5일 상승 시 재진입`, rule: { kind: 'consecutive_up', n: 5 } },
      { label: `${threshold}% 매도, 저점 +5% 반등`, rule: { kind: 'recover_from_low', pct: 5 } },
      { label: `${threshold}% 매도, 저점 +10% 반등`, rule: { kind: 'recover_from_low', pct: 10 } },
      { label: `${threshold}% 매도, 가격>MA20`, rule: { kind: 'above_ma', window: 20 } },
      { label: `${threshold}% 매도, 가격>MA200`, rule: { kind: 'above_ma', window: 200 } },
      { label: `${threshold}% 매도, 20일 후 AND 가격>MA20`, rule: { kind: 'fixed_and_ma', days: 20, window: 20 } },
    ];

    const avoidResults = [bhResult, ...avoidStrats.map(s => {
      const r = simulateAvoid(bars, threshold, s.rule);
      return { label: s.label, finalEquity: r.finalEquity, cagr: r.cagr, mdd: r.mdd, trades: r.trades };
    })];

    // 추가매수 전략들 (월 100만원 기준)
    const dipStrats: { label: string; monthly: number; rule: DipRule }[] = [
      { label: 'DCA만 (월 100만원)', monthly: 1_000_000, rule: { kind: 'dca_only' } },
      { label: 'DCA + -3% 시 100만원 추가', monthly: 1_000_000, rule: { kind: 'on_drop', drop: 3, extra: 1_000_000 } },
      { label: 'DCA + -3% 시 200만원 추가', monthly: 1_000_000, rule: { kind: 'on_drop', drop: 3, extra: 2_000_000 } },
      { label: 'DCA + -5% 시 300만원 추가', monthly: 1_000_000, rule: { kind: 'on_drop', drop: 5, extra: 3_000_000 } },
      { label: 'DCA + 드로다운 단계별 (-10%/200, -15%/300, -20%/500)', monthly: 1_000_000, rule: { kind: 'tiered_dd', tiers: [
        { dd: 10, extra: 2_000_000 }, { dd: 15, extra: 3_000_000 }, { dd: 20, extra: 5_000_000 }, { dd: 30, extra: 10_000_000 },
      ]}},
      { label: '인내형: DCA + 드로다운 -20%만 1000만원', monthly: 1_000_000, rule: { kind: 'tiered_dd', tiers: [
        { dd: 20, extra: 10_000_000 },
      ]}},
      { label: '공격적: DCA 50만 + 단계별 (-5/-10/-15/-20/-30)', monthly: 500_000, rule: { kind: 'tiered_dd', tiers: [
        { dd: 5, extra: 1_000_000 }, { dd: 10, extra: 2_000_000 }, { dd: 15, extra: 3_000_000 }, { dd: 20, extra: 5_000_000 }, { dd: 30, extra: 10_000_000 },
      ]}},
    ];
    const dipResults = dipStrats.map(s => ({ label: s.label, ...simulateDip(bars, s.monthly, s.rule) }));

    // 회복 분석
    const recovery = analyzeBottoming(bars, threshold, 60);
    const sortedDays = [...recovery].sort((a,b)=>a.daysToLow-b.daysToLow);
    const sortedDrop = [...recovery].sort((a,b)=>a.additionalDrop-b.additionalDrop);
    const med = (arr:any[], k:string) => arr.length ? arr[Math.floor(arr.length/2)][k] : 0;
    const recoveryStats = {
      count: recovery.length,
      medianDaysToLow: med(sortedDays, 'daysToLow'),
      avgDaysToLow: recovery.reduce((a,b)=>a+b.daysToLow,0) / Math.max(recovery.length,1),
      medianAdditionalDrop: med(sortedDrop, 'additionalDrop'),
      avgAdditionalDrop: recovery.reduce((a,b)=>a+b.additionalDrop,0) / Math.max(recovery.length,1),
      pctImmediate: (recovery.filter(d=>d.daysToLow===0).length / Math.max(recovery.length,1)) * 100,
      pctWithin5: (recovery.filter(d=>d.daysToLow<=5).length / Math.max(recovery.length,1)) * 100,
      pctWithin20: (recovery.filter(d=>d.daysToLow<=20).length / Math.max(recovery.length,1)) * 100,
    };

    // 차트용 equity 데이터 (월간 샘플)
    function sampleMonthly(equity: number[]): { date: string; v: number }[] {
      const out: { date: string; v: number }[] = [];
      let lastMonth = '';
      for (let i = 0; i < bars.length; i++) {
        const m = bars[i].date.slice(0, 7);
        if (m !== lastMonth) { out.push({ date: bars[i].date, v: equity[i] }); lastMonth = m; }
      }
      return out;
    }
    const equityChart = sampleMonthly(bhEquity);

    // 연도별 트리거
    const yearCount: Record<string, number> = {};
    for (const b of bars) if (b.ret <= threshold) {
      const y = b.date.slice(0, 4);
      yearCount[y] = (yearCount[y] || 0) + 1;
    }

    res.json({
      meta: {
        symbol, period, threshold,
        startDate: bars[0].date,
        endDate: bars[bars.length-1].date,
        days: bars.length,
        years,
      },
      avoid: avoidResults,
      dip: dipResults,
      recovery: recoveryStats,
      equityChart,
      yearCount,
    });
  } catch (e: any) {
    res.status(500).json({ error: String(e?.message || e) });
  }
});

export default router;
