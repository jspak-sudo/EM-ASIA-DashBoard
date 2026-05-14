import { Router, Request, Response } from 'express';
import https from 'https';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';

const router = Router();

// ── 캐시 (15분) ───────────────────────────────────────────────────────────────
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const CACHE_FILE = path.join(__dirname, '../../../data/fedwatch_cache.json');
const CACHE_TTL_MS = 15 * 60 * 1000; // 15분

let _memCache: { data: any; ts: number } | null = null;

function loadCache() {
  if (_memCache && Date.now() - _memCache.ts < CACHE_TTL_MS) return _memCache.data;
  try {
    const raw = fs.readFileSync(CACHE_FILE, 'utf-8');
    const obj = JSON.parse(raw);
    if (Date.now() - new Date(obj._cachedAt).getTime() < CACHE_TTL_MS) {
      _memCache = { data: obj, ts: new Date(obj._cachedAt).getTime() };
      return obj;
    }
  } catch {}
  return null;
}

function saveCache(data: any) {
  const obj = { ...data, _cachedAt: new Date().toISOString() };
  _memCache = { data: obj, ts: Date.now() };
  try { fs.writeFileSync(CACHE_FILE, JSON.stringify(obj)); } catch {}
}

// ── 헬퍼: HTTPS GET (10s timeout) ────────────────────────────────────────────
function httpsGet(url: string, timeoutMs = 10000): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const get = (u: string, redirects = 0) => {
      const req = https.get(u, { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' } }, res => {
        if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          if (redirects > 5) return reject(new Error('Too many redirects'));
          return get(res.headers.location, redirects + 1);
        }
        if (res.statusCode !== 200) { res.resume(); return reject(new Error('HTTP ' + res.statusCode)); }
        const chunks: Buffer[] = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => resolve(Buffer.concat(chunks)));
        res.on('error', reject);
      });
      req.on('error', reject);
      req.setTimeout(timeoutMs, () => { req.destroy(new Error('Request timeout')); });
    };
    get(url);
  });
}

// ── FOMC 회의 날짜 (end date 기준) ────────────────────────────────────────────
// Fed 공식 일정 (2025~2027 확정 날짜)
const FOMC_DATES_ALL = [
  '2025-01-29','2025-03-19','2025-05-07','2025-06-18',
  '2025-07-30','2025-09-17','2025-10-29','2025-12-10',
  '2026-01-28','2026-03-18','2026-05-06','2026-06-17',
  '2026-07-29','2026-09-16','2026-10-28','2026-12-09',
  '2027-01-27','2027-03-17','2027-05-05','2027-06-16',
];

// 선물 월 코드 → 숫자 (FOMC date → 해당 또는 직후 계약)
const MONTH_CODE: Record<string, string> = {
  '01':'F','02':'G','03':'H','04':'J','05':'K','06':'M',
  '07':'N','08':'Q','09':'U','10':'V','11':'X','12':'Z',
};

// FOMC 회의일에서 → 직후 월물 기호 계산
// 관행: FOMC end date가 해당 월 중반이면 같은 달 말의 평균 rate 이미 반영 → 해당 월물 사용
function fomcToFuturesSymbol(dateStr: string): string {
  const [year, month] = dateStr.split('-');
  return `ZQ${MONTH_CODE[month]}${year.slice(2)}.CBT`;
}

// ── FRED public CSV: DFEDTARL / DFEDTARU ──────────────────────────────────────
async function fetchFredCsv(id: string, limit = 120): Promise<{ date: string; value: number }[]> {
  const url = `https://fred.stlouisfed.org/graph/fredgraph.csv?id=${id}`;
  const txt = (await httpsGet(url, 20000)).toString();
  const lines = txt.trim().split('\n').slice(1); // skip header
  // validate CSV format (first char of first data line should be a digit for date)
  if (!lines[0]?.match(/^\d{4}/)) throw new Error('Invalid CSV response');
  return lines.slice(-limit).map(l => {
    const [date, val] = l.split(',');
    return { date: date.trim(), value: parseFloat(val) };
  }).filter(d => !isNaN(d.value));
}

// ── Yahoo Finance: 선물 가격 ──────────────────────────────────────────────────
interface FuturesPoint {
  symbol: string;
  date: string;       // YYYY-MM (contract month)
  price: number;
  impliedRate: number;
}

