import { Router, Request, Response } from 'express';
import https from 'https';
import fs from 'fs';
import { join } from 'path';

const router = Router();

// ── FRED API 키 로드 (liquidity.ts 동일 패턴) ────────────────────────────────
function loadFredKey(): string {
  if (process.env.FRED_API_KEY) return process.env.FRED_API_KEY;
  for (const p of [join(process.cwd(), '..', '.env'), join(process.cwd(), '.env')]) {
    try {
      if (fs.existsSync(p)) {
        const m = fs.readFileSync(p, 'utf-8').match(/FRED_API_KEY\s*=\s*([A-Za-z0-9]+)/);
        if (m) return m[1];
      }
    } catch {}
  }
  return '';
}
const FRED_API_KEY = loadFredKey();
const FRED_BASE = 'https://api.stlouisfed.org/fred/series/observations';

// ── HTTPS GET ────────────────────────────────────────────────────────────────
function httpsGet(url: string, timeoutMs = 20000): Promise<string> {
  return new Promise((resolve, reject) => {
    const get = (u: string, redirects = 0) => {
      const req = https.get(u, {
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' }
      }, res => {
        if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          if (redirects > 5) return reject(new Error('Too many redirects'));
          return get(res.headers.location, redirects + 1);
        }
        if (res.statusCode !== 200) { res.resume(); return reject(new Error('HTTP ' + res.statusCode)); }
        const chunks: Buffer[] = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => resolve(Buffer.concat(chunks).toString()));
        res.on('error', reject);
      });
      req.on('error', reject);
      req.setTimeout(timeoutMs, () => req.destroy(new Error('timeout')));
    };
    get(url);
  });
}

interface FredObs { date: string; value: number | null }

async function fetchFredSeries(id: string, limit = 84): Promise<FredObs[]> {
  if (!FRED_API_KEY) throw new Error('FRED_API_KEY not set');
  // sort_order=desc로 최신 N개 취득 후 역순 정렬 (오름차순)
  const url = `${FRED_BASE}?series_id=${id}&api_key=${FRED_API_KEY}&limit=${limit}&sort_order=desc&file_type=json`;
  const txt = await httpsGet(url);
  const json = JSON.parse(txt);
  if (!json.observations) throw new Error(`No observations in FRED response for ${id}`);
  const obs = (json.observations as any[]).map(o => ({
    date: o.date,
    value: o.value === '.' ? null : parseFloat(o.value),
  }));
  return obs.reverse(); // 오름차순 복원
}

// ── 변환 함수 ─────────────────────────────────────────────────────────────────
function applyYoY(raw: FredObs[]): FredObs[] {
  const valid = raw.filter(d => d.value !== null) as { date: string; value: number }[];
  const result: FredObs[] = [];
  for (let i = 12; i < valid.length; i++) {
    const curr = valid[i].value;
    const prior = valid[i - 12].value;
    if (!prior) continue;
    result.push({ date: valid[i].date, value: +((curr - prior) / prior * 100).toFixed(2) });
  }
  return result;
}

function applyMoMabs(raw: FredObs[]): FredObs[] {
  const valid = raw.filter(d => d.value !== null) as { date: string; value: number }[];
  const result: FredObs[] = [];
  for (let i = 1; i < valid.length; i++) {
    result.push({ date: valid[i].date, value: +(valid[i].value - valid[i - 1].value).toFixed(0) });
  }
  return result;
}

// ── 시리즈 정의 ───────────────────────────────────────────────────────────────
type Transform = 'none' | 'yoy' | 'mom_abs';
type Group = 'inflation' | 'labor' | 'growth' | 'consumer' | 'kr_macro' | 'cn_macro';

interface SeriesDef {
  id: string;
  name: string;
  nameko: string;
  unit: string;
  freq: string;
  group: Group;
  desc: string;
  transform: Transform;
  fetchLimit: number;   // 원데이터 fetch 건수 (변환 전)
  sparkPoints: number;  // sparkline용 변환 후 데이터 개수
  scale?: number;       // 값에 곱할 스케일 (예: 0.001 for thousands 변환)
}

