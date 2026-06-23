import { Router, Request, Response } from 'express';
import fs from 'fs';
import { join } from 'path';
import { getChart } from '../yahooApi.js';

const router = Router();

// FRED API key — set via environment variable FRED_API_KEY or .env file at repo root
function loadFredKey(): string {
  if (process.env.FRED_API_KEY) return process.env.FRED_API_KEY;
  // Try .env file at repo root (one level up from server/)
  try {
    const envPath = join(process.cwd(), '..', '.env');
    if (fs.existsSync(envPath)) {
      const content = fs.readFileSync(envPath, 'utf-8');
      const match = content.match(/FRED_API_KEY\s*=\s*([A-Za-z0-9]+)/);
      if (match) return match[1];
    }
    const envPath2 = join(process.cwd(), '.env');
    if (fs.existsSync(envPath2)) {
      const content = fs.readFileSync(envPath2, 'utf-8');
      const match = content.match(/FRED_API_KEY\s*=\s*([A-Za-z0-9]+)/);
      if (match) return match[1];
    }
  } catch {}
  return '';
}
const FRED_API_KEY = loadFredKey();
const FRED_BASE = 'https://api.stlouisfed.org/fred/series/observations';
const CACHE_DIR = join(process.cwd(), '..', 'data');

// FRED Series definitions
const SERIES: Record<string, { id: string; name: string; unit: string; freq: string; category: string; description: string }> = {
  // Tier 1: Core Liquidity
  fedbs: { id: 'WALCL', name: 'Fed Balance Sheet', unit: 'Millions $', freq: 'Weekly', category: 'core', description: '연준 총자산 — QE↑ QT↓' },
  m2: { id: 'M2SL', name: 'M2 Money Supply', unit: 'Billions $', freq: 'Monthly', category: 'core', description: '시중 유통 화폐 총량' },
  fedfunds: { id: 'FEDFUNDS', name: 'Fed Funds Rate', unit: '%', freq: 'Monthly', category: 'core', description: '기준금리 — 낮으면 유동성↑' },
  iorb: { id: 'IORB', name: 'Interest on Reserve Balances', unit: '%', freq: 'Daily', category: 'core', description: 'Fed가 은행 예치금에 주는 이자 — 코리도 상한' },
  rrprate: { id: 'RRPONTSYAWARD', name: 'ON RRP Rate', unit: '%', freq: 'Daily', category: 'core', description: 'Fed가 RRP 예치금에 주는 이자 — 코리도 하한' },
  rrp: { id: 'RRPONTSYD', name: 'Reverse Repo (RRP)', unit: 'Billions $', freq: 'Daily', category: 'core', description: '역레포 잔고 — ↓이면 시장으로 유동성 유입' },
  tga: { id: 'WTREGEN', name: 'Treasury General Account', unit: 'Millions $', freq: 'Weekly', category: 'core', description: '재무부 현금 잔고 — ↓이면 시장에 돈 풀림' },
  reserves: { id: 'WRESBAL', name: 'Bank Reserves (WRESBAL)', unit: 'Millions $', freq: 'Weekly', category: 'core', description: '은행 시스템 지급준비금 — 시중 유동성의 핵심' },
  // 자산 세부 분해
  treasuries: { id: 'WSHOTSL', name: 'U.S. Treasuries Held', unit: 'Millions $', freq: 'Weekly', category: 'core', description: '연준 보유 미국 국채' },
  mbs: { id: 'WSHOMCB', name: 'MBS Held', unit: 'Millions $', freq: 'Weekly', category: 'core', description: '연준 보유 모기지담보증권(MBS)' },
  // 본원통화 (Monetary Base, 월간 공식값)
  monbase: { id: 'BOGMBASE', name: 'Monetary Base', unit: 'Billions $', freq: 'Monthly', category: 'core', description: '본원통화 — 연준이 직접 공급한 돈 (지급준비금+민간보유현금)' },
  // 국채 만기·유형별 세부
  tre_notesbonds: { id: 'WSHONBNL', name: 'Treasury Notes & Bonds (Nominal)', unit: 'Millions $', freq: 'Weekly', category: 'core', description: '중장기 명목국채(Notes·Bonds)' },
  tre_bills: { id: 'WSHOBL', name: 'Treasury Bills', unit: 'Millions $', freq: 'Weekly', category: 'core', description: '단기국채(Bills, ≤1년)' },
  tre_tips: { id: 'WSHONBIIL', name: 'Treasury TIPS (Inflation-Indexed)', unit: 'Millions $', freq: 'Weekly', category: 'core', description: '물가연동국채(TIPS)' },

  // Tier 2: Credit / Stress
  hyspread: { id: 'BAMLH0A0HYM2', name: 'High Yield Spread', unit: '%', freq: 'Daily', category: 'stress', description: '하이일드 스프레드 — ↑이면 신용경색' },
  stlfsi: { id: 'STLFSI2', name: 'Financial Stress Index', unit: 'Index', freq: 'Weekly', category: 'stress', description: 'St. Louis 금융스트레스 — 0 이상이면 스트레스' },
  t10y2y: { id: 'T10Y2Y', name: '10Y-2Y Spread', unit: '%', freq: 'Daily', category: 'stress', description: '장단기 금리차 — 역전 시 경기침체 신호' },
  t10y3m: { id: 'T10Y3M', name: '10Y-3M Spread', unit: '%', freq: 'Daily', category: 'stress', description: '10년-3개월 금리차' },

  // Rates
  dgs10: { id: 'DGS10', name: '10Y Treasury Yield', unit: '%', freq: 'Daily', category: 'rates', description: '미국 10년물 국채 금리' },
  dgs2: { id: 'DGS2', name: '2Y Treasury Yield', unit: '%', freq: 'Daily', category: 'rates', description: '미국 2년물 국채 금리' },
  real10y: { id: 'DFII10', name: '10Y Real Yield (TIPS)', unit: '%', freq: 'Daily', category: 'rates', description: '10년 실질금리 (TIPS) — 명목금리 − 기대인플레' },
  bei10y: { id: 'T10YIE', name: '10Y Breakeven Inflation', unit: '%', freq: 'Daily', category: 'rates', description: '10년 기대인플레이션 (BEI) — 시장이 본 향후 10년 평균 물가' },

  // Global
  dxy: { id: 'DTWEXBGS', name: 'Dollar Index (Broad)', unit: 'Index', freq: 'Daily', category: 'global', description: '달러 광역 지수 — 강세=글로벌 유동성↓' },
  usdkrw: { id: 'DEXKOUS', name: 'USD/KRW', unit: 'KRW', freq: 'Daily', category: 'global', description: '원/달러 환율 (FRED, 전일 종가 기준)' },

  // Currency in Circulation
  currency: { id: 'WCURCIR', name: 'Currency in Circulation', unit: 'Millions $', freq: 'Weekly', category: 'core', description: '유통 중 현금 — 대중이 보유한 지폐·동전, Fed 부채의 안정적 구성요소' },

  // MMF (Money Market Fund)
  // WRMFNS = 소매 MMF 주간 (Non-Seasonally Adjusted, 활성 시리즈)
  // 기관 MMF 주간 시리즈(WIMFSL/WIMFNS)는 2021-02-01 이후 FRED 미제공 → 소매 단독 표시
  mmf_retail: { id: 'WRMFNS', name: 'MMF Retail (소매)', unit: 'Billions $', freq: 'Weekly', category: 'core', description: '소매 MMF 잔고 (WRMFNS) — 위험회피 심리 반영, 고금리 시 상승' },

  // CPI for Real Fed Funds computation
  cpi: { id: 'CPIAUCSL', name: 'CPI', unit: 'Index', freq: 'Monthly', category: 'reference', description: '소비자물가지수 (YoY로 인플레 계산)' },

  // NBER 경기침체 지표 (음영 표시용)
  usrec: { id: 'USREC', name: 'NBER Recession', unit: '0/1', freq: 'Monthly', category: 'reference', description: '1 = 경기침체 구간' },
};

