const BASE_URL = 'https://query1.finance.yahoo.com';
const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
};

async function fetchYahoo(url: string) {
  const res = await fetch(url, { headers: HEADERS });
  if (!res.ok) throw new Error(`Yahoo API error: ${res.status} ${res.statusText}`);
  return res.json();
}

export async function getQuote(symbol: string) {
  const data = await fetchYahoo(
    `${BASE_URL}/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=1d`
  );
  const meta = data.chart?.result?.[0]?.meta;
  if (!meta) throw new Error('No quote data');

  const prevClose = meta.chartPreviousClose || meta.previousClose || 0;
  const price = meta.regularMarketPrice || 0;
  const change = price - prevClose;
  const changePercent = prevClose ? (change / prevClose) * 100 : 0;

  // Market time info
  const regularMarketTime = meta.regularMarketTime ? new Date(meta.regularMarketTime * 1000) : null;
  const tz = meta.exchangeTimezoneName || 'America/New_York';

  // Determine if market is open using tradingPeriods
  const now = Math.floor(Date.now() / 1000);
  const trading = meta.currentTradingPeriod;
  let marketState = 'CLOSED';
  if (trading?.regular) {
    const regStart = trading.regular.start;
    const regEnd = trading.regular.end;
    if (now >= regStart && now < regEnd) marketState = 'OPEN';
    else if (trading.pre && now >= trading.pre.start && now < regStart) marketState = 'PRE';
    else if (trading.post && now >= regEnd && now < trading.post.end) marketState = 'POST';
  }

  // Format helper: MM.DD HH:mm
  function fmtTime(date: Date, timezone: string): string {
    return date.toLocaleDateString('ko-KR', { timeZone: timezone, month: '2-digit', day: '2-digit' })
      + ' ' + date.toLocaleTimeString('ko-KR', { timeZone: timezone, hour: '2-digit', minute: '2-digit', hour12: false });
  }

  // Timezone short label
  const tzLabels: Record<string, string> = {
    'Asia/Seoul': 'KST', 'Asia/Tokyo': 'JST', 'Asia/Shanghai': 'CST',
    'Asia/Hong_Kong': 'HKT', 'Asia/Taipei': 'CST', 'Asia/Kolkata': 'IST',
    'Asia/Singapore': 'SGT', 'Australia/Sydney': 'AEST',
    'America/New_York': 'ET', 'America/Sao_Paulo': 'BRT',
    'Europe/London': 'GMT', 'US/Eastern': 'ET',
  };
  const tzShort = tzLabels[tz] || tz.split('/').pop() || '';

  const KST = 'Asia/Seoul';
  const timeKST = regularMarketTime ? fmtTime(regularMarketTime, KST) : null;
  const timeLocal = (regularMarketTime && tz !== KST) ? fmtTime(regularMarketTime, tz) : null;

  return {
    symbol: meta.symbol,
    shortName: meta.shortName || meta.symbol,
    longName: meta.longName || meta.shortName || meta.symbol,
    regularMarketPrice: price,
    regularMarketChange: change,
    regularMarketChangePercent: changePercent,
    currency: meta.currency || 'USD',
    fiftyTwoWeekHigh: meta.fiftyTwoWeekHigh || null,
    fiftyTwoWeekLow: meta.fiftyTwoWeekLow || null,
    marketState,
    exchangeName: meta.fullExchangeName || meta.exchangeName || '',
    timezone: tz,
    tzShort,
    timeKST,
    timeLocal,
    regularMarketTime: meta.regularMarketTime || null,
    prevClose: prevClose,
    // 장 시간 (Yahoo에서 동적으로 제공, 서머타임 자동 반영)
    tradingPeriod: trading?.regular ? {
      start: trading.regular.start,
      end: trading.regular.end,
    } : null,
  };
}

export async function getChart(symbol: string, range: string, interval: string) {
  const data = await fetchYahoo(
    `${BASE_URL}/v8/finance/chart/${encodeURIComponent(symbol)}?interval=${interval}&range=${range}`
  );
  const result = data.chart?.result?.[0];
  if (!result) return [];

  const timestamps = result.timestamp || [];
  const quotes = result.indicators?.quote?.[0] || {};
  const isIntraday = interval.includes('m') || interval.includes('h');

  // For intraday, deduplicate by keeping last entry per unique time
  const entries = timestamps.map((ts: number, i: number) => {
    let time: string;
    if (isIntraday) {
      // lightweight-charts needs Unix timestamp for intraday
      time = String(ts);
    } else {
      time = new Date(ts * 1000).toISOString().split('T')[0];
    }
    return {
      time,
      open: quotes.open?.[i] ?? null,
      high: quotes.high?.[i] ?? null,
      low: quotes.low?.[i] ?? null,
      close: quotes.close?.[i] ?? null,
      volume: quotes.volume?.[i] ?? 0,
    };
  }).filter((d: any) => d.open !== null && d.close !== null);

  // Deduplicate by time (keep last)
  const seen = new Map();
  for (const e of entries) seen.set(e.time, e);
  return [...seen.values()];
}

export async function searchSymbols(query: string) {
  const data = await fetchYahoo(
    `${BASE_URL}/v1/finance/search?q=${encodeURIComponent(query)}&quotesCount=8&newsCount=0`
  );
  return (data.quotes || [])
    .filter((q: any) => q.quoteType === 'EQUITY' || q.quoteType === 'ETF' || q.quoteType === 'INDEX' || q.quoteType === 'CRYPTOCURRENCY')
    .map((q: any) => ({
      symbol: q.symbol,
      name: q.longname || q.shortname || q.symbol,
    }));
}
