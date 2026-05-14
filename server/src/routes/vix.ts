import { Router } from 'express';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import { getChart } from '../yahooApi.js';

const router = Router();
const CSV_PATH = join(process.cwd(), '..', 'data', 'vix_history.csv');

// ── CSV 읽기/쓰기 ──────────────────────────────────────────────
interface VixRow { date: string; vix: number; spx: number | null; spxReturn: number | null; }

function loadCsv(): VixRow[] {
  if (!existsSync(CSV_PATH)) return [];
  const lines = readFileSync(CSV_PATH, 'utf-8').trim().split('\n').slice(1);
  return lines.map(line => {
    const [rawDate, vixStr, spxStr, retStr] = line.split(',');
    const date = rawDate ? rawDate.replace(/\//g, '-') : rawDate;
    return {
      date,
      vix: parseFloat(vixStr) || 0,
      spx: spxStr ? parseFloat(spxStr) || null : null,
      spxReturn: retStr ? parseFloat(retStr) || null : null,
    };
  }).filter(r => r.date && r.vix > 0);
}

function saveCsv(rows: VixRow[]) {
  const sorted = [...rows].sort((a, b) => a.date.localeCompare(b.date));
  let csv = 'Date,VIX_Close,SPX_Close,SPX_DailyReturn\n';
  for (const r of sorted) {
    csv += `${r.date.replace(/-/g, '/')},${r.vix},${r.spx ?? ''},${r.spxReturn ?? ''}\n`;
  }
  try { writeFileSync(CSV_PATH, csv); } catch (e) { console.error('VIX CSV save error:', (e as any).message); }
}

// ── 분석 ──────────────────────────────────────────────────────
function buildAnalysis(rows: VixRow[], currentVix: number) {
  const data = rows.filter(r => r.spx != null) as (VixRow & { spx: number })[];

  // 1. 구간별 분포
  const distribution = [
    { label: '0-15 (Low)', range: '0-15', count: 0 },
    { label: '15-20 (Normal)', range: '15-20', count: 0 },
    { label: '20-25 (Elevated)', range: '20-25', count: 0 },
    { label: '25-30 (High)', range: '25-30', count: 0 },
    { label: '30-40 (Very High)', range: '30-40', count: 0 },
    { label: '40-50 (Extreme)', range: '40-50', count: 0 },
    { label: '50+ (Crisis)', range: '50+', count: 0 },
  ];
  rows.forEach(r => {
    if (r.vix < 15) distribution[0].count++;
    else if (r.vix < 20) distribution[1].count++;
    else if (r.vix < 25) distribution[2].count++;
    else if (r.vix < 30) distribution[3].count++;
    else if (r.vix < 40) distribution[4].count++;
    else if (r.vix < 50) distribution[5].count++;
    else distribution[6].count++;
  });
  const total = rows.length;
  distribution.forEach(d => (d as any).pct = total > 0 ? Math.round(d.count / total * 1000) / 10 : 0);

  // 2. 백테스트: VIX 구간별 매수 → N일 후 SPX 수익률
  const backtestPeriods = [5, 10, 20, 60, 120, 252];
  const backtestZones = [
    { label: 'VIX 30-40', min: 30, max: 40, group: 'VIX 30+' },
    { label: 'VIX 40-50', min: 40, max: 50, group: 'VIX 40+' },
    { label: 'VIX 50-60', min: 50, max: 60, group: 'VIX 50+' },
    { label: 'VIX 60-70', min: 60, max: 70, group: 'VIX 60+' },
    { label: 'VIX 70-80', min: 70, max: 80, group: 'VIX 70+' },
    { label: 'VIX 80+', min: 80, max: 999, group: 'VIX 80+' },
    { label: 'VIX 20-25', min: 20, max: 25, group: 'Normal' },
    { label: 'VIX 15-20', min: 15, max: 20, group: 'Normal' },
    { label: 'VIX 0-15', min: 0, max: 15, group: 'Low' },
  ];
  const backtest: any[] = [];
  backtestZones.forEach(zone => {
    const row: any = { zone: zone.label, group: zone.group };
    backtestPeriods.forEach(n => {
      const results: number[] = [];
      for (let i = 0; i < data.length - n; i++) {
        if (data[i].vix >= zone.min && data[i].vix < zone.max) {
          const ret = ((data[i + n].spx - data[i].spx) / data[i].spx) * 100;
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

  // 3. 퍼센타일 (높을수록 공포, 상위 X%)
  const above = rows.filter(r => r.vix >= currentVix).length;
  const percentile = total > 0 ? Math.round(above / total * 1000) / 10 : 0;

  // 3-1. VIX Spike 탈출 후 → 재도달/정상화 확률
  const spikeThreshold = 30;
  const normalThreshold = 20;
  const exitIndices: number[] = [];
  for (let i = 1; i < rows.length; i++) {
    if (rows[i - 1].vix >= spikeThreshold && rows[i].vix < spikeThreshold) {
      exitIndices.push(i);
    }
  }
  const daysToRespike: number[] = [];
  const daysToNormal: number[] = [];
  for (const idx of exitIndices) {
    for (let j = idx + 1; j < rows.length; j++) {
      if (rows[j].vix >= spikeThreshold) { daysToRespike.push(j - idx); break; }
    }
    for (let j = idx + 1; j < rows.length; j++) {
      if (rows[j].vix < normalThreshold) { daysToNormal.push(j - idx); break; }
    }
  }
  const totalSpikeExits = exitIndices.length;
  const med = (arr: number[]) => { const s = [...arr].sort((a, b) => a - b); const m = Math.floor(s.length / 2); return s.length > 0 ? (s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2)) : null; };
  const avg = (arr: number[]) => arr.length > 0 ? Math.round(arr.reduce((a, b) => a + b, 0) / arr.length) : null;
  const freqPeriods = [30, 60, 90];
  const respikeFreq: Record<string, number> = {};
  const normalFreq: Record<string, number> = {};
  for (const p of freqPeriods) {
    respikeFreq['d' + p] = totalSpikeExits > 0 ? Math.round(daysToRespike.filter(d => d <= p).length / totalSpikeExits * 1000) / 10 : 0;
    normalFreq['d' + p] = totalSpikeExits > 0 ? Math.round(daysToNormal.filter(d => d <= p).length / totalSpikeExits * 1000) / 10 : 0;
  }
  const forecast = {
    totalSpikeExits,
    toRespike: { avg: avg(daysToRespike), median: med(daysToRespike), n: daysToRespike.length, freq: respikeFreq },
    toNormal: { avg: avg(daysToNormal), median: med(daysToNormal), n: daysToNormal.length, freq: normalFreq },
  };

  // 4. 히트맵: VIX 구간별 60일 SPX 수익률
  const heatmap: any[] = [];
  const heatZones = [0, 10, 15, 20, 25, 30, 40, 50, 60, 80];
  for (let zi = 0; zi < heatZones.length; zi++) {
    const lo = heatZones[zi];
    const hi = zi < heatZones.length - 1 ? heatZones[zi + 1] : 999;
    const results: number[] = [];
    for (let i = 0; i < data.length - 60; i++) {
      if (data[i].vix >= lo && data[i].vix < hi) {
        const ret = ((data[i + 60].spx - data[i].spx) / data[i].spx) * 100;
        results.push(ret);
      }
    }
    if (results.length > 0) {
      const a = results.reduce((s, v) => s + v, 0) / results.length;
      const win = results.filter(r => r > 0).length;
      heatmap.push({ range: hi < 999 ? lo + '-' + hi : lo + '+', avg: Math.round(a * 100) / 100, winRate: Math.round(win / results.length * 1000) / 10, n: results.length });
    }
  }

  // 5. VIX Spike 에피소드 (VIX ≥ 30)
  function findPriorSpxPeak(startIdx: number) {
    let peakVal = 0, peakDate = '';
    for (let j = 0; j < startIdx; j++) {
      if (data[j].spx > peakVal) { peakVal = data[j].spx; peakDate = data[j].date; }
    }
    return { peakVal, peakDate };
  }

  const episodes: any[] = [];
  let ep: any = null;
  for (let i = 0; i < data.length; i++) {
    const d = data[i];
    if (d.vix >= 30) {
      if (!ep) {
        const peak = findPriorSpxPeak(i);
        ep = { startDate: d.date, startIdx: i, maxVix: d.vix, maxVixDate: d.date,
          spxPeak: peak.peakVal, spxPeakDate: peak.peakDate,
          spxMin: d.spx, spxMinDate: d.date, days: [] };
      }
      if (d.vix > ep.maxVix) { ep.maxVix = d.vix; ep.maxVixDate = d.date; }
      if (d.spx < ep.spxMin) { ep.spxMin = d.spx; ep.spxMinDate = d.date; }
      ep.days.push(d);
    } else {
      if (ep) {
        finalizeEpisode(ep, data);
        episodes.push(ep);
        ep = null;
      }
    }
  }
  if (ep) {
    ep.ongoing = true;
    finalizeEpisode(ep, data);
    episodes.push(ep);
  }

  function finalizeEpisode(ep: any, data: any[]) {
    const last = ep.days[ep.days.length - 1];
    if (!ep.ongoing) ep.endDate = last.date;
    ep.duration = ep.days.length;
    ep.maxDrawdown = ep.spxPeak > 0 ? Math.round((ep.spxMin / ep.spxPeak - 1) * 10000) / 100 : 0;
    // VIX 최고점까지 소요일
    const vixMaxI = ep.days.findIndex((dd: any) => dd.date === ep.maxVixDate);
    const spxMinI = ep.days.findIndex((dd: any) => dd.date === ep.spxMinDate);
    ep.daysToVixMax = vixMaxI >= 0 ? vixMaxI : null;
    ep.daysToSpxMin = spxMinI >= 0 ? spxMinI : null;
    ep.vixSpxGap = (vixMaxI >= 0 && spxMinI >= 0) ? vixMaxI - spxMinI : null;
    // 진입 → VIX < 20 정상화
    const startSpx = data[ep.startIdx].spx;
    for (let k = ep.startIdx + 1; k < data.length; k++) {
      if (data[k].vix < 20) {
        ep.entryToNormalDays = k - ep.startIdx;
        ep.entryToNormalDate = data[k].date;
        ep.entryToNormalReturn = Math.round((data[k].spx / startSpx - 1) * 10000) / 100;
        break;
      }
    }
    // VIX 최고점일 → VIX < 20 정상화
    const vixMaxIdx = data.findIndex((m: any) => m.date === ep.maxVixDate);
    if (vixMaxIdx >= 0) {
      const peakSpx = data[vixMaxIdx].spx;
      for (let k = vixMaxIdx + 1; k < data.length; k++) {
        if (data[k].vix < 20) {
          ep.peakToNormalDays = k - vixMaxIdx;
          ep.peakToNormalDate = data[k].date;
          ep.peakToNormalReturn = Math.round((data[k].spx / peakSpx - 1) * 10000) / 100;
          break;
        }
      }
    }
    ep.maxVix = Math.round(ep.maxVix * 100) / 100;
    ep.spxMin = Math.round(ep.spxMin * 100) / 100;
    ep.spxPeak = Math.round(ep.spxPeak * 100) / 100;
    delete ep.days; delete ep.startIdx;
  }

  // 에피소드 요약
  const completedEps = episodes.filter(e => !e.ongoing);
  const epSummary = {
    totalEpisodes: episodes.length,
    avgDuration: completedEps.length > 0 ? Math.round(completedEps.reduce((s, e) => s + e.duration, 0) / completedEps.length * 10) / 10 : 0,
    maxDuration: completedEps.length > 0 ? Math.max(...completedEps.map(e => e.duration)) : 0,
    medianDuration: (() => { const sorted = completedEps.map(e => e.duration).sort((a, b) => a - b); const m = Math.floor(sorted.length / 2); return sorted.length > 0 ? (sorted.length % 2 ? sorted[m] : (sorted[m - 1] + sorted[m]) / 2) : 0; })(),
    avgMaxVix: completedEps.length > 0 ? Math.round(completedEps.reduce((s, e) => s + e.maxVix, 0) / completedEps.length * 10) / 10 : 0,
    avgMaxDrawdown: completedEps.length > 0 ? Math.round(completedEps.reduce((s, e) => s + e.maxDrawdown, 0) / completedEps.length * 100) / 100 : 0,
    avgEntryToNormalDays: (() => { const e2n = completedEps.filter(e => e.entryToNormalDays != null); return e2n.length > 0 ? Math.round(e2n.reduce((s: number, e: any) => s + e.entryToNormalDays, 0) / e2n.length) : null; })(),
    avgEntryToNormalReturn: (() => { const e2n = completedEps.filter(e => e.entryToNormalReturn != null); return e2n.length > 0 ? Math.round(e2n.reduce((s: number, e: any) => s + e.entryToNormalReturn, 0) / e2n.length * 100) / 100 : null; })(),
    avgPeakToNormalDays: (() => { const p2n = completedEps.filter(e => e.peakToNormalDays != null); return p2n.length > 0 ? Math.round(p2n.reduce((s: number, e: any) => s + e.peakToNormalDays, 0) / p2n.length) : null; })(),
    avgPeakToNormalReturn: (() => { const p2n = completedEps.filter(e => e.peakToNormalReturn != null); return p2n.length > 0 ? Math.round(p2n.reduce((s: number, e: any) => s + e.peakToNormalReturn, 0) / p2n.length * 100) / 100 : null; })(),
    avgDaysToVixMax: (() => { const d = completedEps.filter(e => e.daysToVixMax != null); return d.length > 0 ? Math.round(d.reduce((s: number, e: any) => s + e.daysToVixMax, 0) / d.length * 10) / 10 : null; })(),
    avgDaysToSpxMin: (() => { const d = completedEps.filter(e => e.daysToSpxMin != null); return d.length > 0 ? Math.round(d.reduce((s: number, e: any) => s + e.daysToSpxMin, 0) / d.length * 10) / 10 : null; })(),
    avgVixSpxGap: (() => { const d = completedEps.filter(e => e.vixSpxGap != null); return d.length > 0 ? Math.round(d.reduce((s: number, e: any) => s + e.vixSpxGap, 0) / d.length * 10) / 10 : null; })(),
  };

  return { distribution, backtest, backtestPeriods, percentile, forecast, heatmap, episodes, epSummary };
}

// ── API 라우트 ──────────────────────────────────────────────────
let _vixCache: { ts: number; data: any } | null = null;
const VIX_CACHE_TTL = 5 * 60 * 1000; // 5 minutes

router.get('/', async (_req, res) => {
  try {
    if (_vixCache && Date.now() - _vixCache.ts < VIX_CACHE_TTL) {
      return res.json(_vixCache.data);
    }
    // 1. Yahoo Finance에서 VIX + SPX 최대 히스토리 가져오기
    // Yahoo Finance에서 최대 범위로 가져오기 (여러 range 시도)
    let vixChart: any[] = [];
    let spxChart: any[] = [];
    for (const range of ['max', '20y', '10y', '5y']) {
      try {
        const [v, s] = await Promise.all([
          getChart('^VIX', range, '1d'),
          getChart('^GSPC', range, '1d'),
        ]);
        if (v.length > vixChart.length) vixChart = v;
        if (s.length > spxChart.length) spxChart = s;
        if (vixChart.length > 2000) break;
      } catch { continue; }
    }

    // 2. SPX를 날짜 맵으로
    const spxMap = new Map<string, { close: number; ret: number | null }>();
    for (let i = 0; i < spxChart.length; i++) {
      const c = spxChart[i];
      const prev = i > 0 ? spxChart[i - 1].close : null;
      const ret = prev ? Math.round((c.close / prev - 1) * 10000) / 100 : null;
      spxMap.set(c.time, { close: c.close, ret });
    }

    // 3. CSV 로드 및 머지
    const existing = loadCsv();
    const existingMap = new Map(existing.map(r => [r.date, r]));

    for (const v of vixChart) {
      const spx = spxMap.get(v.time);
      const row: VixRow = {
        date: v.time,
        vix: Math.round(v.close * 100) / 100,
        spx: spx ? Math.round(spx.close * 100) / 100 : null,
        spxReturn: spx?.ret ?? null,
      };
      existingMap.set(v.time, row);
    }

    const allRows = [...existingMap.values()].sort((a, b) => a.date.localeCompare(b.date));

    // 4. CSV 저장 (데이터 업데이트되면)
    if (allRows.length > existing.length) {
      saveCsv(allRows);
      console.log(`VIX CSV updated: ${existing.length} → ${allRows.length} entries`);
    }

    // 5. 현재 VIX
    const latest = allRows[allRows.length - 1];
    const prev = allRows.length > 1 ? allRows[allRows.length - 2] : null;
    const current = {
      value: latest.vix,
      date: latest.date,
      change: prev ? Math.round((latest.vix - prev.vix) * 100) / 100 : 0,
      changePercent: prev ? Math.round((latest.vix / prev.vix - 1) * 10000) / 100 : 0,
      spx: latest.spx,
      rating: latest.vix >= 50 ? 'crisis' : latest.vix >= 40 ? 'extreme' : latest.vix >= 30 ? 'very_high' : latest.vix >= 25 ? 'high' : latest.vix >= 20 ? 'elevated' : latest.vix >= 15 ? 'normal' : 'low',
    };

    // 6. 분석
    const analysis = buildAnalysis(allRows, current.value);

    const payload = {
      current,
      history: allRows.map(r => ({ date: r.date, value: r.vix })),
      spx: allRows.filter(r => r.spx != null).map(r => ({ date: r.date, close: r.spx, dailyReturn: r.spxReturn })),
      analysis,
      totalDays: allRows.length,
      range: allRows.length > 0 ? `${allRows[0].date} ~ ${allRows[allRows.length - 1].date}` : null,
    };
    _vixCache = { ts: Date.now(), data: payload };
    res.json(payload);
  } catch (error: any) {
    console.error('VIX error:', error.message);
    res.status(500).json({ error: 'Failed to fetch VIX data' });
  }
});

export default router;