interface FredObservation {
  date: string;
  value: number | null;
}

// Cache file path
function cachePath(seriesKey: string): string {
  return join(CACHE_DIR, `fred_${seriesKey}.json`);
}

// Load cache
function loadCache(seriesKey: string): { lastFetch: string; data: FredObservation[] } | null {
  try {
    const fp = cachePath(seriesKey);
    if (fs.existsSync(fp)) {
      return JSON.parse(fs.readFileSync(fp, 'utf-8'));
    }
  } catch {}
  return null;
}

// Save cache
function saveCache(seriesKey: string, data: FredObservation[]) {
  try {
    if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });
    fs.writeFileSync(cachePath(seriesKey), JSON.stringify({ lastFetch: new Date().toISOString(), data }));
  } catch (e: any) {
    console.error(`Failed to cache ${seriesKey}:`, e.message);
  }
}

// Fetch from FRED API
async function fetchFredSeries(seriesId: string, limit?: number): Promise<FredObservation[]> {
  if (!FRED_API_KEY) throw new Error('FRED_API_KEY not set');

  const url = `${FRED_BASE}?series_id=${seriesId}&api_key=${FRED_API_KEY}&file_type=json&sort_order=asc${limit ? '&limit=' + limit : ''}`;
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`FRED API error: ${resp.status}`);
  const json = await resp.json();

  if (json.error_code) throw new Error(json.error_message);

  return (json.observations || [])
    .map((o: any) => ({
      date: o.date,
      value: o.value === '.' ? null : parseFloat(o.value),
    }))
    .filter((o: FredObservation) => o.value !== null);
}

