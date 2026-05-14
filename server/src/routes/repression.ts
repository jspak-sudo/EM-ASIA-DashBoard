import { Router, Request, Response } from 'express';
import fs from 'fs';
import { join } from 'path';

const router = Router();

function loadFredKey(): string {
  if (process.env.FRED_API_KEY) return process.env.FRED_API_KEY;
  try {
    const envPath = join(process.cwd(), '..', '.env');
    if (fs.existsSync(envPath)) {
      const match = fs.readFileSync(envPath, 'utf-8').match(/FRED_API_KEY\s*=\s*([A-Za-z0-9]+)/);
      if (match) return match[1];
    }
    const envPath2 = join(process.cwd(), '.env');
    if (fs.existsSync(envPath2)) {
      const match = fs.readFileSync(envPath2, 'utf-8').match(/FRED_API_KEY\s*=\s*([A-Za-z0-9]+)/);
      if (match) return match[1];
    }
  } catch {}
  return '';
}
const FRED_API_KEY = loadFredKey();
const FRED_BASE = 'https://api.stlouisfed.org/fred/series/observations';
const CACHE_DIR = join(process.cwd(), '..', 'data');

interface FredObs { date: string; value: number | null }

// 금융 억압 지표 시리즈
const SERIES = {
  // Tier 1: 실질금리
  fedfunds: { id: 'FEDFUNDS', name: 'Fed Funds Rate', unit: '%', freq: 'Monthly', description: '연준 기준금리 (명목)' },
  dgs10: { id: 'DGS10', name: '10Y Treasury Yield', unit: '%', freq: 'Daily', description: '10년물 국채 수익률 (명목)' },
  cpi: { id: 'CPIAUCSL', name: 'CPI (All Items)', unit: 'Index', freq: 'Monthly', description: '소비자물가지수 — YoY로 인플레이션 계산' },
  tips10: { id: 'DFII10', name: 'TIPS 10Y Real Yield', unit: '%', freq: 'Daily', description: '10년물 실질금리 (시장 가격 반영)' },
  t5yifr: { id: 'T5YIFR', name: '5Y5Y Forward Inflation', unit: '%', freq: 'Daily', description: '5년 후 5년 기대 인플레이션 (시장 기대)' },

  // Tier 2: 정부 부채
  debt_gdp: { id: 'GFDEGDQ188S', name: 'Debt to GDP', unit: '%', freq: 'Quarterly', description: '연방정부 부채 / GDP — 100% 넘으면 억압 유인 증가' },
  interest: { id: 'A091RC1Q027SBEA', name: 'Federal Interest Payments', unit: 'Billions $', freq: 'Quarterly', description: '연방정부 이자 지급액 (연율)' },
  debt_total: { id: 'GFDEBTN', name: 'Total Federal Debt', unit: 'Millions $', freq: 'Quarterly', description: '연방정부 총 부채 잔액' },
  gdp: { id: 'GDP', name: 'Nominal GDP', unit: 'Billions $', freq: 'Quarterly', description: '명목 GDP (이자부담/GDP 계산용)' },

  // Tier 3: Fed 개입 강도
  fedbs: { id: 'WALCL', name: 'Fed Balance Sheet', unit: 'Millions $', freq: 'Weekly', description: '연준 총자산' },
  treast: { id: 'TREAST', name: 'Fed Treasury Holdings', unit: 'Millions $', freq: 'Weekly', description: '연준 보유 미 국채' },

  // Tier 4: 통화 가치
  dxy: { id: 'DTWEXBGS', name: 'Dollar Index (Broad)', unit: 'Index', freq: 'Daily', description: '달러 광역 지수' },

  // NBER 경기침체 지표
  usrec: { id: 'USREC', name: 'NBER Recession', unit: '0/1', freq: 'Monthly', description: '1 = 경기침체' },
};

function cachePath(key: string) { return join(CACHE_DIR, `fred_${key}.json`); }
function loadCache(key: string) {
  try { const fp = cachePath(key); if (fs.existsSync(fp)) return JSON.parse(fs.readFileSync(fp, 'utf-8')); } catch {}
  return null;
}
function saveCache(key: string, data: FredObs[]) {
  try {
    if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });
    fs.writeFileSync(cachePath(key), JSON.stringify({ lastFetch: new Date().toISOString(), data }));
  } catch {}
}

