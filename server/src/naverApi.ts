// Naver Finance API for Korean market data (KOSPI, KOSDAQ)

const NAVER_API = 'https://m.stock.naver.com/api/index';
const HEADERS = { 'User-Agent': 'Mozilla/5.0' };

const SYMBOL_MAP: Record<string, string> = {
  '^KS11': 'KOSPI',
  '^KQ11': 'KOSDAQ',
};

export function getNaverSymbol(yahooSymbol: string): string | null {
  return SYMBOL_MAP[yahooSymbol] || null;
}

export interface NaverPriceEntry {
  date: string;       // YYYY-MM-DD
  close: number;
  changePercent: number;
}

export async function getNaverHistory(yahooSymbol: string, pageSize: number = 30): Promise<NaverPriceEntry[]> {
  const naverCode = SYMBOL_MAP[yahooSymbol];
  if (!naverCode) return [];

  try {
    const res = await fetch(`${NAVER_API}/${naverCode}/price?pageSize=${pageSize}`, { headers: HEADERS });
    if (!res.ok) return [];
    const data = await res.json();

    return data.map((d: any) => ({
      date: d.localTradedAt,
      close: parseFloat(d.closePrice.replace(/,/g, '')),
      changePercent: parseFloat(d.fluctuationsRatio),
    }));
  } catch (e) {
    console.error(`Naver API failed for ${yahooSymbol}:`, (e as any).message);
    return [];
  }
}
