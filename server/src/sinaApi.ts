// Sina Finance API for Chinese market data
// Provides accurate prevClose and historical data that Yahoo often misses

const SINA_QUOTE_URL = 'https://hq.sinajs.cn/list=';
const SINA_HISTORY_URL = 'https://money.finance.sina.com.cn/quotes_service/api/json_v2.php/CN_MarketData.getKLineData';

const HEADERS = {
  'User-Agent': 'Mozilla/5.0',
  'Referer': 'https://finance.sina.com.cn',
};

// Yahoo symbol → Sina symbol mapping
const SYMBOL_MAP: Record<string, string> = {
  '000001.SS': 'sh000001',  // 상해종합
  '000688.SS': 'sh000688',  // 과창판 50 (STAR 50)
  '399001.SZ': 'sz399001',  // 심천성분
  '399006.SZ': 'sz399006',  // 차이넥스트 (ChiNext)
  '399106.SZ': 'sz399106',  // 심천종합
  '000300.SS': 'sh000300',  // CSI 300
  // 홍콩 (rt_ prefix for real-time HK)
  '^HSI': 'rt_hkHSI',       // 항셍지수
  'HSTECH.HK': 'rt_hkHSTECH', // 항셍테크
};

export function getSinaSymbol(yahooSymbol: string): string | null {
  return SYMBOL_MAP[yahooSymbol] || null;
}

export async function getSinaQuote(yahooSymbol: string): Promise<{
  price: number;
  prevClose: number;
  open: number;
  high: number;
  low: number;
  date: string;
  time: string;
} | null> {
  const sinaSymbol = SYMBOL_MAP[yahooSymbol];
  if (!sinaSymbol) return null;

  try {
    const res = await fetch(SINA_QUOTE_URL + sinaSymbol, { headers: HEADERS });
    const buf = await res.arrayBuffer();
    const text = new TextDecoder('gbk').decode(new Uint8Array(buf));

    const match = text.match(/hq_str_\w+="(.+)"/);
    if (!match) return null;

    const fields = match[1].split(',');
    const isHK = sinaSymbol.startsWith('rt_hk') || sinaSymbol.startsWith('hk');

    if (isHK) {
      // HK format: 코드,이름,시가,전일종가,고가,저가,현재가,변동,변동%,...,날짜,시간
      return {
        price: parseFloat(fields[6]),
        prevClose: parseFloat(fields[3]),
        open: parseFloat(fields[2]),
        high: parseFloat(fields[4]),
        low: parseFloat(fields[5]),
        date: fields[17] || '',
        time: fields[18] || '',
      };
    } else {
      // A주 format: 이름,시가,전일종가,현재가,고가,저가,...,날짜,시간,00
      return {
        price: parseFloat(fields[3]),
        prevClose: parseFloat(fields[2]),
        open: parseFloat(fields[1]),
        high: parseFloat(fields[4]),
        low: parseFloat(fields[5]),
        date: fields[fields.length - 3].includes('-') ? fields[fields.length - 3] : fields[fields.length - 4],
        time: fields[fields.length - 2],
      };
    }
  } catch (e) {
    console.error(`Sina quote failed for ${yahooSymbol}:`, (e as any).message);
    return null;
  }
}

export async function getSinaHistory(yahooSymbol: string, days: number = 30): Promise<{
  day: string;
  close: number;
  open: number;
  high: number;
  low: number;
}[]> {
  const sinaSymbol = SYMBOL_MAP[yahooSymbol];
  if (!sinaSymbol) return [];
  // HK symbols don't support kline API
  if (sinaSymbol.startsWith('rt_hk')) return [];

  try {
    const url = `${SINA_HISTORY_URL}?symbol=${sinaSymbol}&scale=240&ma=no&datalen=${days}`;
    const res = await fetch(url, { headers: HEADERS });
    const data = await res.json();
    return data.map((d: any) => ({
      day: d.day,
      close: parseFloat(d.close),
      open: parseFloat(d.open),
      high: parseFloat(d.high),
      low: parseFloat(d.low),
    }));
  } catch (e) {
    console.error(`Sina history failed for ${yahooSymbol}:`, (e as any).message);
    return [];
  }
}