async function fetchFredSeries(seriesId: string): Promise<FredObs[]> {
  if (!FRED_API_KEY) throw new Error('FRED_API_KEY not set');
  const url = `${FRED_BASE}?series_id=${seriesId}&api_key=${FRED_API_KEY}&file_type=json&sort_order=asc`;
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`FRED ${resp.status}`);
  const json = await resp.json();
  if (json.error_code) throw new Error(json.error_message);
  return (json.observations || [])
    .map((o: any) => ({ date: o.date, value: o.value === '.' ? null : parseFloat(o.value) }))
    .filter((o: FredObs) => o.value !== null);
}

async function getYahooGold(): Promise<FredObs[]> {
  const cacheFile = join(CACHE_DIR, 'yahoo_gold.json');
  try {
    if (fs.existsSync(cacheFile)) {
      const cached = JSON.parse(fs.readFileSync(cacheFile, 'utf-8'));
      const age = (Date.now() - new Date(cached.lastFetch).getTime()) / (1000 * 60 * 60);
      if (age < 12 && cached.data?.length > 0) return cached.data;
    }
  } catch {}

  try {
    // Yahoo GC=F (Gold Futures) — 2000년대부터 사용 가능
    const p1 = Math.floor(new Date('2000-01-01').getTime() / 1000);
    const p2 = Math.floor(Date.now() / 1000);
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/GC%3DF?interval=1d&period1=${p1}&period2=${p2}`;
    const resp = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    if (!resp.ok) throw new Error(`Yahoo gold ${resp.status}`);
    const json = await resp.json();
    const result = json.chart?.result?.[0];
    if (!result) return [];
    const timestamps: number[] = result.timestamp || [];
    const closes: (number | null)[] = result.indicators?.quote?.[0]?.close || [];
    const data: FredObs[] = [];
    for (let i = 0; i < timestamps.length; i++) {
      const c = closes[i];
      if (c != null && !isNaN(c)) {
        data.push({ date: new Date(timestamps[i] * 1000).toISOString().split('T')[0], value: Math.round(c * 100) / 100 });
      }
    }
    if (data.length > 0) {
      if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });
      fs.writeFileSync(cacheFile, JSON.stringify({ lastFetch: new Date().toISOString(), data }));
    }
    return data;
  } catch (e: any) {
    console.error('Yahoo gold error:', e.message);
    try { if (fs.existsSync(cacheFile)) return JSON.parse(fs.readFileSync(cacheFile, 'utf-8')).data || []; } catch {}
    return [];
  }
}

async function getSeries(key: string): Promise<FredObs[]> {
  const meta = (SERIES as any)[key];
  if (!meta) return [];
  const cache = loadCache(key);
  const now = Date.now();
  const maxAge = meta.freq === 'Daily' ? 6 : meta.freq === 'Weekly' ? 12 : 24;
  if (cache && cache.data.length > 0) {
    const age = (now - new Date(cache.lastFetch).getTime()) / (1000 * 60 * 60);
    if (age < maxAge) return cache.data;
  }
  try {
    const data = await fetchFredSeries(meta.id);
    if (data.length > 0) saveCache(key, data);
    return data;
  } catch (e: any) {
    console.error(`[Repression] ${key}:`, e.message);
    if (cache?.data?.length > 0) return cache.data;
    return [];
  }
}

// CPI YoY 계산 (인플레이션율)
function computeCpiYoy(cpi: FredObs[]): FredObs[] {
  const result: FredObs[] = [];
  for (let i = 12; i < cpi.length; i++) {
    const prev = cpi[i - 12];
    const curr = cpi[i];
    if (prev.value && curr.value) {
      const yoy = ((curr.value - prev.value) / prev.value) * 100;
      result.push({ date: curr.date, value: Math.round(yoy * 100) / 100 });
    }
  }
  return result;
}

// 두 시리즈 차이 계산 (일별 기준, 월간 데이터는 forward-fill)
function subtractSeries(a: FredObs[], b: FredObs[]): FredObs[] {
  if (!a.length || !b.length) return [];
  const bMap = new Map<string, number>();
  b.forEach(d => { if (d.value != null) bMap.set(d.date, d.value); });

  // b 값을 forward-fill
  const bDates = [...bMap.keys()].sort();
  function getBValue(date: string): number | null {
    // 가장 가까운 과거 b 날짜 찾기
    let lo = 0, hi = bDates.length - 1, found = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (bDates[mid] <= date) { found = mid; lo = mid + 1; } else hi = mid - 1;
    }
    return found >= 0 ? bMap.get(bDates[found])! : null;
  }

  const result: FredObs[] = [];
  for (const pt of a) {
    if (pt.value == null) continue;
    const bv = getBValue(pt.date);
    if (bv != null) {
      result.push({ date: pt.date, value: Math.round((pt.value - bv) * 100) / 100 });
    }
  }
  return result;
}

// 두 시리즈 나눗셈 (비율)
function divideSeries(a: FredObs[], b: FredObs[]): FredObs[] {
  if (!a.length || !b.length) return [];
  const bMap = new Map<string, number>();
  b.forEach(d => { if (d.value != null) bMap.set(d.date, d.value); });
  const bDates = [...bMap.keys()].sort();
  function getBValue(date: string): number | null {
    let lo = 0, hi = bDates.length - 1, found = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (bDates[mid] <= date) { found = mid; lo = mid + 1; } else hi = mid - 1;
    }
    return found >= 0 ? bMap.get(bDates[found])! : null;
  }
  const result: FredObs[] = [];
  for (const pt of a) {
    if (pt.value == null) continue;
    const bv = getBValue(pt.date);
    if (bv != null && bv !== 0) {
      result.push({ date: pt.date, value: Math.round((pt.value / bv) * 10000) / 10000 });
    }
  }
  return result;
}

// 시리즈에 상수 곱하기
function scaleSeries(s: FredObs[], factor: number): FredObs[] {
  return s.map(d => ({ date: d.date, value: d.value! * factor }));
}

router.get('/', async (_req: Request, res: Response) => {
  try {
    if (!FRED_API_KEY) {
      return res.status(500).json({ error: 'FRED_API_KEY not set. Get a free key at https://fred.stlouisfed.org/docs/api/api_key.html' });
    }

    const keys = Object.keys(SERIES) as (keyof typeof SERIES)[];
    const [fredResults, goldData] = await Promise.all([
      Promise.allSettled(keys.map(k => getSeries(k))),
      getYahooGold(),
    ]);
    const raw: Record<string, FredObs[]> = {};
    keys.forEach((k, i) => {
      raw[k] = fredResults[i].status === 'fulfilled' ? (fredResults[i] as any).value : [];
    });

    // === 파생 지표 계산 ===
    // 1. CPI YoY
    const cpiYoy = computeCpiYoy(raw.cpi);

    // 2. 실질 Fed Funds = FEDFUNDS - CPI YoY
    const realFedfunds = subtractSeries(raw.fedfunds, cpiYoy);

    // 3. 실질 10Y (CPI 기준) = DGS10 - CPI YoY
    const real10y = subtractSeries(raw.dgs10, cpiYoy);

    // 4. 부채/GDP (debt_gdp 시리즈는 이미 % — 그대로 사용)
    const debtGdp = raw.debt_gdp;

    // 5. 이자비용/GDP (%) = interest / GDP * 100
    // GFDEBTN은 $M, GDP는 $B - 단위 맞추기: interest(연율 $B) / GDP($B) * 100
    const interestGdpRatio = raw.interest.length && raw.gdp.length
      ? (() => {
        // interest 단위: Billions at annual rate (이미 연율)
        // gdp 단위: Billions
        const ratio = divideSeries(raw.interest, raw.gdp);
        return scaleSeries(ratio, 100); // to %
      })()
      : [];

    // 6. Fed BS / GDP (%) — GDP는 $B, WALCL은 $M
    const fedbsGdp = raw.fedbs.length && raw.gdp.length
      ? (() => {
        // WALCL $M을 $B로 변환
        const fedbsB = scaleSeries(raw.fedbs, 1 / 1000);
        return scaleSeries(divideSeries(fedbsB, raw.gdp), 100);
      })()
      : [];

    // 7. Fed 국채 보유 / 총 국채 발행 (%)
    // treast는 $M, debt_total도 $M
    const fedTreastShare = raw.treast.length && raw.debt_total.length
      ? scaleSeries(divideSeries(raw.treast, raw.debt_total), 100)
      : [];

    // NBER 경기침체 기간
    const recessions: { start: string; end: string }[] = [];
    if (raw.usrec) {
      let inRec = false, recStart = '';
      for (let i = 0; i < raw.usrec.length; i++) {
        const isRec = raw.usrec[i].value === 1;
        if (isRec && !inRec) { inRec = true; recStart = raw.usrec[i].date; }
        else if (!isRec && inRec) { inRec = false; recessions.push({ start: recStart, end: raw.usrec[i - 1].date }); }
      }
      if (inRec) recessions.push({ start: recStart, end: raw.usrec[raw.usrec.length - 1].date });
    }

    res.json({
      recessions,
      // 원본
      series: {
        fedfunds: { meta: SERIES.fedfunds, data: raw.fedfunds, latest: raw.fedfunds[raw.fedfunds.length - 1] },
        dgs10: { meta: SERIES.dgs10, data: raw.dgs10, latest: raw.dgs10[raw.dgs10.length - 1] },
        cpi: { meta: SERIES.cpi, data: raw.cpi, latest: raw.cpi[raw.cpi.length - 1] },
        tips10: { meta: SERIES.tips10, data: raw.tips10, latest: raw.tips10[raw.tips10.length - 1] },
        t5yifr: { meta: SERIES.t5yifr, data: raw.t5yifr, latest: raw.t5yifr[raw.t5yifr.length - 1] },
        debt_gdp: { meta: SERIES.debt_gdp, data: raw.debt_gdp, latest: raw.debt_gdp[raw.debt_gdp.length - 1] },
        dxy: { meta: SERIES.dxy, data: raw.dxy, latest: raw.dxy[raw.dxy.length - 1] },
        gold: { meta: { id: 'GC=F', name: 'Gold Futures (Yahoo)', unit: 'USD/oz', freq: 'Daily', description: 'Yahoo 금 선물' }, data: goldData, latest: goldData[goldData.length - 1] },
      },
      // 계산된 지표
      derived: {
        cpiYoy: { meta: { name: 'CPI YoY Inflation', unit: '%', description: 'CPI 전년동기 대비 상승률 = 인플레이션' }, data: cpiYoy, latest: cpiYoy[cpiYoy.length - 1] },
        realFedfunds: { meta: { name: 'Real Fed Funds Rate', unit: '%', description: '실질 기준금리 = Fed Funds - CPI YoY | 0 미만 = 금융억압' }, data: realFedfunds, latest: realFedfunds[realFedfunds.length - 1] },
        real10y: { meta: { name: 'Real 10Y Yield (CPI)', unit: '%', description: '실질 10년물 = DGS10 - CPI YoY' }, data: real10y, latest: real10y[real10y.length - 1] },
        interestGdp: { meta: { name: 'Interest / GDP', unit: '%', description: '이자비용 / GDP (%)' }, data: interestGdpRatio, latest: interestGdpRatio[interestGdpRatio.length - 1] },
        fedbsGdp: { meta: { name: 'Fed BS / GDP', unit: '%', description: 'Fed Balance Sheet / GDP (%)' }, data: fedbsGdp, latest: fedbsGdp[fedbsGdp.length - 1] },
        fedTreastShare: { meta: { name: 'Fed Treasury Share', unit: '%', description: 'Fed가 보유한 미 국채 비중 (%)' }, data: fedTreastShare, latest: fedTreastShare[fedTreastShare.length - 1] },
      },
    });
  } catch (err: any) {
    console.error('Repression error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

export default router;