const SERIES: Record<string, SeriesDef> = {
  // ── 인플레이션 ──────────────────────────────────────────────────────────────
  cpi: {
    id: 'CPIAUCSL', name: 'CPI', nameko: '소비자물가',
    unit: 'YoY%', freq: '월간', group: 'inflation',
    desc: 'CPI 전년동월비',
    transform: 'yoy', fetchLimit: 84, sparkPoints: 36,
  },
  core_cpi: {
    id: 'CPILFESL', name: 'Core CPI', nameko: '근원 CPI',
    unit: 'YoY%', freq: '월간', group: 'inflation',
    desc: '식품·에너지 제외 CPI 전년비',
    transform: 'yoy', fetchLimit: 84, sparkPoints: 36,
  },
  pce: {
    id: 'PCEPI', name: 'PCE', nameko: 'PCE 물가',
    unit: 'YoY%', freq: '월간', group: 'inflation',
    desc: 'PCE 전년비 (Fed 선호 인플레이션 지표)',
    transform: 'yoy', fetchLimit: 84, sparkPoints: 36,
  },
  core_pce: {
    id: 'PCEPILFE', name: 'Core PCE', nameko: '근원 PCE',
    unit: 'YoY%', freq: '월간', group: 'inflation',
    desc: '근원 PCE 전년비 (Fed 2% 목표 기준)',
    transform: 'yoy', fetchLimit: 84, sparkPoints: 36,
  },
  // ── 고용 ────────────────────────────────────────────────────────────────────
  unrate: {
    id: 'UNRATE', name: 'Unemployment', nameko: '실업률',
    unit: '%', freq: '월간', group: 'labor',
    desc: '실업률',
    transform: 'none', fetchLimit: 48, sparkPoints: 36,
  },
  payems: {
    id: 'PAYEMS', name: 'NFP', nameko: 'NFP (비농업)',
    unit: 'k MoM', freq: '월간', group: 'labor',
    desc: '비농업취업자 전월 증감 (천명)',
    transform: 'mom_abs', fetchLimit: 38, sparkPoints: 36,
  },
  icsa: {
    id: 'ICSA', name: 'Jobless Claims', nameko: '신규실업수당',
    unit: 'k', freq: '주간', group: 'labor',
    desc: '신규 실업수당 청구건수 (천건)',
    transform: 'none', fetchLimit: 60, sparkPoints: 52,
    scale: 0.001,  // FRED ICSA는 "Number" 단위 → ÷1000 → 천건
  },
  // ── 성장 ────────────────────────────────────────────────────────────────────
  gdp: {
    id: 'A191RL1Q225SBEA', name: 'Real GDP', nameko: '실질 GDP',
    unit: '% QoQ', freq: '분기', group: 'growth',
    desc: '실질 GDP 성장률 (연율 환산)',
    transform: 'none', fetchLimit: 24, sparkPoints: 20,
  },
  cfnai: {
    id: 'CFNAI', name: 'Chicago Fed CFNAI', nameko: '경기활동지수',
    unit: 'Index', freq: '월간', group: 'growth',
    desc: 'Chicago Fed CFNAI: 0↑=평균이상 성장, -0.7↓=경기침체 위험',
    transform: 'none', fetchLimit: 48, sparkPoints: 36,
  },
  retail: {
    id: 'RSAFS', name: 'Retail Sales', nameko: '소매판매',
    unit: 'YoY%', freq: '월간', group: 'growth',
    desc: '소매판매 전년동월비',
    transform: 'yoy', fetchLimit: 84, sparkPoints: 36,
  },
  // ── 소비/주택 ────────────────────────────────────────────────────────────────
  sentiment: {
    id: 'UMCSENT', name: 'UMich Sentiment', nameko: '소비자심리',
    unit: 'Index', freq: '월간', group: 'consumer',
    desc: '미시간대 소비자심리지수 (장기평균 ~86)',
    transform: 'none', fetchLimit: 48, sparkPoints: 36,
  },
  housing: {
    id: 'HOUST', name: 'Housing Starts', nameko: '주택착공',
    unit: 'k', freq: '월간', group: 'consumer',
    desc: '주택착공건수 (천호, 연율)',
    transform: 'none', fetchLimit: 48, sparkPoints: 36,
  },
  mortgage: {
    id: 'MORTGAGE30US', name: '30Y Mortgage', nameko: '모기지금리',
    unit: '%', freq: '주간', group: 'consumer',
    desc: '30년 고정 모기지 금리',
    transform: 'none', fetchLimit: 60, sparkPoints: 52,
  },
};

