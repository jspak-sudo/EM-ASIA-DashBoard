// TIME ETF (타임폴리오자산운용) 공식 홀딩스 fetcher
// https://timeetf.co.kr/pdf_excel.php?idx={idx}&cate={001|002}
// xlsx로 전체 구성종목 + 비중(%) 제공 (해외종목 비중 포함)

import * as XLSX from 'xlsx';

export interface TimeHolding {
  code: string;      // 블룸버그 티커 prefix (예: NVDA US EQUITY → NVDA)
  rawCode: string;   // 원본 코드 (NVDA US EQUITY)
  name: string;
  shares: number;
  valueKRW: number;  // 평가금액 (원)
  weight: number;    // %
}

// 6자리 itemcode → { idx, cate }
// 출처: https://timeetf.co.kr/m11_list.php?cate=001 / cate=002
export const TIME_ETF_MAP: Record<string, { idx: number; cate: '001' | '002' }> = {
  // 해외 (cate=001)
  '426030': { idx: 2,  cate: '001' }, // 미국나스닥100액티브
  '426020': { idx: 5,  cate: '001' }, // 미국S&P500액티브
  '0113D0': { idx: 22, cate: '001' }, // 글로벌탑픽액티브
  '456600': { idx: 6,  cate: '001' }, // 글로벌AI인공지능액티브
  '485810': { idx: 9,  cate: '001' }, // 글로벌바이오액티브
  '478150': { idx: 20, cate: '001' }, // 글로벌우주테크&방산액티브
  '0043Y0': { idx: 19, cate: '001' }, // 차이나AI테크액티브
  '0036D0': { idx: 18, cate: '001' }, // 미국배당다우존스액티브
  '0019K0': { idx: 10, cate: '001' }, // 미국나스닥100채권혼합50액티브
  '494180': { idx: 8,  cate: '001' }, // 글로벌소비트렌드액티브
  // 국내 (cate=002)
  '441800': { idx: 12, cate: '002' }, // Korea플러스배당액티브
  '385720': { idx: 11, cate: '002' }, // 코스피액티브
  '495060': { idx: 15, cate: '002' }, // 코리아밸류업액티브
  '0162Y0': { idx: 24, cate: '002' }, // 코스닥액티브
  '404120': { idx: 16, cate: '002' }, // K신재생에너지액티브
  '463050': { idx: 13, cate: '002' }, // K바이오액티브
  '385710': { idx: 17, cate: '002' }, // K이노베이션액티브
  '410870': { idx: 1,  cate: '002' }, // K컬처액티브
};

const TTL = 6 * 60 * 60 * 1000; // 6시간
const cache: Record<string, { data: TimeHolding[]; ts: number }> = {};

function parseBloombergTicker(raw: string): { code: string } {
  // "NVDA US EQUITY" → "NVDA"
  // "7203 JT EQUITY" → "7203.T" (일본)
  // "005930 KS EQUITY" → "005930"
  // "082920" (국내 ETF의 경우 6자리 코드 바로 제공) → "082920"
  // "NQM6 Index", "현금" 같은 건 제외
  const t = raw.trim();
  if (!t || t === '현금' || /현금|cash/i.test(t)) return { code: '' };
  if (/\bindex\b/i.test(t)) return { code: '' }; // 선물/지수 제외

  // 국내 ETF xlsx는 6자리 코드 바로 제공 (082920, 005930 등)
  if (/^[0-9A-Z]{6}$/i.test(t)) return { code: t.toUpperCase() };

  const m = t.match(/^([A-Z0-9]+)\s+([A-Z]{2})\s+EQUITY$/i);
  if (!m) return { code: '' };
  const [, sym, country] = m;
  const c = country.toUpperCase();
  if (c === 'US') return { code: sym };
  if (c === 'KS' || c === 'KP') return { code: sym };   // 한국 코스피/코스닥
  if (c === 'JT') return { code: `${sym}.T` };
  if (c === 'HK') return { code: `${sym}.HK` };
  return { code: sym };
}

export async function fetchTimeEtfHoldings(itemcode: string): Promise<TimeHolding[] | null> {
  const info = TIME_ETF_MAP[itemcode];
  if (!info) return null;

  const cached = cache[itemcode];
  if (cached && Date.now() - cached.ts < TTL) return cached.data;

  try {
    const url = `https://timeetf.co.kr/pdf_excel.php?idx=${info.idx}&cate=${info.cate}`;
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0',
        'Referer': `https://timeetf.co.kr/m11_view.php?idx=${info.idx}&cate=${info.cate}`,
      },
    });
    if (!res.ok) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    const wb = XLSX.read(buf, { type: 'buffer' });
    const ws = wb.Sheets[wb.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json<any[]>(ws, { header: 1 });

    const holdings: TimeHolding[] = [];
    for (let i = 1; i < rows.length; i++) {
      const r = rows[i];
      if (!r || !r[0]) continue;
      const rawCode = String(r[0]).trim();
      const name = String(r[1] ?? '').trim();
      if (!name || /현금|cash/i.test(rawCode) || /현금|cash/i.test(name)) continue;
      if (/\bindex\b/i.test(rawCode)) continue; // 선물/지수 제외

      const sharesRaw = r[2];
      const valueRaw = r[3];
      const weightRaw = r[4];
      const shares = typeof sharesRaw === 'number' ? sharesRaw : parseInt(String(sharesRaw || '0').replace(/,/g, ''), 10) || 0;
      const valueKRW = typeof valueRaw === 'number' ? valueRaw : parseInt(String(valueRaw || '0').replace(/,/g, ''), 10) || 0;
      const weight = typeof weightRaw === 'number' ? weightRaw : parseFloat(String(weightRaw || '0').replace(/,/g, '')) || 0;

      const { code } = parseBloombergTicker(rawCode);
      holdings.push({ code, rawCode, name, shares, valueKRW, weight });
    }

    cache[itemcode] = { data: holdings, ts: Date.now() };
    return holdings;
  } catch (e) {
    return null;
  }
}