// Yahoo S&P 500 장기 시계열 (1950~) + 캐시
// 'max' range는 Yahoo가 집약 데이터를 반환해서 period1/period2 직접 지정
async function getYahooSP500(): Promise<FredObservation[]> {
  const cacheFile = join(CACHE_DIR, 'yahoo_sp500.json');
  try {
    if (fs.existsSync(cacheFile)) {
      const cached = JSON.parse(fs.readFileSync(cacheFile, 'utf-8'));
      const age = (Date.now() - new Date(cached.lastFetch).getTime()) / (1000 * 60 * 60);
      if (age < 12 && cached.data?.length > 0) return cached.data;
    }
  } catch {}

  try {
    // 1950-01-01부터 현재까지 (^GSPC 데이터는 1950~ 완전 제공)
    const p1 = Math.floor(new Date('1950-01-01').getTime() / 1000);
    const p2 = Math.floor(Date.now() / 1000);
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/%5EGSPC?interval=1d&period1=${p1}&period2=${p2}`;
    const resp = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    if (!resp.ok) throw new Error(`Yahoo ^GSPC: ${resp.status}`);
    const json = await resp.json();
    const result = json.chart?.result?.[0];
    if (!result) return [];

    const timestamps: number[] = result.timestamp || [];
    const closes: (number | null)[] = result.indicators?.quote?.[0]?.close || [];

    const data: FredObservation[] = [];
    for (let i = 0; i < timestamps.length; i++) {
      const close = closes[i];
      if (close != null && !isNaN(close)) {
        data.push({
          date: new Date(timestamps[i] * 1000).toISOString().split('T')[0],
          value: Math.round(close * 100) / 100,
        });
      }
    }

    if (data.length > 0) {
      try {
        if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });
        fs.writeFileSync(cacheFile, JSON.stringify({ lastFetch: new Date().toISOString(), data }));
      } catch {}
    }
    return data;
  } catch (e: any) {
    console.error('Yahoo S&P 500 fetch error:', e.message);
    try {
      if (fs.existsSync(cacheFile)) return JSON.parse(fs.readFileSync(cacheFile, 'utf-8')).data || [];
    } catch {}
    return [];
  }
}

// 금 선물(GC=F) — 실질금리 vs 금 비교용
async function getYahooGold(): Promise<FredObservation[]> {
  const cacheFile = join(CACHE_DIR, 'yahoo_gold.json');
  try {
    if (fs.existsSync(cacheFile)) {
      const cached = JSON.parse(fs.readFileSync(cacheFile, 'utf-8'));
      const age = (Date.now() - new Date(cached.lastFetch).getTime()) / (1000 * 60 * 60);
      if (age < 12 && cached.data?.length > 0) return cached.data;
    }
  } catch {}

  try {
    const p1 = Math.floor(new Date('2000-01-01').getTime() / 1000);
    const p2 = Math.floor(Date.now() / 1000);
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/GC%3DF?interval=1d&period1=${p1}&period2=${p2}`;
    const resp = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    if (!resp.ok) throw new Error(`Yahoo GC=F: ${resp.status}`);
    const json = await resp.json();
    const result = json.chart?.result?.[0];
    if (!result) return [];
    const timestamps: number[] = result.timestamp || [];
    const closes: (number | null)[] = result.indicators?.quote?.[0]?.close || [];
    const data: FredObservation[] = [];
    for (let i = 0; i < timestamps.length; i++) {
      const c = closes[i];
      if (c != null && !isNaN(c)) {
        data.push({ date: new Date(timestamps[i] * 1000).toISOString().split('T')[0], value: Math.round(c * 100) / 100 });
      }
    }
    if (data.length > 0) {
      try {
        if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });
        fs.writeFileSync(cacheFile, JSON.stringify({ lastFetch: new Date().toISOString(), data }));
      } catch {}
    }
    return data;
  } catch (e: any) {
    console.error('Yahoo gold fetch error:', e.message);
    try { if (fs.existsSync(cacheFile)) return JSON.parse(fs.readFileSync(cacheFile, 'utf-8')).data || []; } catch {}
    return [];
  }
}