// ── 한국 시리즈 (OECD/FRED 검증된 시리즈) ────────────────────────────────────
const KR_SERIES: Record<string, SeriesDef> = {
  kr_cpi: {
    id: 'KORCPIALLMINMEI', name: 'Korea CPI', nameko: '소비자물가(CPI)',
    unit: 'YoY%', freq: '월간', group: 'kr_macro',
    desc: 'CPI 전년동월비',
    transform: 'yoy', fetchLimit: 84, sparkPoints: 36,
  },
  kr_unrate: {
    id: 'LRUNTTTTKRM156S', name: 'Korea Unemployment', nameko: '실업률',
    unit: '%', freq: '월간', group: 'kr_macro',
    desc: '실업률 (OECD 조화 기준, SA)',
    transform: 'none', fetchLimit: 48, sparkPoints: 36,
  },
  kr_ip: {
    // KORPRINTO01GYSAM: Growth rate vs same period previous year (already YoY%)
    id: 'KORPRINTO01GYSAM', name: 'Korea IP', nameko: '산업생산',
    unit: 'YoY%', freq: '월간', group: 'kr_macro',
    desc: '산업생산 전년동월비 (건설업 제외)',
    transform: 'none', fetchLimit: 48, sparkPoints: 36,
  },
  kr_export: {
    id: 'XTEXVA01KRM664S', name: 'Korea Exports', nameko: '수출',
    unit: 'YoY%', freq: '월간', group: 'kr_macro',
    desc: '수출금액 전년동월비',
    transform: 'yoy', fetchLimit: 84, sparkPoints: 36,
  },
  kr_gdp: {
    // KORGDPRQPSMEI: QoQ % change, seasonally adjusted (already %)
    id: 'KORGDPRQPSMEI', name: 'Korea GDP', nameko: '실질 GDP',
    unit: '% QoQ', freq: '분기', group: 'kr_macro',
    desc: '실질 GDP 성장률 (전분기비, SA)',
    transform: 'none', fetchLimit: 24, sparkPoints: 20,
  },
  kr_retail: {
    // KORSLRTTO01GYSAM: Growth rate vs same period previous year (already YoY%)
    id: 'KORSLRTTO01GYSAM', name: 'Korea Retail', nameko: '소매판매',
    unit: 'YoY%', freq: '월간', group: 'kr_macro',
    desc: '소매판매 전년동월비 (거래량 기준)',
    transform: 'none', fetchLimit: 48, sparkPoints: 36,
  },
};

// ── 중국 시리즈 (FRED에서 최신 데이터 확인된 시리즈만) ────────────────────────
const CN_SERIES: Record<string, SeriesDef> = {
  cn_cpi: {
    id: 'CHNCPIALLMINMEI', name: 'China CPI', nameko: '소비자물가(CPI)',
    unit: 'YoY%', freq: '월간', group: 'cn_macro',
    desc: 'CPI 전년동월비 (OECD MEI)',
    transform: 'yoy', fetchLimit: 84, sparkPoints: 36,
  },
  cn_export: {
    id: 'XTEXVA01CNM664S', name: 'China Exports', nameko: '수출',
    unit: 'YoY%', freq: '월간', group: 'cn_macro',
    desc: '수출금액 전년동월비',
    transform: 'yoy', fetchLimit: 84, sparkPoints: 36,
  },
  cn_import: {
    id: 'VALIMPCNM052N', name: 'China Imports', nameko: '수입',
    unit: 'YoY%', freq: '월간', group: 'cn_macro',
    desc: '수입금액 전년동월비',
    transform: 'yoy', fetchLimit: 84, sparkPoints: 36,
  },
};

// ── 캐시 ─────────────────────────────────────────────────────────────────────
const CACHE_DIR = join(process.cwd(), '..', 'data');
const CACHE_FILE = join(CACHE_DIR, 'fed_indicators.json');
const CACHE_TTL = 6 * 3600 * 1000; // 6h

let _memCache: { data: any; ts: number } | null = null;

function loadCache() {
  if (_memCache && Date.now() - _memCache.ts < CACHE_TTL) return _memCache.data;
  try {
    if (fs.existsSync(CACHE_FILE)) {
      const obj = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf-8'));
      const hasData = obj.indicators && Object.keys(obj.indicators).length > 0;
      if (obj._ts && Date.now() - obj._ts < CACHE_TTL && hasData) {
        _memCache = { data: obj, ts: obj._ts };
        return obj;
      }
    }
  } catch {}
  return null;
}

function saveCache(data: any) {
  const obj = { ...data, _ts: Date.now() };
  _memCache = { data: obj, ts: Date.now() };
  try {
    if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });
    fs.writeFileSync(CACHE_FILE, JSON.stringify(obj));
  } catch {}
}

