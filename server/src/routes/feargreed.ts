import { Router } from 'express';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
const router = Router();

const CNN_URL = 'https://production.dataviz.cnn.io/index/fearandgreed/graphdata';
const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
  'Referer': 'https://edition.cnn.com/markets/fear-and-greed',
};

const CSV_PATH = join(process.cwd(), '..', 'data', 'fear_greed_history.csv');
const VIX_CSV_PATH = join(process.cwd(), '..', 'data', 'vix_history.csv');

// CSV 읽기 (F&G + SPX)
const _sourceMap = new Map<string, string>();
const _spxCloseMap = new Map<string, number>();
const _spxReturnMap = new Map<string, number>();

function loadCsv(): Map<string, number> {
  const map = new Map<string, number>();
  if (!existsSync(CSV_PATH)) return map;
  const lines = readFileSync(CSV_PATH, 'utf-8').trim().split('\n').slice(1);
  for (const line of lines) {
    const [rawDate, val, source, spxClose, spxReturn] = line.split(',');
    const date = rawDate ? rawDate.replace(/\//g, '-') : rawDate;
    const v = parseFloat(val);
    if (date && !isNaN(v)) {
      map.set(date, v);
      if (source) _sourceMap.set(date, source);
    }
    if (date && spxClose) { const sc = parseFloat(spxClose); if (!isNaN(sc)) _spxCloseMap.set(date, sc); }
    if (date && spxReturn) { const sr = parseFloat(spxReturn); if (!isNaN(sr)) _spxReturnMap.set(date, sr); }
  }
  return map;
}

// CSV 저장 (모든 컬럼 보존)
function saveCsv(map: Map<string, number>) {
  const allDates = new Set([...map.keys(), ..._spxCloseMap.keys()]);
  const sorted = [...allDates].sort();
  let csv = 'Date,FearGreedIndex,Source,SPX_Close,SPX_DailyReturn\n';
  for (const date of sorted) {
    const fgVal = map.get(date) ?? '';
    const source = _sourceMap.get(date) || (fgVal !== '' ? 'cnn_api_live' : '');
    const spxClose = _spxCloseMap.get(date) ?? '';
    const spxReturn = _spxReturnMap.get(date) ?? '';
    csv += `${date.replace(/-/g, '/')},${fgVal},${source},${spxClose},${spxReturn}\n`;
  }
  try {
    writeFileSync(CSV_PATH, csv);
  } catch (e) {
    console.error('Failed to save F&G CSV:', (e as any).message);
  }
}

// ── VIX CSV 로드 (vix_history.csv 공유) ──────────────────────────────────────
function loadVixCsv(): Map<string, number> {
  const map = new Map<string, number>();
  if (!existsSync(VIX_CSV_PATH)) return map;
  const lines = readFileSync(VIX_CSV_PATH, 'utf-8').trim().split('\n').slice(1);
  for (const line of lines) {
    const [rawDate, vixStr] = line.split(',');
    const date = rawDate ? rawDate.replace(/\//g, '-') : rawDate;
    const vix = parseFloat(vixStr);
    if (date && !isNaN(vix) && vix > 0) map.set(date, vix);
  }
  return map;
}

// ── F&G 구간별 인터랙티브 백테스트 ──────────────────────────────────────────
function buildCompositeBacktest(
  fgHistory: { date: string; value: number }[],
  spxData:   { date: string; close: number }[]
) {
  const spxMap = new Map(spxData.map(d => [d.date, d.close]));
  const fg = fgHistory.filter(d => d.date >= '2011-01-03');

  interface MergedRow { date: string; fg: number; spx: number; }
  const merged: MergedRow[] = fg.map(d => ({
    date: d.date,
    fg:   d.value,
    spx:  spxMap.get(d.date) ?? 0,
  })).filter(d => d.spx > 0);

  const periods = [10, 20, 60, 120, 252];

  const strategies = [
    { key: 'fg10', label: 'F&G ≤ 10', fgMax: 10 },
    { key: 'fg15', label: 'F&G ≤ 15', fgMax: 15 },
    { key: 'fg20', label: 'F&G ≤ 20', fgMax: 20 },
    { key: 'fg25', label: 'F&G ≤ 25', fgMax: 25 },
    { key: 'fg30', label: 'F&G ≤ 30', fgMax: 30 },
    { key: 'fg35', label: 'F&G ≤ 35', fgMax: 35 },
  ];

  function calcStats(rets: number[]) {
    if (rets.length === 0) return null;
    const avg = rets.reduce((a, b) => a + b, 0) / rets.length;
    const win = rets.filter(r => r > 0).length;
    const sorted = [...rets].sort((a, b) => a - b);
    const m = Math.floor(sorted.length / 2);
    const median = sorted.length % 2 ? sorted[m] : (sorted[m - 1] + sorted[m]) / 2;
    return {
      avg:     Math.round(avg    * 100) / 100,
      median:  Math.round(median * 100) / 100,
      winRate: Math.round(win / rets.length * 1000) / 10,
      minRet:  Math.round(sorted[0] * 100) / 100,
      maxRet:  Math.round(sorted[sorted.length - 1] * 100) / 100,
      n:       rets.length,
    };
  }

  // 전략별 성과
  const results = strategies.map(strat => {
    const row: any = { key: strat.key, label: strat.label, fgMax: strat.fgMax };
    periods.forEach(n => {
      const rets: number[] = [];
      for (let i = 0; i < merged.length - n; i++) {
        if (merged[i].fg <= strat.fgMax) {
          rets.push((merged[i + n].spx / merged[i].spx - 1) * 100);
        }
      }
      row['d' + n] = calcStats(rets);
    });
    return row;
  });

  // Buy & Hold 벤치마크
  const bh: any = { key: 'buyhold', label: 'Buy & Hold', fgMax: 999 };
  periods.forEach(n => {
    const rets: number[] = [];
    for (let i = 0; i < merged.length - n; i++) {
      rets.push((merged[i + n].spx / merged[i].spx - 1) * 100);
    }
    bh['d' + n] = calcStats(rets);
  });
  results.push(bh);

  const latest = merged[merged.length - 1];
  const activeSignals = latest
    ? strategies.filter(s => latest.fg <= s.fgMax).map(s => s.key)
    : [];

  return {
    strategies: results,
    periods,
    activeSignals,
    currentFg:   latest?.fg ?? null,
    dataRange:   merged.length > 0 ? `${merged[0].date} ~ ${merged[merged.length - 1].date}` : '',
    totalMerged: merged.length,
    // 클라이언트 인터랙티브 계산용 raw 데이터
    raw:       merged.map(r => ({ d: r.date, f: Math.round(r.fg * 10) / 10, s: Math.round(r.spx * 100) / 100 })),
    stratDefs: strategies.map(s => ({ key: s.key, label: s.label, fgMax: s.fgMax })),
  };
}

function buildAnalysis(history: any[], spxData: any[], currentScore: number) {
  const fg = history.filter((d: any) => d.date >= '2011-01-03');
  const spxMap = new Map(spxData.map((d: any) => [d.date, d]));

  // Merge F&G with SPX
  const merged = fg.map((d: any) => {
    const spx = spxMap.get(d.date);
    return { date: d.date, fg: d.value, spxClose: spx?.close, spxRet: spx?.dailyReturn };
  }).filter((d: any) => d.spxClose);

  // 1. 구간별 분포
  const distribution = [
    { label: 'Extreme Fear', range: '0-25', count: 0 },
    { label: 'Fear', range: '25-45', count: 0 },
    { label: 'Neutral', range: '45-55', count: 0 },
    { label: 'Greed', range: '55-75', count: 0 },
    { label: 'Extreme Greed', range: '75-100', count: 0 },
  ];
  fg.forEach((d: any) => {
    if (d.value <= 25) distribution[0].count++;
    else if (d.value <= 45) distribution[1].count++;
    else if (d.value <= 55) distribution[2].count++;
    else if (d.value <= 75) distribution[3].count++;
    else distribution[4].count++;
  });
  const total = fg.length;
  distribution.forEach(d => (d as any).pct = total > 0 ? Math.round(d.count / total * 1000) / 10 : 0);

  // 2. 백테스트: 구간별 매수 → N일 후 수익률
  const backtestPeriods = [5, 10, 20, 60, 120, 252];
  const backtestZones = [
    { label: '0-5', min: 0, max: 5, group: 'Extreme Fear' },
    { label: '5-10', min: 5, max: 10, group: 'Extreme Fear' },
    { label: '10-15', min: 10, max: 15, group: 'Extreme Fear' },
    { label: '15-20', min: 15, max: 20, group: 'Extreme Fear' },
    { label: '20-25', min: 20, max: 25, group: 'Extreme Fear' },
    { label: '25-35', min: 25, max: 35, group: 'Fear' },
    { label: '35-45', min: 35, max: 45, group: 'Fear' },
    { label: '45-55', min: 45, max: 55, group: 'Neutral' },
    { label: '55-65', min: 55, max: 65, group: 'Greed' },
    { label: '65-75', min: 65, max: 75, group: 'Greed' },
    { label: '75-85', min: 75, max: 85, group: 'Extreme Greed' },
    { label: '85-100', min: 85, max: 100, group: 'Extreme Greed' },
  ];

  const backtest: any[] = [];
  backtestZones.forEach(zone => {
    const row: any = { zone: zone.label, group: zone.group };
    backtestPeriods.forEach(n => {
      const results: number[] = [];
      for (let i = 0; i < merged.length - n; i++) {
        if (merged[i].fg >= zone.min && merged[i].fg < (zone.max === 100 ? 101 : zone.max)) {
          const ret = ((merged[i + n].spxClose - merged[i].spxClose) / merged[i].spxClose) * 100;
          results.push(ret);
        }
      }
      if (results.length > 0) {
        const avg = results.reduce((a, b) => a + b, 0) / results.length;
        const win = results.filter(r => r > 0).length;
        row['d' + n] = { avg: Math.round(avg * 100) / 100, winRate: Math.round(win / results.length * 1000) / 10, n: results.length };
      } else {
        row['d' + n] = null;
      }
    });
    backtest.push(row);
  });

  // 3. 현재 퍼센타일
  const below = fg.filter((d: any) => d.value <= currentScore).length;
  const percentile = total > 0 ? Math.round(below / total * 1000) / 10 : 0;

  // 3-1. EF 탈출 후 → EF 재도달 / EG 신규도달 확률
  // EF(≤25) → >25 전환 시점을 찾아, 그 이후 ≤25 재도달 및 ≥75 도달 일수 측정
  const efExitIndices: number[] = [];
  for (let i = 1; i < fg.length; i++) {
    if (fg[i - 1].value <= 25 && fg[i].value > 25) {
      efExitIndices.push(i);
    }
  }
  const daysToEF: number[] = [];
  const daysToGreed: number[] = [];
  for (const idx of efExitIndices) {
    // → ≤25 재도달
    for (let j = idx + 1; j < fg.length; j++) {
      if (fg[j].value <= 25) { daysToEF.push(j - idx); break; }
    }
    // → ≥75 도달
    for (let j = idx + 1; j < fg.length; j++) {
      if (fg[j].value >= 75) { daysToGreed.push(j - idx); break; }
    }
  }
  const totalExits = efExitIndices.length;
  const median = (arr: number[]) => { const s = [...arr].sort((a,b)=>a-b); const m=Math.floor(s.length/2); return s.length>0?(s.length%2?s[m]:Math.round((s[m-1]+s[m])/2)):null; };
  const avg = (arr: number[]) => arr.length > 0 ? Math.round(arr.reduce((a,b)=>a+b,0)/arr.length) : null;
  // 기간별 도달 확률 (30/60/90일 이내)
  const freqPeriods = [30, 60, 90];
  const efFreq: Record<string, number> = {};
  const greedFreq: Record<string, number> = {};
  for (const p of freqPeriods) {
    efFreq['d' + p] = totalExits > 0 ? Math.round(daysToEF.filter(d => d <= p).length / totalExits * 1000) / 10 : 0;
    greedFreq['d' + p] = totalExits > 0 ? Math.round(daysToGreed.filter(d => d <= p).length / totalExits * 1000) / 10 : 0;
  }
  const forecast = {
    totalExits,
    toEF25: { avg: avg(daysToEF), median: median(daysToEF), n: daysToEF.length, freq: efFreq },
    toGreed75: { avg: avg(daysToGreed), median: median(daysToGreed), n: daysToGreed.length, freq: greedFreq },
  };

  // 4. (히트맵 삭제됨 — 백테스트로 통합)

  // 5. Extreme Fear 에피소드 분석
  // 직전 SPX 고점 찾기 헬퍼: 에피소드 시작 전 전체 기간 최고점
  function findPriorSpxPeak(startIdx: number) {
    let peakVal = 0, peakDate = '';
    for (let j = 0; j < startIdx; j++) {
      if (merged[j].spxClose > peakVal) {
        peakVal = merged[j].spxClose;
        peakDate = merged[j].date;
      }
    }
    return { peakVal, peakDate };
  }

  const episodes: any[] = [];
  let ep: any = null;
  for (let i = 0; i < merged.length; i++) {
    const d = merged[i];
    if (d.fg <= 25) {
      if (!ep) {
        const peak = findPriorSpxPeak(i);
        ep = { startDate: d.date, startIdx: i, startFg: d.fg, minFg: d.fg, minFgDate: d.date,
          spxPeak: peak.peakVal, spxPeakDate: peak.peakDate,
          spxMin: d.spxClose, spxMinDate: d.date, days: [] };
      }
      if (d.fg < ep.minFg) { ep.minFg = d.fg; ep.minFgDate = d.date; }
      if (d.spxClose < ep.spxMin) { ep.spxMin = d.spxClose; ep.spxMinDate = d.date; }
      ep.days.push(d);
    } else {
      if (ep) {
        const last = ep.days[ep.days.length - 1];
        ep.endDate = last.date;
        ep.duration = ep.days.length;
        ep.maxDrawdown = ep.spxPeak > 0 ? Math.round((ep.spxMin / ep.spxPeak - 1) * 10000) / 100 : 0;
        // 저점까지 소요일
        const fgMinI = ep.days.findIndex((dd: any) => dd.date === ep.minFgDate);
        const spxMinI = ep.days.findIndex((dd: any) => dd.date === ep.spxMinDate);
        ep.daysToFgMin = fgMinI >= 0 ? fgMinI : null;
        ep.daysToSpxMin = spxMinI >= 0 ? spxMinI : null;
        ep.fgSpxGap = (fgMinI >= 0 && spxMinI >= 0) ? fgMinI - spxMinI : null;
        // 진입일 → F&G 75 이상 도달까지
        const startSpx = merged[ep.startIdx].spxClose;
        for (let k = ep.startIdx + 1; k < merged.length; k++) {
          if (merged[k].fg >= 75) {
            ep.entryToGreedDays = k - ep.startIdx;
            ep.entryToGreedDate = merged[k].date;
            ep.entryToGreedReturn = Math.round((merged[k].spxClose / startSpx - 1) * 10000) / 100;
            break;
          }
        }
        // F&G 저점일 → F&G 75 이상 도달까지
        const minIdx = merged.findIndex(m => m.date === ep.spxMinDate);
        const fgMinIdx = merged.findIndex(m => m.date === ep.minFgDate);
        const bottomIdx = Math.max(minIdx, fgMinIdx); // F&G 저점 기준
        if (bottomIdx >= 0) {
          const bottomSpx = merged[fgMinIdx >= 0 ? fgMinIdx : bottomIdx].spxClose;
          for (let k = (fgMinIdx >= 0 ? fgMinIdx : bottomIdx) + 1; k < merged.length; k++) {
            if (merged[k].fg >= 75) {
              ep.bottomToGreedDays = k - (fgMinIdx >= 0 ? fgMinIdx : bottomIdx);
              ep.bottomToGreedDate = merged[k].date;
              ep.bottomToGreedReturn = Math.round((merged[k].spxClose / bottomSpx - 1) * 10000) / 100;
              break;
            }
          }
        }
        ep.minFg = Math.round(ep.minFg * 10) / 10;
        ep.spxMin = Math.round(ep.spxMin * 100) / 100;
        ep.spxPeak = Math.round(ep.spxPeak * 100) / 100;
        delete ep.days; delete ep.startIdx;
        episodes.push(ep);
        ep = null;
      }
    }
  }
  // 마지막 진행 중인 에피소드
  if (ep) {
    ep.endDate = null;
    ep.duration = ep.days.length;
    ep.maxDrawdown = ep.spxPeak > 0 ? Math.round((ep.spxMin / ep.spxPeak - 1) * 10000) / 100 : 0;
    const fgMinI2 = ep.days.findIndex((dd: any) => dd.date === ep.minFgDate);
    const spxMinI2 = ep.days.findIndex((dd: any) => dd.date === ep.spxMinDate);
    ep.daysToFgMin = fgMinI2 >= 0 ? fgMinI2 : null;
    ep.daysToSpxMin = spxMinI2 >= 0 ? spxMinI2 : null;
    ep.fgSpxGap = (fgMinI2 >= 0 && spxMinI2 >= 0) ? fgMinI2 - spxMinI2 : null;
    ep.minFg = Math.round(ep.minFg * 10) / 10;
    ep.spxMin = Math.round(ep.spxMin * 100) / 100;
    ep.spxPeak = Math.round(ep.spxPeak * 100) / 100;
    ep.ongoing = true;
    delete ep.days; delete ep.startIdx;
    episodes.push(ep);
  }

  // 에피소드 요약 통계
  const completedEps = episodes.filter(e => !e.ongoing);
  const epSummary = {
    totalEpisodes: episodes.length,
    avgDuration: completedEps.length > 0 ? Math.round(completedEps.reduce((s, e) => s + e.duration, 0) / completedEps.length * 10) / 10 : 0,
    maxDuration: completedEps.length > 0 ? Math.max(...completedEps.map(e => e.duration)) : 0,
    medianDuration: (() => { const sorted = completedEps.map(e => e.duration).sort((a,b) => a-b); const m = Math.floor(sorted.length/2); return sorted.length > 0 ? (sorted.length%2 ? sorted[m] : (sorted[m-1]+sorted[m])/2) : 0; })(),
    avgMinFg: completedEps.length > 0 ? Math.round(completedEps.reduce((s, e) => s + e.minFg, 0) / completedEps.length * 10) / 10 : 0,
    avgMaxDrawdown: completedEps.length > 0 ? Math.round(completedEps.reduce((s, e) => s + e.maxDrawdown, 0) / completedEps.length * 100) / 100 : 0,
    avgEntryToGreedDays: (() => { const e2g = completedEps.filter(e => e.entryToGreedDays != null); return e2g.length > 0 ? Math.round(e2g.reduce((s,e) => s + e.entryToGreedDays, 0) / e2g.length) : null; })(),
    avgEntryToGreedReturn: (() => { const e2g = completedEps.filter(e => e.entryToGreedReturn != null); return e2g.length > 0 ? Math.round(e2g.reduce((s,e) => s + e.entryToGreedReturn, 0) / e2g.length * 100) / 100 : null; })(),
    avgBottomToGreedDays: (() => { const b2g = completedEps.filter(e => e.bottomToGreedDays != null); return b2g.length > 0 ? Math.round(b2g.reduce((s,e) => s + e.bottomToGreedDays, 0) / b2g.length) : null; })(),
    avgBottomToGreedReturn: (() => { const b2g = completedEps.filter(e => e.bottomToGreedReturn != null); return b2g.length > 0 ? Math.round(b2g.reduce((s,e) => s + e.bottomToGreedReturn, 0) / b2g.length * 100) / 100 : null; })(),
    avgDaysToFgMin: (() => { const d = completedEps.filter(e => e.daysToFgMin != null); return d.length > 0 ? Math.round(d.reduce((s,e) => s + e.daysToFgMin, 0) / d.length * 10) / 10 : null; })(),
    avgDaysToSpxMin: (() => { const d = completedEps.filter(e => e.daysToSpxMin != null); return d.length > 0 ? Math.round(d.reduce((s,e) => s + e.daysToSpxMin, 0) / d.length * 10) / 10 : null; })(),
    avgFgSpxGap: (() => { const d = completedEps.filter(e => e.fgSpxGap != null); return d.length > 0 ? Math.round(d.reduce((s,e) => s + e.fgSpxGap, 0) / d.length * 10) / 10 : null; })(),
  };

  // 6. 저점 확률 계산 (현재 EF 구간일 때)
  let bottomProb: any = null;
  const ongoingEp = episodes.find(e => e.ongoing);
  if (currentScore <= 25 && ongoingEp) {
    const dayN = ongoingEp.duration; // 현재 경과일
    const curMinFg = ongoingEp.minFg; // 현재까지 에피소드 내 F&G 최저
    // 최근 F&G 값들로 반등일수 계산
    const recentFg = fg.slice(-5).map((d: any) => d.value);
    let reboundDays = 0;
    for (let r = recentFg.length - 1; r >= 1; r--) {
      if (recentFg[r] > recentFg[r - 1]) reboundDays++;
      else break;
    }

    // 방법1: 단순 하한 빈도 - 과거 에피소드 중 저점이 currentScore 이상인 비율
    const m1count = completedEps.filter(e => e.minFg >= currentScore).length;
    const m1 = completedEps.length > 0 ? Math.round(m1count / completedEps.length * 1000) / 10 : 0;

    // 방법2: 경과일수 조건부 - N일 이상 지속 에피소드 중 저점이 N일차 이내
    const epsLonger = completedEps.filter(e => e.duration >= dayN);
    const m2count = epsLonger.filter(e => e.daysToFgMin != null && e.daysToFgMin < dayN).length;
    const m2 = epsLonger.length > 0 ? Math.round(m2count / epsLonger.length * 1000) / 10 : 0;

    // 방법3: 값+경과일 결합 - 저점이 currentScore 이상 AND 저점이 N일차 이내
    const m3count = epsLonger.filter(e => e.minFg >= currentScore && e.daysToFgMin != null && e.daysToFgMin < dayN).length;
    const m3 = epsLonger.length > 0 ? Math.round(m3count / epsLonger.length * 1000) / 10 : 0;

    // 방법4: 반등 기반 - 연속 반등일수별 저점 통과 확률
    // 과거 에피소드에서 N일 연속 반등 후 더 내려간 비율 계산
    let m4 = 0;
    if (reboundDays > 0) {
      // 과거 전체 merged에서 EF 구간 내 연속 반등 N일 이상 후 이후 F&G가 더 내려간 경우
      let reboundHits = 0, reboundTotal = 0;
      for (let ri = reboundDays; ri < merged.length; ri++) {
        if (merged[ri].fg > 25) continue;
        let consecutive = 0;
        for (let rr = 0; rr < reboundDays; rr++) {
          if (ri - rr - 1 >= 0 && merged[ri - rr].fg > merged[ri - rr - 1].fg) consecutive++;
          else break;
        }
        if (consecutive >= reboundDays) {
          reboundTotal++;
          // 이후 더 내려가지 않았는지
          let wentLower = false;
          for (let rk = ri + 1; rk < merged.length && merged[rk].fg <= 25; rk++) {
            if (merged[rk].fg < merged[ri].fg) { wentLower = true; break; }
          }
          if (!wentLower) reboundHits++;
        }
      }
      m4 = reboundTotal > 0 ? Math.round(reboundHits / reboundTotal * 1000) / 10 : 0;
    }

    bottomProb = {
      score: currentScore,
      dayN,
      reboundDays,
      curMinFg,
      m1: { prob: m1, n: completedEps.length, hit: m1count, desc: 'F&G ≥ ' + Math.round(currentScore * 10) / 10 + ' 에서 더 이상 하락하지 않을 확률' },
      m2: { prob: m2, n: epsLonger.length, hit: m2count, desc: dayN + '일차 이상 에피소드 중 ' + dayN + '일 이내 저점 형성 확률' },
      m3: { prob: m3, n: epsLonger.length, hit: m3count, desc: dayN + '일차 + F&G ≥ ' + Math.round(currentScore * 10) / 10 + ' 조건 저점 통과 확률' },
      m4: { prob: m4, reboundDays, desc: reboundDays > 0 ? reboundDays + '일 연속 반등 후 더 하락하지 않을 확률' : '반등 시작 전 (측정 불가)' },
    };
  }

  return { distribution, backtest, backtestPeriods, percentile, forecast, episodes, epSummary, bottomProb };
}

let _fgCache: { ts: number; data: any } | null = null;
const FG_CACHE_TTL = 5 * 60 * 1000; // 5 minutes

router.get('/', async (req, res) => {
  try {
    if (_fgCache && Date.now() - _fgCache.ts < FG_CACHE_TTL) {
      return res.json(_fgCache.data);
    }
    // 1. CNN API에서 최신 데이터 가져오기
    const r = await fetch(CNN_URL, { headers: HEADERS });
    if (!r.ok) throw new Error(`CNN API: ${r.status}`);
    const data = await r.json();

    const current = data.fear_and_greed;
    const cnnHistory = (data.fear_and_greed_historical?.data || []).map((p: any) => ({
      date: new Date(p.x).toISOString().split('T')[0],
      value: Math.round(p.y * 100) / 100,
    }));

    // 2. CSV에서 과거 데이터 로드
    const csvMap = loadCsv();
    const beforeCount = csvMap.size;

    // 3. CNN 데이터를 CSV에 머지 (새 날짜만 추가/업데이트)
    for (const { date, value } of cnnHistory) {
      csvMap.set(date, value);
    }

    // 4. 새 데이터가 있으면 CSV 저장 (자동 누적)
    if (csvMap.size > beforeCount) {
      saveCsv(csvMap);
      console.log(`F&G CSV updated: ${beforeCount} → ${csvMap.size} entries`);
    }

    // 5. 전체 히스토리 정렬하여 응답
    const fullHistory = [...csvMap.entries()]
      .map(([date, value]) => ({ date, value }))
      .sort((a, b) => a.date.localeCompare(b.date));

    // 6. S&P 500 데이터 (CSV에서 로드, Yahoo 호출 불필요)
    const spxData = [..._spxCloseMap.entries()]
      .map(([date, close]) => ({ date, close, dailyReturn: _spxReturnMap.get(date) ?? null }))
      .sort((a, b) => a.date.localeCompare(b.date));

    // 7. F&G 구간별 인터랙티브 백테스트
    const composite = buildCompositeBacktest(fullHistory, spxData);

    const payload = {
      current: {
        score: current.score,
        rating: current.rating,
        timestamp: current.timestamp,
        previousClose: current.previous_close,
        previous1Week: current.previous_1_week,
        previous1Month: current.previous_1_month,
        previous1Year: current.previous_1_year,
      },
      history: fullHistory,
      spx: spxData,
      analysis: buildAnalysis(fullHistory, spxData, current.score),
      composite,
      totalDays: fullHistory.length,
      range: fullHistory.length > 0
        ? `${fullHistory[0].date} ~ ${fullHistory[fullHistory.length - 1].date}`
        : null,
    };
    _fgCache = { ts: Date.now(), data: payload };
    res.json(payload);
  } catch (error: any) {
    console.error('Fear & Greed error:', error.message);
    res.status(500).json({ error: 'Failed to fetch Fear & Greed data' });
  }
});

export default router;