// Get series data (cache-first, refresh if stale)
async function getSeriesData(key: string): Promise<FredObservation[]> {
  const series = SERIES[key];
  if (!series) throw new Error(`Unknown series: ${key}`);

  const cache = loadCache(key);
  const now = new Date();

  // Cache valid for: daily=6h, weekly=12h, monthly=24h
  const maxAge = series.freq === 'Daily' ? 6 : series.freq === 'Weekly' ? 12 : 24;

  if (cache && cache.data.length > 0) {
    const age = (now.getTime() - new Date(cache.lastFetch).getTime()) / (1000 * 60 * 60);
    if (age < maxAge) return cache.data;
  }

  try {
    const data = await fetchFredSeries(series.id);
    if (data.length > 0) {
      saveCache(key, data);
      return data;
    }
  } catch (e: any) {
    console.error(`FRED fetch failed for ${key}:`, e.message);
  }

  // Fallback to cache even if stale
  if (cache && cache.data.length > 0) return cache.data;
  return [];
}

// Compute MMF Total = Retail + Institutional (date-join, forward-fill)
// 기관 데이터가 없으면 소매 단독 반환
function computeMmfTotal(retail: FredObservation[], inst: FredObservation[]): FredObservation[] {
  // Retail-only mode when inst data unavailable
  if (inst.length === 0) {
    return retail
      .filter(d => d.value != null)
      .map(d => ({ date: d.date, value: Math.round(d.value! * 10) / 10 }));
  }
  const instMap = new Map(inst.map(d => [d.date, d.value!]));
  const result: FredObservation[] = [];
  let lastInst = 0;
  for (const r of retail) {
    const iv = instMap.get(r.date);
    if (iv !== undefined) lastInst = iv;
    if (r.value != null && lastInst > 0) {
      result.push({ date: r.date, value: Math.round((r.value + lastInst) * 10) / 10 });
    }
  }
  return result;
}

// Compute Net Liquidity = Fed BS - RRP - TGA
function computeNetLiquidity(fedbs: FredObservation[], rrp: FredObservation[], tga: FredObservation[]): FredObservation[] {
  // Build date maps
  const rrpMap = new Map(rrp.map(d => [d.date, d.value!]));
  const tgaMap = new Map(tga.map(d => [d.date, d.value!]));

  // For weekly series (fedbs, tga), fill forward to daily
  // Use fedbs dates as base, find nearest rrp and tga
  const result: FredObservation[] = [];

  // Merge all unique dates
  const allDates = new Set([...fedbs.map(d => d.date), ...rrp.map(d => d.date), ...tga.map(d => d.date)]);
  const sortedDates = [...allDates].sort();

  let lastFedbs = 0, lastRrp = 0, lastTga = 0;
  for (const date of sortedDates) {
    const fb = fedbs.find(d => d.date === date);
    if (fb) lastFedbs = fb.value! * 1e6; // WALCL is in millions
    const rr = rrpMap.get(date);
    if (rr !== undefined) lastRrp = rr * 1e9; // RRPONTSYD is in billions
    const tg = tga.find(d => d.date === date);
    if (tg) lastTga = tg.value! * 1e6; // WTREGEN is in millions

    if (lastFedbs > 0 && lastRrp >= 0 && lastTga > 0) {
      // Net Liquidity in trillions
      const net = (lastFedbs - lastRrp - lastTga) / 1e12;
      result.push({ date, value: Math.round(net * 1000) / 1000 });
    }
  }

  return result;
}