async function fetchFuturesPrices(): Promise<FuturesPoint[]> {
  // 현재~2027 주요 계약 (동적 생성)
  const today = new Date();
  const symbols: string[] = [];
  for (let yr = today.getFullYear(); yr <= today.getFullYear() + 2; yr++) {
    const shortYr = String(yr).slice(2);
    Object.values(MONTH_CODE).forEach(code => {
      symbols.push(`ZQ${code}${shortYr}.CBT`);
    });
  }

  // 병렬 fetch (concurrency 4)
  const results: FuturesPoint[] = [];
  const batchSize = 4;
  for (let i = 0; i < symbols.length; i += batchSize) {
    const batch = symbols.slice(i, i + batchSize);
    const settled = await Promise.allSettled(batch.map(async sym => {
      const url = `https://query1.finance.yahoo.com/v8/finance/chart/${sym}?interval=1d&range=5d`;
      const data = JSON.parse((await httpsGet(url, 8000)).toString());
      const price = data.chart?.result?.[0]?.meta?.regularMarketPrice as number | undefined;
      if (!price) return null;
      const code = sym.slice(2, 3);
      const yr = '20' + sym.slice(3, 5);
      const monthNum = Object.entries(MONTH_CODE).find(([, v]) => v === code)?.[0] ?? '01';
      return { symbol: sym, date: `${yr}-${monthNum}`, price: +price.toFixed(4), impliedRate: +(100 - price).toFixed(4) } as FuturesPoint;
    }));
    settled.forEach(r => { if (r.status === 'fulfilled' && r.value) results.push(r.value); });
  }
  // 현재 날짜 이후, 유효한 계약만 (price < 100 & > 90)
  return results
    .filter(r => r.impliedRate > 0 && r.impliedRate < 10 && r.date >= today.toISOString().slice(0,7))
    .sort((a, b) => a.date.localeCompare(b.date));
}

// ── FOMC Dot Plot 파싱 ────────────────────────────────────────────────────────
interface DotPlotData {
  source: string;
  medianRate: Record<string, number>;  // year → median
  distribution: { rate: number; counts: Record<string, number> }[];
}

// 최신 발표된 dot plot HTML 파싱
async function fetchDotPlot(): Promise<DotPlotData | null> {
  // 최근 2개 발표 날짜 목록 (가장 최근부터 시도)
  const candidates = [
    'fomcprojtabl20260318.htm',
    'fomcprojtabl20251210.htm',
    'fomcprojtabl20250917.htm',
    'fomcprojtabl20250618.htm',
    'fomcprojtabl20250319.htm',
  ];
  for (const fname of candidates) {
    try {
      const url = `https://www.federalreserve.gov/monetarypolicy/${fname}`;
      const html = (await httpsGet(url)).toString();

      // 발표 날짜 추출 (파일명에서)
      const dateMatch = fname.match(/(\d{8})/);
      const dateStr = dateMatch ? `${dateMatch[1].slice(0,4)}-${dateMatch[1].slice(4,6)}-${dateMatch[1].slice(6,8)}` : '';

      // Federal Funds Rate median 추출 (Figure 1 table)
      // 구조: Federal funds rate 행의 4개 data cells = 2026, 2027, 2028, LongerRun
      const ffRateBlock = html.match(/Federal funds rate<\/th>([\s\S]*?)<\/tr>/);
      const medianRate: Record<string, number> = {};
      if (ffRateBlock) {
        const cells = [...ffRateBlock[1].matchAll(/<td class="data"[^>]*>([\d.]+)<\/td>/g)];
        // 첫 4개: median 2026~LongerRun (현재연도부터)
        const currentYear = new Date().getFullYear();
        const yearLabels = [
          String(currentYear), String(currentYear+1), String(currentYear+2), 'LongerRun'
        ];
        // 발표연도 기반으로 조정
        const projYear = parseInt(dateStr.slice(0,4));
        const labels = [
          String(projYear), String(projYear+1), String(projYear+2), 'LongerRun'
        ];
        cells.slice(0, 4).forEach((c, i) => {
          if (labels[i]) medianRate[labels[i]] = parseFloat(c[1]);
        });
      }

      // Figure 2: Dot plot distribution 파싱
      // 각 rate row: stub headers="9aa52acd" 에서 rate 값, data cells = count per year
      const distribution: { rate: number; counts: Record<string, number> }[] = [];

      // year column headers 찾기 (Figure 2의 열 헤더)
      const fig2Match = html.match(/Figure 2[\s\S]*?<\/table>/);
      if (fig2Match) {
        const fig2 = fig2Match[0];
        const headerIds: string[] = [];
        const headers = [...fig2.matchAll(/<th class="colhead" id="([^"]+)"[^>]*>([\d]+)<\/th>/g)];
        const yearCols: string[] = headers.map(h => h[2]);

        // stub rows with rate values
        const rateRows = [...fig2.matchAll(/<th class="stub"[^>]*>([\d.]+)<\/th>([\s\S]*?)(?=<th class="stub"|<\/tbody>)/g)];
        for (const row of rateRows) {
          const rate = parseFloat(row[1]);
          if (isNaN(rate)) continue;
          const cells = [...row[2].matchAll(/<td class="(?:data|emptydata)"[^>]*>([\d&; ]*)<\/td>/g)];
          const counts: Record<string, number> = {};
          cells.forEach((c, i) => {
            const raw = c[1].replace(/&nbsp;/g, '').trim();
            const n = parseInt(raw);
            if (yearCols[i] && !isNaN(n)) counts[yearCols[i]] = n;
          });
          if (Object.keys(counts).length > 0) distribution.push({ rate, counts });
        }
      }

      return {
        source: dateStr,
        medianRate,
        distribution,
      };
    } catch { /* try next */ }
  }
  return null;
}

