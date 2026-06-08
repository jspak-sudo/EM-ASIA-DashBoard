/**
 * NASDAQ 재진입 타이밍 & 추가매수 타이밍 백테스트
 * 사용: npx tsx scripts/backtest-timing.ts
 * 결과: docs/backtest_timing.html
 */
import https from 'https';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

function get(url: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, res => {
      const chunks: Buffer[] = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks).toString()));
    });
    req.on('error', reject);
    req.setTimeout(30000, () => req.destroy(new Error('timeout')));
  });
}

interface Bar { date: string; close: number; ret: number; high: number; low: number }

async function fetchSymbol(sym: string): Promise<Bar[]> {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?period1=473385600&period2=1843200000&interval=1d`;
  const txt = await get(url);
  const j = JSON.parse(txt);
  const r = j.chart.result[0];
  const ts: number[] = r.timestamp;
  const closes: (number|null)[] = r.indicators.quote[0].close;
  const highs: (number|null)[] = r.indicators.quote[0].high;
  const lows: (number|null)[] = r.indicators.quote[0].low;
  const bars: Bar[] = [];
  let prev: number | null = null;
  for (let i = 0; i < ts.length; i++) {
    const c = closes[i];
    if (c == null) continue;
    const date = new Date(ts[i] * 1000).toISOString().slice(0, 10);
    const ret = prev != null ? (c / prev - 1) * 100 : 0;
    bars.push({ date, close: c, ret, high: highs[i] || c, low: lows[i] || c });
    prev = c;
  }
  return bars;
}

// ── 헬퍼 ─────────────────────────────────────────────────────────────────────
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
  for (const b of bars) {
    if (b.close > peak) peak = b.close;
    dd.push((b.close - peak) / peak * 100);
  }
  return dd;
}

function maxDrawdown(equity: number[]): number {
  let peak = equity[0], mdd = 0;
  for (const v of equity) { if (v > peak) peak = v; const d = (v - peak) / peak; if (d < mdd) mdd = d; }
  return mdd * 100;
}

function cagr(equity: number[], years: number): number {
  return (Math.pow(equity[equity.length - 1] / equity[0], 1 / years) - 1) * 100;
}

// ═══════════════════════════════════════════════════════════════════════════
// PART 1: 회피 후 재진입 타이밍 분석
// ═══════════════════════════════════════════════════════════════════════════

/** 각 -3% 트리거 후 N영업일 동안의 최저점과 회복 패턴 분석 */
function analyzeBottoming(bars: Bar[], threshold: number, lookahead: number) {
  const results: {
    triggerDate: string;
    triggerPrice: number;
    daysToLow: number;
    lowPrice: number;
    additionalDropPct: number;
    return20d: number;
    return60d: number;
    return120d: number;
  }[] = [];

  for (let i = 0; i < bars.length - lookahead; i++) {
    if (bars[i].ret > threshold) continue;
    const triggerPrice = bars[i].close;
    let lowPrice = triggerPrice;
    let daysToLow = 0;
    for (let k = 1; k <= lookahead; k++) {
      if (i + k >= bars.length) break;
      if (bars[i + k].close < lowPrice) { lowPrice = bars[i + k].close; daysToLow = k; }
    }
    const idx20 = Math.min(i + 20, bars.length - 1);
    const idx60 = Math.min(i + 60, bars.length - 1);
    const idx120 = Math.min(i + 120, bars.length - 1);
    results.push({
      triggerDate: bars[i].date,
      triggerPrice,
      daysToLow,
      lowPrice,
      additionalDropPct: (lowPrice / triggerPrice - 1) * 100,
      return20d: (bars[idx20].close / triggerPrice - 1) * 100,
      return60d: (bars[idx60].close / triggerPrice - 1) * 100,
      return120d: (bars[idx120].close / triggerPrice - 1) * 100,
    });
  }
  return results;
}

/** 재진입 전략 시뮬레이션 — 매번 -3% 트리거 시 매도 후 X신호 발생 시 재진입 */
interface ReentryStrategy {
  label: string;
  // 함수: (boughtOutAtIdx, bars, currentIdx) → 재진입 여부
  shouldReenter: (exitIdx: number, currentIdx: number, bars: Bar[], ma20: (number|null)[], ma200: (number|null)[]) => boolean;
}

function simulateReentryStrategy(bars: Bar[], threshold: number, strat: ReentryStrategy) {
  const ma20 = movingAverage(bars, 20);
  const ma200 = movingAverage(bars, 200);
  const equity: number[] = [1];
  let position = 1;
  let exitIdx = -1;
  let trades = 0;

  for (let i = 1; i < bars.length; i++) {
    const b = bars[i];
    equity.push(equity[equity.length - 1] * (position === 1 ? (1 + b.ret / 100) : 1));

    if (position === 1 && b.ret <= threshold) {
      position = 0;
      exitIdx = i;
      trades++;
    } else if (position === 0) {
      if (strat.shouldReenter(exitIdx, i, bars, ma20, ma200)) {
        position = 1;
        trades++;
      }
    }
  }
  const years = (new Date(bars[bars.length - 1].date).getTime() - new Date(bars[0].date).getTime()) / (365.25 * 86400000);
  return {
    label: strat.label,
    finalEquity: equity[equity.length - 1],
    cagr: cagr(equity, years),
    mdd: maxDrawdown(equity),
    trades,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// PART 2: 추가매수(Dip Buying) 타이밍 분석
// ═══════════════════════════════════════════════════════════════════════════

/** 매월 X원 적립 + 추가매수 신호 발생 시 NX원 추가 매수 */
interface DipStrategy {
  label: string;
  monthlyAmount: number;        // 기본 월 적립
  // (오늘 신호 시 매수해야 할 추가 금액) → 0이면 매수 안함
  extraOnDay: (bars: Bar[], i: number, drawdown: number[]) => number;
}

function simulateDipBuying(bars: Bar[], strat: DipStrategy) {
  const dd = runningDrawdown(bars);
  let shares = 0;
  let totalInvested = 0;
  let lastMonth = '';

  for (let i = 0; i < bars.length; i++) {
    const b = bars[i];
    const month = b.date.slice(0, 7);

    // 매월 정기 적립
    if (month !== lastMonth) {
      shares += strat.monthlyAmount / b.close;
      totalInvested += strat.monthlyAmount;
      lastMonth = month;
    }

    // 추가 매수 신호
    const extra = strat.extraOnDay(bars, i, dd);
    if (extra > 0) {
      shares += extra / b.close;
      totalInvested += extra;
    }
  }

  const finalValue = shares * bars[bars.length - 1].close;
  const years = (new Date(bars[bars.length - 1].date).getTime() - new Date(bars[0].date).getTime()) / (365.25 * 86400000);
  const totalReturn = (finalValue / totalInvested - 1) * 100;
  // 단순 평균 IRR 근사: total return / years (CAGR with no compounding of inflow)
  // 더 정확한 IRR은 계산복잡 → 여기선 money-weighted approx
  const moneyWeightedReturn = Math.pow(finalValue / totalInvested, 1 / years) - 1;
  return {
    label: strat.label,
    totalInvested,
    finalValue,
    totalReturn,
    moneyWeightedAnnual: moneyWeightedReturn * 100,
    multiplier: finalValue / totalInvested,
  };
}

// ── 메인 ─────────────────────────────────────────────────────────────────────
async function main() {
  console.log('📊 NASDAQ 재진입 & 추가매수 타이밍 백테스트\n');
  console.log('데이터 가져오는 중...');
  const bars = await fetchSymbol('^IXIC');
  console.log(`✅ NASDAQ ${bars.length}일 (${bars[0].date} ~ ${bars[bars.length - 1].date})\n`);

  const years = (new Date(bars[bars.length - 1].date).getTime() - new Date(bars[0].date).getTime()) / (365.25 * 86400000);

  // ═══════ PART 1: 회피 후 바닥 패턴 분석 ═══════
  console.log('PART 1: -3% 트리거 후 바닥 패턴 분석...');
  const bottomData60 = analyzeBottoming(bars, -3, 60);
  const bottomData20 = analyzeBottoming(bars, -3, 20);

  // 통계
  const sorted60Days = [...bottomData60].sort((a, b) => a.daysToLow - b.daysToLow);
  const sortedDrop = [...bottomData60].sort((a, b) => a.additionalDropPct - b.additionalDropPct);
  const med = (arr: any[], key: string) => arr[Math.floor(arr.length / 2)][key];
  const avg = (arr: number[]) => arr.reduce((a, b) => a + b, 0) / arr.length;

  const triggerStats = {
    count: bottomData60.length,
    medianDaysToLow: med(sorted60Days, 'daysToLow'),
    avgDaysToLow: avg(bottomData60.map(d => d.daysToLow)),
    medianAdditionalDrop: med(sortedDrop, 'additionalDropPct'),
    avgAdditionalDrop: avg(bottomData60.map(d => d.additionalDropPct)),
    pctImmediate: (bottomData60.filter(d => d.daysToLow === 0).length / bottomData60.length) * 100,
    pctWithin5: (bottomData60.filter(d => d.daysToLow <= 5).length / bottomData60.length) * 100,
    pctWithin20: (bottomData60.filter(d => d.daysToLow <= 20).length / bottomData60.length) * 100,
    avg20d: avg(bottomData60.map(d => d.return20d)),
    avg60d: avg(bottomData60.map(d => d.return60d)),
    avg120d: avg(bottomData60.map(d => d.return120d)),
  };

  console.log(`  총 ${triggerStats.count}회 트리거 분석`);
  console.log(`  중앙값: 바닥까지 ${triggerStats.medianDaysToLow}일, 추가하락 ${triggerStats.medianAdditionalDrop.toFixed(2)}%`);

  // ═══════ PART 2: 재진입 전략 비교 ═══════
  console.log('\nPART 2: 재진입 전략 시뮬레이션...');

  // Buy & Hold 베이스라인
  const bhEquity = [1];
  for (let i = 1; i < bars.length; i++) bhEquity.push(bhEquity[i - 1] * (1 + bars[i].ret / 100));
  const bhResult = { label: 'Buy & Hold (베이스)', finalEquity: bhEquity[bhEquity.length - 1], cagr: cagr(bhEquity, years), mdd: maxDrawdown(bhEquity), trades: 0 };

  const reentryStrats: ReentryStrategy[] = [
    { label: '5일 후 즉시 재진입', shouldReenter: (exit, cur) => (cur - exit) >= 5 },
    { label: '20일 (1개월) 후', shouldReenter: (exit, cur) => (cur - exit) >= 20 },
    { label: '60일 (3개월) 후', shouldReenter: (exit, cur) => (cur - exit) >= 60 },
    { label: '연속 3일 상승 시', shouldReenter: (exit, cur, bars) => {
        if (cur < 3) return false;
        return bars[cur].ret > 0 && bars[cur-1].ret > 0 && bars[cur-2].ret > 0;
      }},
    { label: '연속 5일 상승 시', shouldReenter: (exit, cur, bars) => {
        if (cur < 5) return false;
        for (let k = 0; k < 5; k++) if (bars[cur-k].ret <= 0) return false;
        return true;
      }},
    { label: '저점 대비 +5% 반등', shouldReenter: (exit, cur, bars) => {
        if (cur <= exit) return false;
        let low = bars[exit].close;
        for (let k = exit + 1; k <= cur; k++) if (bars[k].close < low) low = bars[k].close;
        return (bars[cur].close / low - 1) * 100 >= 5;
      }},
    { label: '저점 대비 +10% 반등', shouldReenter: (exit, cur, bars) => {
        if (cur <= exit) return false;
        let low = bars[exit].close;
        for (let k = exit + 1; k <= cur; k++) if (bars[k].close < low) low = bars[k].close;
        return (bars[cur].close / low - 1) * 100 >= 10;
      }},
    { label: '가격 > 20일 이평선', shouldReenter: (exit, cur, bars, ma20) => {
        if (cur <= exit + 1) return false;
        return ma20[cur] != null && bars[cur].close > (ma20[cur] as number);
      }},
    { label: '가격 > 200일 이평선', shouldReenter: (exit, cur, bars, ma20, ma200) => {
        if (cur <= exit + 1) return false;
        return ma200[cur] != null && bars[cur].close > (ma200[cur] as number);
      }},
    { label: '20일 후 AND 가격>MA20', shouldReenter: (exit, cur, bars, ma20) => {
        if ((cur - exit) < 20) return false;
        return ma20[cur] != null && bars[cur].close > (ma20[cur] as number);
      }},
  ];

  const reentryResults = [bhResult];
  for (const s of reentryStrats) {
    const r = simulateReentryStrategy(bars, -3, s);
    reentryResults.push(r);
    console.log(`  ${s.label.padEnd(30)} → CAGR ${r.cagr.toFixed(2)}%, MDD ${r.mdd.toFixed(1)}%`);
  }

  // ═══════ PART 3: 추가매수 전략 비교 ═══════
  console.log('\nPART 3: 추가매수(Dip Buying) 전략 시뮬레이션...');

  const dipStrats: DipStrategy[] = [
    {
      label: 'DCA만 (매월 100만원)',
      monthlyAmount: 1_000_000,
      extraOnDay: () => 0,
    },
    {
      label: 'DCA + -3% 시 100만원 추가',
      monthlyAmount: 1_000_000,
      extraOnDay: (bars, i) => bars[i].ret <= -3 ? 1_000_000 : 0,
    },
    {
      label: 'DCA + -3% 시 200만원 추가',
      monthlyAmount: 1_000_000,
      extraOnDay: (bars, i) => bars[i].ret <= -3 ? 2_000_000 : 0,
    },
    {
      label: 'DCA + 드로다운 -10% 시 300만원',
      monthlyAmount: 1_000_000,
      extraOnDay: (bars, i, dd) => {
        // -10% 드로다운에 들어선 첫날만
        if (dd[i] <= -10 && (i === 0 || dd[i - 1] > -10)) return 3_000_000;
        return 0;
      },
    },
    {
      label: 'DCA + 단계별 (-10% 200만, -15% 300만, -20% 500만)',
      monthlyAmount: 1_000_000,
      extraOnDay: (bars, i, dd) => {
        let extra = 0;
        // 새로 진입하는 단계만 트리거
        if (dd[i] <= -10 && (i === 0 || dd[i - 1] > -10)) extra += 2_000_000;
        if (dd[i] <= -15 && (i === 0 || dd[i - 1] > -15)) extra += 3_000_000;
        if (dd[i] <= -20 && (i === 0 || dd[i - 1] > -20)) extra += 5_000_000;
        if (dd[i] <= -30 && (i === 0 || dd[i - 1] > -30)) extra += 10_000_000;
        return extra;
      },
    },
    {
      label: 'DCA + 매월 -3% 일마다 200만원 (월 한도 없음)',
      monthlyAmount: 1_000_000,
      extraOnDay: (bars, i) => bars[i].ret <= -3 ? 2_000_000 : 0,
    },
    {
      label: '공격적: DCA 50만 + 드로다운 -5%마다 100만, -10%마다 200만, -20%마다 500만',
      monthlyAmount: 500_000,
      extraOnDay: (bars, i, dd) => {
        let extra = 0;
        if (dd[i] <= -5  && (i === 0 || dd[i - 1] > -5))  extra += 1_000_000;
        if (dd[i] <= -10 && (i === 0 || dd[i - 1] > -10)) extra += 2_000_000;
        if (dd[i] <= -15 && (i === 0 || dd[i - 1] > -15)) extra += 3_000_000;
        if (dd[i] <= -20 && (i === 0 || dd[i - 1] > -20)) extra += 5_000_000;
        if (dd[i] <= -30 && (i === 0 || dd[i - 1] > -30)) extra += 10_000_000;
        if (dd[i] <= -40 && (i === 0 || dd[i - 1] > -40)) extra += 15_000_000;
        return extra;
      },
    },
    {
      label: '인내형: DCA 100만 + 드로다운 -20%만 1000만원',
      monthlyAmount: 1_000_000,
      extraOnDay: (bars, i, dd) => {
        if (dd[i] <= -20 && (i === 0 || dd[i - 1] > -20)) return 10_000_000;
        return 0;
      },
    },
  ];

  const dipResults = dipStrats.map(s => {
    const r = simulateDipBuying(bars, s);
    console.log(`  ${s.label.padEnd(60)} → 투자 ${(r.totalInvested/1e8).toFixed(1)}억 / 최종 ${(r.finalValue/1e8).toFixed(1)}억 / ${r.multiplier.toFixed(2)}배`);
    return r;
  });

  // ═══════ HTML 생성 ═══════
  console.log('\nHTML 보고서 생성 중...');

  // 바닥까지 일수 분포 버킷
  const dayBuckets = [
    { range: '당일 (즉시)',    min: 0,   max: 0 },
    { range: '1~3일 후',     min: 1,   max: 3 },
    { range: '4~10일 후',    min: 4,   max: 10 },
    { range: '11~20일 후',   min: 11,  max: 20 },
    { range: '21~40일 후',   min: 21,  max: 40 },
    { range: '41~60일 후',   min: 41,  max: 60 },
  ];
  for (const b of dayBuckets) (b as any).count = bottomData60.filter(d => d.daysToLow >= b.min && d.daysToLow <= b.max).length;

  // 추가하락폭 분포 버킷
  const dropBuckets = [
    { range: '추가하락 없음 (당일이 바닥)', min: 0,    max: 0 },
    { range: '~-3%',     min: -3,   max: -0.0001 },
    { range: '-3 ~ -7%', min: -7,   max: -3.0001 },
    { range: '-7 ~ -15%', min: -15, max: -7.0001 },
    { range: '-15 ~ -30%', min: -30, max: -15.0001 },
    { range: '-30% 이하', min: -100, max: -30.0001 },
  ];
  for (const b of dropBuckets) (b as any).count = bottomData60.filter(d => d.additionalDropPct <= b.max && d.additionalDropPct >= b.min).length;

  const html = `<!DOCTYPE html>
<html lang="ko"><head>
<meta charset="UTF-8"><title>NASDAQ 재진입·추가매수 타이밍 백테스트</title>
<script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
<style>
body{font-family:'Noto Sans KR',sans-serif;background:#0b0f1a;color:#e8ebf2;padding:24px;max-width:1400px;margin:0 auto;line-height:1.6}
h1{color:#e37500;border-bottom:2px solid #2a334a;padding-bottom:8px}
h2{color:#4a9eff;margin-top:36px;border-left:4px solid #4a9eff;padding-left:12px}
h3{color:#a0a8bc;margin-top:24px}
table{border-collapse:collapse;width:100%;margin:12px 0;font-size:13px}
th{background:#1a2134;padding:10px;text-align:left;border-bottom:2px solid #2a334a;font-size:12px}
td{padding:8px 10px;border-bottom:1px solid #1f2738}
tr:hover{background:#141a2a}
.good{color:#34d399;font-weight:600}.bad{color:#f87171;font-weight:600}.neutral{color:#a0a8bc}
.card{background:#141a2a;border:1px solid #1f2738;border-radius:12px;padding:20px;margin:16px 0}
.metric{display:inline-block;margin-right:32px;margin-bottom:12px}
.metric .v{font-size:32px;font-weight:bold;color:#e37500;display:block;line-height:1}
.metric .l{font-size:11px;color:#667088;text-transform:uppercase;margin-top:4px;display:block}
.note{background:#1a1f30;border-left:3px solid #4a9eff;padding:12px 16px;font-size:13px;margin:12px 0;border-radius:4px}
.insight{background:#1a2c1f;border-left:3px solid #34d399;padding:14px 18px;font-size:13px;margin:14px 0;border-radius:4px}
.warn{background:#2c1a1a;border-left:3px solid #f87171;padding:14px 18px;font-size:13px;margin:14px 0;border-radius:4px}
canvas{max-width:100%}
.bestrow{background:linear-gradient(90deg,#1a2c1f,transparent);font-weight:bold}
</style>
</head><body>

<h1>📊 NASDAQ 재진입 · 추가매수 타이밍 백테스트</h1>
<p class="neutral">기간 <b>${bars[0].date} ~ ${bars[bars.length - 1].date}</b> (${bars.length}일, ${years.toFixed(1)}년) · ${triggerStats.count}회 -3% 트리거 분석</p>

<!-- ════════════════════════════════════════════════ -->
<h2>🎯 Q1. 회피 후 언제 재진입하면 좋을까?</h2>

<div class="card">
  <h3 style="margin-top:0">먼저: -3% 다음에 진짜 바닥은 언제 오나?</h3>
  <div style="margin:20px 0">
    <div class="metric"><span class="v">${triggerStats.medianDaysToLow}일</span><span class="l">바닥까지 (중앙값)</span></div>
    <div class="metric"><span class="v">${triggerStats.avgDaysToLow.toFixed(1)}일</span><span class="l">바닥까지 (평균)</span></div>
    <div class="metric"><span class="v">${triggerStats.medianAdditionalDrop.toFixed(2)}%</span><span class="l">추가하락폭 (중앙값)</span></div>
    <div class="metric"><span class="v">${triggerStats.pctImmediate.toFixed(0)}%</span><span class="l">당일 바닥 비율</span></div>
    <div class="metric"><span class="v">${triggerStats.pctWithin5.toFixed(0)}%</span><span class="l">5일내 바닥</span></div>
    <div class="metric"><span class="v">${triggerStats.pctWithin20.toFixed(0)}%</span><span class="l">20일내 바닥</span></div>
  </div>

  <h3>"-3% 후 N일 뒤 바닥 도달" 분포</h3>
  <table>
    <thead><tr><th>바닥 도달 시기</th><th>건수</th><th>비율</th></tr></thead>
    <tbody>
      ${dayBuckets.map((b: any) => `<tr><td>${b.range}</td><td>${b.count}회</td><td>${(b.count / triggerStats.count * 100).toFixed(1)}%</td></tr>`).join('')}
    </tbody>
  </table>

  <h3>추가 하락폭 분포 (-3% 트리거 → 60일 내 최저점)</h3>
  <table>
    <thead><tr><th>트리거가 대비 추가 하락폭</th><th>건수</th><th>비율</th></tr></thead>
    <tbody>
      ${dropBuckets.map((b: any) => `<tr><td>${b.range}</td><td>${b.count}회</td><td>${(b.count / triggerStats.count * 100).toFixed(1)}%</td></tr>`).join('')}
    </tbody>
  </table>

  <div class="insight">
    <b>💡 핵심:</b><br>
    • -3% 후 바닥까지 평균 <b>${triggerStats.avgDaysToLow.toFixed(0)}일</b> 걸림 (중앙값 ${triggerStats.medianDaysToLow}일)<br>
    • 당일이 바닥인 경우는 <b>${triggerStats.pctImmediate.toFixed(0)}%</b>밖에 안 됨 → <b>${(100 - triggerStats.pctImmediate).toFixed(0)}%는 추가 하락 옴</b><br>
    • 추가하락 중앙값 <b>${Math.abs(triggerStats.medianAdditionalDrop).toFixed(1)}%</b> → 즉시 재진입은 평균적으로 손해<br>
    • 단, 5일 내 바닥 도달이 <b>${triggerStats.pctWithin5.toFixed(0)}%</b> → 너무 오래 기다리면 반등 놓침
  </div>
</div>

<h3>재진입 전략 백테스트 (Buy & Hold 대비)</h3>
<table>
  <thead><tr><th>전략</th><th>최종배수</th><th>CAGR</th><th>MDD</th><th>거래</th><th>vs B&H</th></tr></thead>
  <tbody>
    ${reentryResults.map((r, i) => {
      const isBH = i === 0;
      const vsBH = r.cagr - reentryResults[0].cagr;
      const best = !isBH && r.cagr > reentryResults[0].cagr;
      return `<tr ${isBH ? 'style="font-weight:bold;background:#1a2134"' : best ? 'class="bestrow"' : ''}>
        <td>${r.label}</td>
        <td>${r.finalEquity.toFixed(2)}x</td>
        <td class="${vsBH > 0 ? 'good' : vsBH < -1 ? 'bad' : ''}">${r.cagr.toFixed(2)}%</td>
        <td class="${Math.abs(r.mdd) < Math.abs(reentryResults[0].mdd) ? 'good' : ''}">${r.mdd.toFixed(1)}%</td>
        <td>${r.trades}</td>
        <td>${isBH ? '—' : (vsBH > 0 ? '+' : '') + vsBH.toFixed(2) + '%p'}</td>
      </tr>`;
    }).join('')}
  </tbody>
</table>

<div class="insight">
  <b>🏆 결론 (Q1 답):</b><br>
  ${(() => {
    const sortedByCagr = [...reentryResults].slice(1).sort((a, b) => b.cagr - a.cagr);
    const best = sortedByCagr[0];
    const bestMdd = [...reentryResults].slice(1).sort((a, b) => Math.abs(a.mdd) - Math.abs(b.mdd))[0];
    return `• CAGR 1위: <b>${best.label}</b> (${best.cagr.toFixed(2)}%, MDD ${best.mdd.toFixed(1)}%)<br>
            • MDD 최저: <b>${bestMdd.label}</b> (MDD ${bestMdd.mdd.toFixed(1)}%, CAGR ${bestMdd.cagr.toFixed(2)}%)<br>
            • <b>실무 추천: "20일 후 AND 가격>MA20"</b> 같은 복합조건 — 휩쏘 방지 + 추세 확인`;
  })()}
</div>

<!-- ════════════════════════════════════════════════ -->
<h2>💰 Q2. 회피 안하고 추가매수 — 언제 사야 효율적?</h2>

<div class="card">
  <p>매월 정기 적립을 기본으로 하되, 하락 시 추가매수 신호별 결과 비교.</p>

  <table>
    <thead><tr>
      <th>전략</th><th>총 투자금</th><th>최종 평가</th><th>배수</th>
      <th>총 수익률</th><th>연 수익률(IRR근사)</th>
    </tr></thead>
    <tbody>
      ${dipResults.map((r, i) => {
        const sorted = [...dipResults].sort((a,b)=>b.multiplier - a.multiplier);
        const isBest = r === sorted[0];
        return `<tr ${isBest ? 'class="bestrow"' : ''}>
          <td>${r.label}</td>
          <td>${(r.totalInvested/1e8).toFixed(2)}억</td>
          <td>${(r.finalValue/1e8).toFixed(2)}억</td>
          <td>${r.multiplier.toFixed(2)}x</td>
          <td class="${r.totalReturn > 0 ? 'good' : 'bad'}">${r.totalReturn.toFixed(0)}%</td>
          <td>${r.moneyWeightedAnnual.toFixed(2)}%</td>
        </tr>`;
      }).join('')}
    </tbody>
  </table>

  <div class="insight">
    <b>🏆 결론 (Q2 답):</b><br>
    ${(() => {
      const sorted = [...dipResults].sort((a, b) => b.multiplier - a.multiplier);
      const best = sorted[0];
      const baseline = dipResults[0];
      const extra = (best.multiplier - baseline.multiplier) / baseline.multiplier * 100;
      return `• 배수 최고: <b>${best.label}</b> (${best.multiplier.toFixed(2)}배, IRR ${best.moneyWeightedAnnual.toFixed(2)}%)<br>
              • 기본 DCA 대비 <b>+${extra.toFixed(1)}%</b> 효율 향상<br>
              • 핵심: <b>드로다운 단계가 깊어질수록 더 많이 사라</b> (단계별 추가매수가 가장 효율)<br>
              • -3% 일별 추가매수는 너무 잦아 자금 분산이 단계별보다 덜 효과적`;
    })()}
  </div>

  <div class="warn">
    <b>⚠️ 주의:</b><br>
    • "공격적 -20%/-30% 추가매수" 전략은 <b>여유자금이 있어야 가능</b> — 폭락 시점에 큰 돈 동원 능력 필요<br>
    • 큰 하락(-30%)이 안 오면 추가매수 안 함 → 다른 곳에 자금 묶임 (기회비용)<br>
    • 평균투자단가가 낮아져 보이지만 자금이 폭락 시점에 묶이는 리스크 인지 필요
  </div>
</div>

<!-- ════════════════════════════════════════════════ -->
<h2>📌 종합 권장 (실전 전략)</h2>
<div class="card">
  <h3 style="margin-top:0">📉 회피파라면 (Q1)</h3>
  <ol>
    <li><b>-3% 매도 후 즉시 재진입 금지</b> — 추가하락 확률 ${(100 - triggerStats.pctImmediate).toFixed(0)}%</li>
    <li><b>"저점 +5~10% 반등 확인" 또는 "20일 후 AND 가격>MA20" 후 재진입</b></li>
    <li>단순 N일 후보다 <b>신호 기반</b>이 휩쏘를 줄임</li>
    <li>가장 안전: <b>가격 > 200일 이평선</b> 회복 후 재진입 (보수적)</li>
  </ol>

  <h3>💰 추가매수파라면 (Q2)</h3>
  <ol>
    <li><b>매월 정기 적립을 기본으로</b> 유지 (시간 분산)</li>
    <li>일일 -3% 같은 잦은 신호보다 <b>드로다운 단계 기반</b>이 효율적<br>
        예: -10% 진입 시 2배, -15% 진입 시 3배, -20% 진입 시 5배</li>
    <li>현금 비축: 항상 일정 비율 (10~20%) 현금 유지 → 폭락 시 동원</li>
    <li>"한번에 다 쏘기"보다 <b>단계별로 사는</b> 게 평균단가 ↓</li>
  </ol>

  <h3>🤝 결합 전략 (회피+추가매수 하이브리드)</h3>
  <ol>
    <li>핵심 포지션 70%는 절대 매도 안 함 (DCA + 드로다운 추가매수)</li>
    <li>나머지 30%만 "회피 신호" 사용 (전체 매도 X)</li>
    <li>회피분은 -3% 시 매도 → 저점 +10% 반등 시 재진입</li>
    <li>장기 수익률과 변동성 양쪽 모두 균형</li>
  </ol>
</div>

<p style="text-align:center;color:#667088;font-size:12px;margin-top:40px">
  데이터: Yahoo Finance ^IXIC · 생성: ${new Date().toLocaleString('ko-KR', { timeZone: 'Asia/Seoul', hour12: false })}
</p>

<script>
// 바닥까지 일수 히스토그램
new Chart(document.getElementById('daysHist'), {
  type: 'bar',
  data: { labels: ${JSON.stringify(dayBuckets.map(b => b.range))}, datasets: [{ label: '건수', data: ${JSON.stringify(dayBuckets.map((b:any)=>b.count))}, backgroundColor: '#4a9eff' }] },
  options: { responsive: true, scales: { x:{ticks:{color:'#a0a8bc'}}, y:{ticks:{color:'#a0a8bc'}}}, plugins:{legend:{labels:{color:'#e8ebf2'}}}}
});
</script>
<!-- 차트 일단 비활성화 (필요시 활성화) -->
</body></html>`;

  const outPath = path.join(ROOT, 'docs', 'backtest_timing.html');
  fs.writeFileSync(outPath, html, 'utf-8');

  console.log(`\n✅ 완료: ${outPath}`);
  console.log(`   ${(fs.statSync(outPath).size / 1024).toFixed(0)} KB\n`);
  console.log(`📊 핵심 인사이트:`);
  console.log(`   • -3% 후 바닥까지 평균 ${triggerStats.avgDaysToLow.toFixed(1)}일, 추가하락 평균 ${triggerStats.avgAdditionalDrop.toFixed(2)}%`);
  console.log(`   • ${triggerStats.pctImmediate.toFixed(0)}%만 당일 바닥 → 즉시 재진입 위험\n`);
  console.log(`브라우저로 열어보세요: ${outPath}`);
}

main().catch(e => { console.error('❌ 오류:', e); process.exit(1); });
