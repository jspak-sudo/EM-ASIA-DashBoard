// 산술 가중평균 시가총액 (Arithmetic Weighted Average Market Cap) 캐시
// 계산식: Σ(weight_i × marketcap_i) / Σ(weight_i)  — 기하평균(HS03W)보다 대형주 비중을 정확히 반영
// 단위: KRW 억원 (해외 ETF는 USD_mil × 14, 국내 ETF는 KRW_mil ÷ 100 정규화)

import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

interface MsEntry {
  name: string;
  avgCapKrwBillion: number | null;
  src?: 'USD_mil' | 'KRW_mil';
  raw?: number;
}
interface MsCache {
  _meta: Record<string, unknown>;
  data: Record<string, MsEntry>;
}

let _cache: MsCache | null = null;

function loadCache(): MsCache {
  if (_cache) return _cache;
  const candidates = [
    join(__dirname, '../data/morningstarCache.json'),
    join(__dirname, '../../src/data/morningstarCache.json'),
  ];
  for (const p of candidates) {
    try {
      const raw = readFileSync(p, 'utf-8');
      _cache = JSON.parse(raw) as MsCache;
      return _cache;
    } catch {}
  }
  _cache = { _meta: {}, data: {} };
  return _cache;
}

/** 산술 가중평균 시가총액을 KRW 억원으로 반환. 없으면 null. */
export function getMorningstarAvgCapKrwBillion(itemcode: string): number | null {
  const c = loadCache();
  const e = c.data[itemcode];
  return e?.avgCapKrwBillion ?? null;
}

export function hasMorningstarData(itemcode: string): boolean {
  const c = loadCache();
  return itemcode in c.data;
}

/** 하위호환: 기존 코드 흔적 제거용 (사용 금지 권장) */
export function getMorningstarAvgCapUsdMil(itemcode: string): number | null {
  const c = loadCache();
  const e = c.data[itemcode];
  if (!e) return null;
  if (e.src === 'USD_mil' && typeof e.raw === 'number') return e.raw;
  // KRW_mil인 경우 USD_mil 환산은 무의미 → null 반환 (호출부에서 새 함수로 대체 필요)
  return null;
}