// ── 회의별 확률 계산 ──────────────────────────────────────────────────────────
interface MeetingProb {
  date: string;
  label: string;
  futuresSymbol: string;
  impliedRate: number | null;
  impliedMidpoint: number;  // current fed funds midpoint가 아닌 cumulative implied
  probCut50: number;   // 50bp cut
  probCut25: number;   // 25bp cut
  probHold: number;
  probHike25: number;
  expectedChange: number;   // bps
}

function calcMeetingProbs(
  fomcDates: string[],
  futures: FuturesPoint[],
  currentMidpoint: number
): MeetingProb[] {
  const futuresMap = new Map(futures.map(f => [f.date, f]));
  const results: MeetingProb[] = [];
  let prevRate = currentMidpoint;

  for (const date of fomcDates) {
    const [year, month] = date.split('-');
    const monthKey = `${year}-${month}`;
    const fut = futuresMap.get(monthKey);
    const impliedRate = fut ? fut.impliedRate : null;

    // 현 회의에서 기대 변화 = 이전 implied - 현재 implied
    const effectiveRate = impliedRate ?? prevRate;
    const expectedChangeBps = Math.round((prevRate - effectiveRate) * 100); // positive = cut

    // ── 누적 확률 모델 (현재 금리 기준) ─────────────────────────────────────────
    // diff = 지금 현재 기준금리 - 이 회의 이후의 내재금리 (양수 = 시장이 인하 예상)
    let probCut50 = 0, probCut25 = 0, probHold = 0, probHike25 = 0;

    if (impliedRate !== null) {
      const cumulDiff = currentMidpoint - impliedRate; // 현재 기준금리 대비 총 누적 변화
      // 각 step을 25bp로 나눠 확률 분배
      // cumulDiff > 0 → 인하 방향 / < 0 → 인상 방향
      if (cumulDiff >= 0.875) {
        // 3cut 이상 영역: 2cut + 3cut 분배
        probCut50 = Math.min(100, Math.round((cumulDiff - 0.75) / 0.25 * 100));
        probCut25 = 100 - probCut50;   // 여기서는 ≥2cut 의미
      } else if (cumulDiff >= 0.625) {
        probCut50 = Math.min(100, Math.round((cumulDiff - 0.5) / 0.25 * 100));
        probCut25 = 100 - probCut50;
      } else if (cumulDiff >= 0.375) {
        probCut50 = Math.round((cumulDiff - 0.25) / 0.25 * 100);
        probCut25 = 100 - probCut50;
      } else if (cumulDiff > 0) {
        // 0 ~ 25bp: hold + cut25 혼합
        probCut25 = Math.min(99, Math.max(1, Math.round(cumulDiff / 0.25 * 100)));
        probHold = 100 - probCut25;
      } else if (cumulDiff === 0) {
        probHold = 100;
      } else if (cumulDiff > -0.375) {
        // 0 ~ -25bp: hold + hike 혼합
        probHike25 = Math.min(99, Math.max(1, Math.round(-cumulDiff / 0.25 * 100)));
        probHold = 100 - probHike25;
      } else {
        probHike25 = Math.min(100, Math.round(-cumulDiff / 0.25 * 100));
      }
    } else {
      probHold = 100;
    }

    const monthNames = ['','Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    const label = `${monthNames[parseInt(month)]} ${year}`;

    results.push({
      date,
      label,
      futuresSymbol: fut?.symbol ?? '',
      impliedRate,
      impliedMidpoint: effectiveRate,
      probCut50,
      probCut25,
      probHold,
      probHike25,
      expectedChange: expectedChangeBps,
    });

    prevRate = effectiveRate;
  }
  return results;
}

// ── FEDFUNDS 히스토리 ─────────────────────────────────────────────────────────
async function fetchFedFundsHistory(): Promise<{
  lower: { date: string; value: number }[];
  upper: { date: string; value: number }[];
}> {
  // DFEDTARL (하한) / DFEDTARU (상단) 일별 — 실패 시 FEDFUNDS 월별 폴백
  const tryPairs: [string, string][] = [
    ['DFEDTARL', 'DFEDTARU'],
  ];
  for (const [lid, uid] of tryPairs) {
    try {
      const [lower, upper] = await Promise.all([
        fetchFredCsv(lid, 250),
        fetchFredCsv(uid, 250),
      ]);
      if (lower.length > 0) return { lower, upper };
    } catch { /* try next */ }
  }
  // 폴백: FEDFUNDS 월별로 ±12.5bp 밴드 근사
  try {
    const ff = await fetchFredCsv('FEDFUNDS', 72);
    const lower = ff.map(d => ({ date: d.date, value: +(Math.max(0, d.value - 0.125)).toFixed(3) }));
    const upper = ff.map(d => ({ date: d.date, value: +(d.value + 0.125).toFixed(3) }));
    return { lower, upper };
  } catch {
    return { lower: [], upper: [] };
  }
}

// ── 서버 시작 시 캐시 워밍업 ─────────────────────────────────────────────────
async function warmUpCache() {
  const cached = loadCache();
  if (cached) return; // 이미 유효한 캐시 있음
  console.log('[fedwatch] 캐시 워밍업 시작...');
  try {
    const data = await buildFedWatchData();
    saveCache(data);
    console.log('[fedwatch] 캐시 워밍업 완료');
  } catch (e) {
    console.warn('[fedwatch] 캐시 워밍업 실패:', e);
  }
}
setTimeout(warmUpCache, 5000);

async function buildFedWatchData() {
  const today = new Date().toISOString().slice(0, 10);

  // 모두 병렬 fetch
  const [histResult, futuresResult, dotPlotResult] = await Promise.allSettled([
    fetchFedFundsHistory(),
    fetchFuturesPrices(),
    fetchDotPlot(),
  ]);

  const histData = histResult.status === 'fulfilled' ? histResult.value : { lower: [], upper: [] };
  const futuresData = futuresResult.status === 'fulfilled' ? futuresResult.value : [];
  const dotPlotData = dotPlotResult.status === 'fulfilled' ? dotPlotResult.value : null;

  // 현재 금리
  const latest = histData.lower[histData.lower.length - 1];
  const latestUpper = histData.upper[histData.upper.length - 1];
  const currentLower = latest?.value ?? 3.5;
  const currentUpper = latestUpper?.value ?? 3.75;
  const currentMidpoint = (currentLower + currentUpper) / 2;

  // 히스토리 차트용
  const cutoff3y = new Date();
  cutoff3y.setFullYear(cutoff3y.getFullYear() - 3);
  const cutoffStr = cutoff3y.toISOString().slice(0, 10);
  const lowerHist = histData.lower.filter(d => d.date >= cutoffStr);
  const upperHist = histData.upper.filter(d => d.date >= cutoffStr);

  // 미래 FOMC 회의들
  const upcomingDates = FOMC_DATES_ALL.filter(d => d > today);
  const meetingProbs = calcMeetingProbs(upcomingDates, futuresData, currentMidpoint);
  const impliedPath = [
    { date: today, impliedRate: currentMidpoint, label: 'Now' },
    ...meetingProbs.filter(m => m.impliedRate !== null)
                   .map(m => ({ date: m.date, impliedRate: m.impliedMidpoint, label: m.label })),
  ];

  return {
    currentRate: { lower: currentLower, upper: currentUpper, midpoint: +currentMidpoint.toFixed(4), date: latest?.date ?? today },
    rateHistory: { lower: lowerHist, upper: upperHist },
    futures: futuresData,
    impliedPath,
    dotPlot: dotPlotData,
    meetingProbs,
    fetchedAt: new Date().toISOString(),
  };
}

// ── Main handler ──────────────────────────────────────────────────────────────
router.get('/', async (_req: Request, res: Response) => {
  try {
    // 캐시 확인
    const cached = loadCache();
    if (cached) { return res.json(cached); }

    const result = await buildFedWatchData();
    saveCache(result);
    res.json(result);
  } catch (err: any) {
    res.status(500).json({ error: String(err?.message ?? err) });
  }
});

export default router;