// ── 데이터 빌드 ───────────────────────────────────────────────────────────────
async function buildFedData() {
  if (!FRED_API_KEY) {
    return {
      error: 'FRED_API_KEY가 설정되지 않았습니다. .env 파일에 FRED_API_KEY=<키> 를 추가해주세요.',
      indicators: {},
      fetchedAt: new Date().toISOString(),
    };
  }

  // FRED API 속도제한 대응: 최대 4개 동시 요청
  async function pLimit<T>(tasks: (() => Promise<T>)[], concurrency: number): Promise<PromiseSettledResult<T>[]> {
    const results: PromiseSettledResult<T>[] = new Array(tasks.length);
    let idx = 0;
    async function worker() {
      while (idx < tasks.length) {
        const i = idx++;
        try { results[i] = { status: 'fulfilled', value: await tasks[i]() }; }
        catch (reason) { results[i] = { status: 'rejected', reason }; }
      }
    }
    await Promise.all(Array.from({ length: concurrency }, worker));
    return results;
  }

  // 공통 시리즈 fetch 함수
  function makeTask(key: string, def: SeriesDef) {
    return async () => {
      const raw = await fetchFredSeries(def.id, def.fetchLimit);
      const scaledRaw = def.scale
        ? raw.map(d => ({ ...d, value: d.value !== null ? +(d.value * def.scale!).toFixed(3) : null }))
        : raw;
      let transformed: FredObs[];
      if (def.transform === 'yoy') transformed = applyYoY(scaledRaw);
      else if (def.transform === 'mom_abs') transformed = applyMoMabs(scaledRaw);
      else transformed = scaledRaw.filter(d => d.value !== null);
      if (transformed.length === 0) return { key, result: null };
      const history = transformed.slice(-def.sparkPoints);
      const current = transformed[transformed.length - 1];
      const prior   = transformed.length >= 2 ? transformed[transformed.length - 2] : null;
      return {
        key,
        result: { name: def.name, nameko: def.nameko, unit: def.unit, freq: def.freq, group: def.group, desc: def.desc, current, prior, history },
      };
    };
  }

  const allTasks = [
    ...Object.entries(SERIES).map(([k, d]) => makeTask(k, d)),
    ...Object.entries(KR_SERIES).map(([k, d]) => makeTask(k, d)),
    ...Object.entries(CN_SERIES).map(([k, d]) => makeTask(k, d)),
  ];

  const settled = await pLimit(allTasks, 4);

  const indicators: Record<string, any> = {};
  const kr_indicators: Record<string, any> = {};
  const cn_indicators: Record<string, any> = {};

  for (const r of settled) {
    if (r.status === 'fulfilled' && r.value?.result) {
      const { key, result } = r.value;
      if (key.startsWith('kr_')) kr_indicators[key] = result;
      else if (key.startsWith('cn_')) cn_indicators[key] = result;
      else indicators[key] = result;
    } else if (r.status === 'rejected') {
      console.warn('[fed] fetch failed:', (r as any).reason?.message || r);
    }
  }

  return { indicators, kr_indicators, cn_indicators, fetchedAt: new Date().toISOString() };
}

// ── 캐시 워밍업 ───────────────────────────────────────────────────────────────
async function warmUp() {
  if (loadCache()) return;
  try {
    console.log('[fed] 경제지표 캐시 워밍업...');
    const data = await buildFedData();
    if (Object.keys(data.indicators).length > 0) saveCache(data);
    console.log(`[fed] 완료 (${Object.keys(data.indicators).length}개 시리즈)`);
  } catch (e) {
    console.warn('[fed] 워밍업 실패:', e);
  }
}
setTimeout(warmUp, 8000);

// ── 라우터 ────────────────────────────────────────────────────────────────────
router.get('/', async (_req: Request, res: Response) => {
  try {
    const cached = loadCache();
    if (cached) return res.json(cached);

    const data = await buildFedData();
    if (Object.keys(data.indicators).length > 0) saveCache(data);
    res.json(data);
  } catch (err: any) {
    res.status(500).json({ error: String(err?.message ?? err) });
  }
});

// 캐시 강제 갱신
router.post('/refresh', async (_req: Request, res: Response) => {
  try {
    _memCache = null;
    const data = await buildFedData();
    if (Object.keys(data.indicators).length > 0) saveCache(data);
    res.json({ ok: true, count: Object.keys(data.indicators).length, fetchedAt: data.fetchedAt });
  } catch (err: any) {
    res.status(500).json({ error: String(err?.message ?? err) });
  }
});

export default router;