// GET /api/liquidity — main endpoint
router.get('/', async (_req: Request, res: Response) => {
  try {
    if (!FRED_API_KEY) {
      return res.status(500).json({ error: 'FRED_API_KEY not set. Get a free key at https://fred.stlouisfed.org/docs/api/api_key.html and set it via environment variable or .env file.' });
    }

    // Fetch all FRED series + Yahoo S&P 500 in parallel
    const keys = Object.keys(SERIES);
    const [fredResults, sp500Data, goldData] = await Promise.all([
      Promise.allSettled(keys.map(k => getSeriesData(k))),
      getYahooSP500(),
      getYahooGold(),
    ]);

    const seriesData: Record<string, { meta: any; data: FredObservation[]; latest?: { date: string; value: number } }> = {};

    keys.forEach((key, i) => {
      const result = fredResults[i];
      const data = result.status === 'fulfilled' ? result.value : [];
      const meta = SERIES[key];
      const latest = data.length > 0 ? data[data.length - 1] as { date: string; value: number } : undefined;
      seriesData[key] = { meta, data, latest };
    });

    // Yahoo S&P 500 (1927~) — FRED SP500 대신 사용
    seriesData.sp500 = {
      meta: { id: '^GSPC', name: 'S&P 500', unit: 'Index', freq: 'Daily', category: 'reference', description: 'S&P 500 지수 (Yahoo Finance)' },
      data: sp500Data,
      latest: sp500Data.length > 0 ? sp500Data[sp500Data.length - 1] as { date: string; value: number } : undefined,
    };

    // 금 선물 GC=F (실질금리 비교용)
    seriesData.gold = {
      meta: { id: 'GC=F', name: 'Gold (금)', unit: 'USD/oz', freq: 'Daily', category: 'reference', description: '금 선물 가격 (Yahoo Finance GC=F)' },
      data: goldData,
      latest: goldData.length > 0 ? goldData[goldData.length - 1] as { date: string; value: number } : undefined,
    };

    // Compute Net Liquidity
    let netLiquidity: FredObservation[] = [];
    if (seriesData.fedbs.data.length > 0 && seriesData.rrp.data.length > 0 && seriesData.tga.data.length > 0) {
      netLiquidity = computeNetLiquidity(seriesData.fedbs.data, seriesData.rrp.data, seriesData.tga.data);
    }

    // Compute MMF Total (기관 주간 데이터 미제공 → 소매 단독)
    const mmfInstData = seriesData.mmf_inst?.data ?? [];
    const mmfTotalData = seriesData.mmf_retail.data.length > 0
      ? computeMmfTotal(seriesData.mmf_retail.data, mmfInstData)
      : [];
    seriesData.mmf_total = {
      meta: { id: 'derived', name: 'MMF 소매 잔고', unit: 'Billions $', freq: 'Weekly', category: 'core', description: '소매 MMF 잔고 (기관 주간 데이터는 2021년 이후 FRED 미제공)' },
      data: mmfTotalData,
      latest: mmfTotalData.length > 0 ? mmfTotalData[mmfTotalData.length - 1] as { date: string; value: number } : undefined,
    };


    // NBER 경기침체 기간 추출: 연속된 value=1 구간의 start/end
    const recessions: { start: string; end: string }[] = [];
    if (seriesData.usrec && seriesData.usrec.data) {
      const arr = seriesData.usrec.data;
      let inRec = false, recStart = '';
      for (let i = 0; i < arr.length; i++) {
        const isRec = arr[i].value === 1;
        if (isRec && !inRec) { inRec = true; recStart = arr[i].date; }
        else if (!isRec && inRec) { inRec = false; recessions.push({ start: recStart, end: arr[i - 1].date }); }
      }
      if (inRec) recessions.push({ start: recStart, end: arr[arr.length - 1].date });
    }

    res.json({
      series: seriesData,
      netLiquidity: {
        meta: { name: 'Net Liquidity', unit: 'Trillions $', description: 'Fed BS - RRP - TGA', category: 'core' },
        data: netLiquidity,
        latest: netLiquidity.length > 0 ? netLiquidity[netLiquidity.length - 1] : undefined,
      },
      recessions,
    });
  } catch (err: any) {
    console.error('Liquidity error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/liquidity/series/:key — single series
router.get('/series/:key', async (req: Request, res: Response) => {
  try {
    if (!FRED_API_KEY) {
      return res.status(500).json({ error: 'FRED_API_KEY not set' });
    }
    const { key } = req.params;
    if (!SERIES[key]) return res.status(404).json({ error: 'Unknown series: ' + key });
    const data = await getSeriesData(key);
    res.json({ meta: SERIES[key], data, latest: data.length > 0 ? data[data.length - 1] : null });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
