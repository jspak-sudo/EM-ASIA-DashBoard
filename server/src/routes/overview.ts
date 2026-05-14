import { Router } from 'express';
import { getQuote, getChart } from '../yahooApi.js';
import { getSinaSymbol, getSinaQuote, getSinaHistory } from '../sinaApi.js';
import { getNaverSymbol, getNaverHistory, type NaverPriceEntry } from '../naverApi.js';

const router = Router();

// type: 'index' | 'fx'
const ITEMS = [
  // 중국
  { symbol: '000001.SS', name: '상해종합', group: '🇨🇳 중국', type: 'index' },
  { symbol: '000688.SS', name: '과창판 50 (STAR 50)', group: '🇨🇳 중국', type: 'index' },
  { symbol: '399001.SZ', name: '심천성분', group: '🇨🇳 중국', type: 'index' },
  { symbol: '399006.SZ', name: '차이넥스트 (ChiNext)', group: '🇨🇳 중국', type: 'index' },
  { symbol: '000300.SS', name: 'CSI 300', group: '🇨🇳 중국', type: 'index' },
  { symbol: 'USDCNY=X', name: 'USD/CNY', group: '🇨🇳 중국', type: 'fx' },
  // 홍콩
  { symbol: '^HSI', name: '항셍지수', group: '🇭🇰 홍콩', type: 'index' },
  { symbol: 'HSTECH.HK', name: '항셍테크', group: '🇭🇰 홍콩', type: 'index' },
  { symbol: 'USDHKD=X', name: 'USD/HKD', group: '🇭🇰 홍콩', type: 'fx' },
  { symbol: 'HKDKRW=X', name: 'HKD/KRW', group: '🇭🇰 홍콩', type: 'fx' },
  // 일본
  { symbol: '^N225', name: '니케이 225', group: '🇯🇵 일본', type: 'index' },
  { symbol: '2625.T', name: 'TOPIX(ETF)', group: '🇯🇵 일본', type: 'index' },
  { symbol: 'USDJPY=X', name: 'USD/JPY', group: '🇯🇵 일본', type: 'fx' },
  { symbol: 'JPYKRW=X', name: 'JPY/KRW', group: '🇯🇵 일본', type: 'fx' },
  // 한국
  { symbol: '^KS11', name: 'KOSPI', group: '🇰🇷 한국', type: 'index' },
  { symbol: '^KQ11', name: 'KOSDAQ', group: '🇰🇷 한국', type: 'index' },
  // 대만
  { symbol: '^TWII', name: '대만 가권', group: '🇹🇼 대만', type: 'index' },
  { symbol: 'USDTWD=X', name: 'USD/TWD', group: '🇹🇼 대만', type: 'fx' },
  { symbol: 'TWDKRW=X', name: 'TWD/KRW', group: '🇹🇼 대만', type: 'fx' },
  // 인도
  { symbol: '^NSEI', name: 'Nifty 50', group: '🇮🇳 인도', type: 'index' },
  { symbol: 'USDINR=X', name: 'USD/INR', group: '🇮🇳 인도', type: 'fx' },
  { symbol: 'INRKRW=X', name: 'INR/KRW', group: '🇮🇳 인도', type: 'fx' },
  // 싱가포르
  { symbol: '^STI', name: 'STI', group: '🇸🇬 싱가포르', type: 'index' },
  { symbol: 'USDSGD=X', name: 'USD/SGD', group: '🇸🇬 싱가포르', type: 'fx' },
  { symbol: 'SGDKRW=X', name: 'SGD/KRW', group: '🇸🇬 싱가포르', type: 'fx' },
  // 호주
  { symbol: 'AUDUSD=X', name: 'AUD/USD', group: '🇦🇺 호주', type: 'fx' },
  { symbol: 'AUDKRW=X', name: 'AUD/KRW', group: '🇦🇺 호주', type: 'fx' },
  // 브라질
  { symbol: '^BVSP', name: 'IBOVESPA', group: '🇧🇷 브라질', type: 'index' },
  { symbol: 'USDBRL=X', name: 'USD/BRL', group: '🇧🇷 브라질', type: 'fx' },
  // 미국
  { symbol: '^GSPC', name: 'S&P 500', group: '🇺🇸 미국', type: 'index' },
  { symbol: '^IXIC', name: 'NASDAQ', group: '🇺🇸 미국', type: 'index' },
  { symbol: '^SOX', name: '필라델피아 반도체', group: '🇺🇸 미국', type: 'index' },
  { symbol: 'USDKRW=X', name: 'USD/KRW', group: '🇺🇸 미국', type: 'fx' },
];

function addOneDay(dateStr: string): string {
  const d = new Date(dateStr);
  d.setDate(d.getDate() + 1);
  return d.toISOString().split('T')[0];
}

// 거래소별 장 마감 시간 (현지시간 기준)
const MARKET_CLOSE_TIMES: Record<string, { localClose: string; tz: string; tzShort: string }> = {
  // 중국
  '000001.SS': { localClose: '15:00', tz: 'Asia/Shanghai', tzShort: 'CST' },
  '000688.SS': { localClose: '15:00', tz: 'Asia/Shanghai', tzShort: 'CST' },
  '399001.SZ': { localClose: '15:00', tz: 'Asia/Shanghai', tzShort: 'CST' },
  '399006.SZ': { localClose: '15:00', tz: 'Asia/Shanghai', tzShort: 'CST' },
  '000300.SS': { localClose: '15:00', tz: 'Asia/Shanghai', tzShort: 'CST' },
  // 홍콩
  '^HSI': { localClose: '16:00', tz: 'Asia/Hong_Kong', tzShort: 'HKT' },
  'HSTECH.HK': { localClose: '16:00', tz: 'Asia/Hong_Kong', tzShort: 'HKT' },
  // 일본
  '^N225': { localClose: '15:30', tz: 'Asia/Tokyo', tzShort: 'JST' },
  '2625.T': { localClose: '15:30', tz: 'Asia/Tokyo', tzShort: 'JST' },
  // 한국
  '^KS11': { localClose: '15:30', tz: 'Asia/Seoul', tzShort: 'KST' },
  '^KQ11': { localClose: '15:30', tz: 'Asia/Seoul', tzShort: 'KST' },
  // 대만
  '^TWII': { localClose: '13:30', tz: 'Asia/Taipei', tzShort: 'CST' },
  // 인도
  '^NSEI': { localClose: '15:30', tz: 'Asia/Kolkata', tzShort: 'IST' },
  // 싱가포르
  '^STI': { localClose: '17:00', tz: 'Asia/Singapore', tzShort: 'SGT' },
  // 브라질
  '^BVSP': { localClose: '17:00', tz: 'America/Sao_Paulo', tzShort: 'BRT' },
  // 미국
  '^GSPC': { localClose: '16:00', tz: 'America/New_York', tzShort: 'ET' },
  '^IXIC': { localClose: '16:00', tz: 'America/New_York', tzShort: 'ET' },
  '^SOX': { localClose: '16:00', tz: 'America/New_York', tzShort: 'ET' },
  // FX — 심볼별 개별 설정 (kstTime/localTime 직접 지정)
  // closeDate는 이미 +1일 보정된 날짜가 들어옴 (예: 4/8)
  'USDKRW=X': { localClose: '17:00', tz: 'America/New_York', tzShort: 'ET' },
  'USDCNY=X': { localClose: '17:00', tz: 'America/New_York', tzShort: 'ET' },
  'USDJPY=X': { localClose: '17:00', tz: 'America/New_York', tzShort: 'ET' },
  'USDINR=X': { localClose: '17:00', tz: 'America/New_York', tzShort: 'ET' },
  'USDTWD=X': { localClose: '17:00', tz: 'America/New_York', tzShort: 'ET' },
  'USDHKD=X': { localClose: '17:00', tz: 'America/New_York', tzShort: 'ET' },
  'USDSGD=X': { localClose: '17:00', tz: 'America/New_York', tzShort: 'ET' },
  'USDBRL=X': { localClose: '17:00', tz: 'America/New_York', tzShort: 'ET' },
  'AUDUSD=X': { localClose: '17:00', tz: 'America/New_York', tzShort: 'ET' },
  'JPYKRW=X': { localClose: '17:00', tz: 'America/New_York', tzShort: 'ET' },
  'HKDKRW=X': { localClose: '17:00', tz: 'America/New_York', tzShort: 'ET' },
  'TWDKRW=X': { localClose: '17:00', tz: 'America/New_York', tzShort: 'ET' },
  'INRKRW=X': { localClose: '17:00', tz: 'America/New_York', tzShort: 'ET' },
  'SGDKRW=X': { localClose: '17:00', tz: 'America/New_York', tzShort: 'ET' },
  'AUDKRW=X': { localClose: '17:00', tz: 'America/New_York', tzShort: 'ET' },
};

// FX 날짜 보정: closeDate가 이미 +1일 보정됨 → 현지시간은 전일
const FX_KST_OVERRIDE: Record<string, { kstHour: string; localDateOffset: number; localHour: string; localTz: string }> = {
  'USDKRW=X': { kstHour: '06:00', localDateOffset: -1, localHour: '17:00', localTz: 'ET' },
  // 아래는 검증 전 기본값 (USD/KRW와 동일 구조, 추후 개별 수정 가능)
  'USDCNY=X': { kstHour: '06:00', localDateOffset: -1, localHour: '17:00', localTz: 'ET' },
  'USDJPY=X': { kstHour: '06:00', localDateOffset: -1, localHour: '17:00', localTz: 'ET' },
  'USDINR=X': { kstHour: '06:00', localDateOffset: -1, localHour: '17:00', localTz: 'ET' },
  'USDTWD=X': { kstHour: '06:00', localDateOffset: -1, localHour: '17:00', localTz: 'ET' },
  'USDHKD=X': { kstHour: '06:00', localDateOffset: -1, localHour: '17:00', localTz: 'ET' },
  'USDSGD=X': { kstHour: '06:00', localDateOffset: -1, localHour: '17:00', localTz: 'ET' },
  'USDBRL=X': { kstHour: '06:00', localDateOffset: -1, localHour: '17:00', localTz: 'ET' },
  'AUDUSD=X': { kstHour: '06:00', localDateOffset: -1, localHour: '17:00', localTz: 'ET' },
  'JPYKRW=X': { kstHour: '06:00', localDateOffset: -1, localHour: '17:00', localTz: 'ET' },
  'HKDKRW=X': { kstHour: '06:00', localDateOffset: -1, localHour: '17:00', localTz: 'ET' },
  'TWDKRW=X': { kstHour: '06:00', localDateOffset: -1, localHour: '17:00', localTz: 'ET' },
  'INRKRW=X': { kstHour: '06:00', localDateOffset: -1, localHour: '17:00', localTz: 'ET' },
  'SGDKRW=X': { kstHour: '06:00', localDateOffset: -1, localHour: '17:00', localTz: 'ET' },
  'AUDKRW=X': { kstHour: '06:00', localDateOffset: -1, localHour: '17:00', localTz: 'ET' },
};

function getCloseTimeInfo(symbol: string, closeDate: string | null, isFx: boolean) {
  if (!closeDate) return { closeLocalTime: null, closeKST: null, closeTzShort: null };

  // FX: 심볼별 개별 설정 사용
  const fxOverride = FX_KST_OVERRIDE[symbol];
  if (isFx && fxOverride) {
    const localDate = new Date(closeDate);
    localDate.setDate(localDate.getDate() + fxOverride.localDateOffset);
    const localDateStr = localDate.toISOString().split('T')[0];
    return {
      closeLocalTime: localDateStr.slice(5) + ' ' + fxOverride.localHour,
      closeKST: closeDate.slice(5) + ' ' + fxOverride.kstHour,
      closeTzShort: fxOverride.localTz,
    };
  }

  const info = MARKET_CLOSE_TIMES[symbol];
  if (!info) return { closeLocalTime: closeDate.slice(5), closeKST: null, closeTzShort: null };

  // Build a Date object for the close time in local tz
  const localCloseStr = closeDate + 'T' + info.localClose + ':00';
  const closeLocal = info.tz === 'Asia/Seoul'
    ? closeDate.slice(5) + ' ' + info.localClose
    : closeDate.slice(5) + ' ' + info.localClose;

  // Convert to KST
  // Create a date, then format in both timezones
  // We need to parse the local time properly
  const fakeUtc = new Date(localCloseStr + 'Z'); // treat as UTC temporarily
  // Actually, let's just compute the KST offset
  // 동적 UTC offset 계산 (서머타임 자동 반영)
  function getUtcOffset(tz: string, dateStr: string): number {
    const d = new Date(dateStr + 'T12:00:00Z');
    const utcStr = d.toLocaleString('en-US', { timeZone: 'UTC' });
    const localStr = d.toLocaleString('en-US', { timeZone: tz });
    const utcTime = new Date(utcStr).getTime();
    const localTime = new Date(localStr).getTime();
    return (localTime - utcTime) / 3600000;
  }

  const localOffset = getUtcOffset(info.tz, closeDate);
  const kstOffset = 9;
  const diffHours = kstOffset - localOffset;

  const [hh, mm] = info.localClose.split(':').map(Number);
  const totalMinutes = (hh + diffHours) * 60 + mm + Math.round((diffHours % 1) * 60);

  // KST 날짜/시간 계산
  const baseDate = new Date(closeDate + 'T00:00:00Z');
  let kstDay: string;
  let kstHour: number;
  let kstMin: number;

  if (totalMinutes >= 24 * 60) {
    // 다음 날로 넘어감
    const nextDay = new Date(baseDate);
    nextDay.setUTCDate(nextDay.getUTCDate() + 1);
    kstDay = (nextDay.getUTCMonth() + 1).toString().padStart(2, '0') + '-' + nextDay.getUTCDate().toString().padStart(2, '0');
    kstHour = Math.floor((totalMinutes - 24 * 60) / 60);
    kstMin = (totalMinutes - 24 * 60) % 60;
  } else if (totalMinutes < 0) {
    const prevDay = new Date(baseDate);
    prevDay.setUTCDate(prevDay.getUTCDate() - 1);
    kstDay = (prevDay.getUTCMonth() + 1).toString().padStart(2, '0') + '-' + prevDay.getUTCDate().toString().padStart(2, '0');
    kstHour = Math.floor((totalMinutes + 24 * 60) / 60);
    kstMin = (totalMinutes + 24 * 60) % 60;
  } else {
    kstDay = closeDate.slice(5);
    kstHour = Math.floor(totalMinutes / 60);
    kstMin = totalMinutes % 60;
  }

  const kstTime = kstDay + ' ' + String(kstHour).padStart(2, '0') + ':' + String(kstMin).padStart(2, '0');
  const localTime = closeDate.slice(5) + ' ' + info.localClose;

  return {
    closeLocalTime: localTime,
    closeKST: kstTime,
    closeTzShort: info.tzShort,
  };
}

function calcReturn(data: any[], daysBack: number | null): number | null {
  if (!data || data.length < 2) return null;
  const latest = data[data.length - 1].close;
  let base: number;
  if (daysBack === null) {
    base = data[0].close;
  } else {
    const idx = Math.max(0, data.length - daysBack - 1);
    base = data[idx].close;
  }
  if (!base) return null;
  return ((latest - base) / base) * 100;
}

// 2분 캐시 (메인) — 30초였으나 264-concurrent-HTTP 부하 경감
let _cache: { data: any; time: number } | null = null;
const CACHE_TTL = 120000;

// 1시간 캐시 (장기 수익률: 3Y/5Y/10Y)
const _longTermCache = new Map<string, { data: any; time: number }>();
const LONG_CACHE_TTL = 3600000;

async function getLongTermCharts(symbol: string) {
  const cached = _longTermCache.get(symbol);
  if (cached && Date.now() - cached.time < LONG_CACHE_TTL) return cached.data;
  const [chart3y, chart5y, chart10y] = await Promise.all([
    getChart(symbol, '3y', '1wk'),
    getChart(symbol, '5y', '1wk'),
    getChart(symbol, '10y', '1mo'),
  ]);
  const data = { chart3y, chart5y, chart10y };
  _longTermCache.set(symbol, { data, time: Date.now() });
  return data;
}

router.get('/', async (req, res) => {
  try {
    if (_cache && Date.now() - _cache.time < CACHE_TTL) {
      return res.json(_cache.data);
    }
    const results = await Promise.all(
      ITEMS.map(async ({ symbol, name, group, type }) => {
        try {
          const [quote, chart10d, chartYtd, chart1mo, chart3mo, chart6mo, chart1y, longTerm] = await Promise.all([
            getQuote(symbol),
            getChart(symbol, '10d', '1d'),
            getChart(symbol, 'ytd', '1d'),
            getChart(symbol, '1mo', '1d'),
            getChart(symbol, '3mo', '1d'),
            getChart(symbol, '6mo', '1d'),
            getChart(symbol, '1y', '1d'),
            getLongTermCharts(symbol),
          ]);
          const { chart3y, chart5y, chart10y } = longTerm;

          const isOpen = quote.marketState === 'OPEN';
          const isFx = type === 'fx';
          const today = new Date().toISOString().split('T')[0];
          let quotePrevClose = quote.prevClose;

          // 중국 시장: Sina Finance로 prevClose 보충 (Yahoo가 자주 누락)
          const isChinaIndex = getSinaSymbol(symbol) !== null;
          let sinaData: { prevClose?: number; price?: number; history?: any[] } = {};
          if (isChinaIndex) {
            try {
              const [sinaQuote, sinaHist] = await Promise.all([
                getSinaQuote(symbol),
                getSinaHistory(symbol, 30),
              ]);
              if (sinaQuote) {
                sinaData.prevClose = sinaQuote.prevClose;
                sinaData.price = sinaQuote.price;
                // Sina prevClose가 Yahoo보다 정확 (Yahoo가 4/8 누락하는 경우)
                quotePrevClose = sinaQuote.prevClose;
              }
              if (sinaHist && sinaHist.length > 0) {
                sinaData.history = sinaHist;
              }
            } catch (e) {
              console.error(`Sina supplement failed for ${symbol}:`, (e as any).message);
            }
          }

          // 한국 시장: Naver Finance로 보충 (Yahoo 4/8 누락 보완)
          const isKoreaIndex = getNaverSymbol(symbol) !== null;
          let naverData: NaverPriceEntry[] = [];
          if (isKoreaIndex) {
            try {
              naverData = await getNaverHistory(symbol, 30);
            } catch (e) {
              console.error(`Naver supplement failed for ${symbol}:`, (e as any).message);
            }
          }

          // Filter: exclude today's incomplete data and NULLs
          function filterChart(chartData: any[]) {
            if (!chartData || chartData.length === 0) return [];
            return chartData.filter((d: any) => {
              if (d.close == null) return false;
              if (isOpen && d.time === today) return false;
              return true;
            });
          }

          const closedChart = filterChart(chart10d);
          const closes = closedChart.map((d: any) => d.close);

          // === 핵심 로직 (단순화) ===
          // Yahoo API 규칙:
          //   장 마감: regularMarketPrice = 당일 종가, prevClose = 전일 종가
          //   장 개장: regularMarketPrice = 실시간가, prevClose = 어제 종가
          //
          // 현재가(종가) = 가장 최근 확정된 종가
          // 실시간 = 장 개장 중일 때만, 종가 대비 현재 수익률
          // 1D = 최근 종가 vs 전일 종가

          let closePrice: number;  // 가장 최근 확정 종가
          let prevCloseForCalc: number | null; // 1D 계산용 전일 종가

          // 한국 시장: Naver Finance (가장 정확)
          // Naver price API는 날짜 내림차순이며, 장중에는 [0]=오늘 실시간가, [1]=어제 확정종가
          // 장 마감 후: [0]=오늘 확정종가, [1]=어제 확정종가
          if (isKoreaIndex && naverData.length >= 2) {
            if (isOpen) {
              // 장중: closePrice = 어제 확정종가(기준값), realtime은 Yahoo 실시간 vs 어제 종가
              // naverData[0].changePercent = Naver가 계산한 오늘 등락률 (정확)
              closePrice = naverData[1].close;        // 어제 확정종가
              prevCloseForCalc = naverData[2]?.close ?? null;  // 그제 (1D fallback용)
            } else {
              // 장 마감: [0]=오늘 확정종가, [1]=어제 확정종가
              closePrice = naverData[0].close;
              prevCloseForCalc = naverData[1].close;
            }
          }
          // Sina 지원 종목 (중국/홍콩): Sina quote + history 조합
          else if (isChinaIndex && sinaData.prevClose) {
            if (isOpen) {
              // 장 개장: Sina prevClose = 어제 종가 = 현재가(종가)
              // Sina history 마지막 = 어제 종가 (history가 있으면 prevClose 이전도 가능)
              closePrice = sinaData.prevClose;
              if (sinaData.history && sinaData.history.length >= 2) {
                prevCloseForCalc = sinaData.history[sinaData.history.length - 2].close;
              } else {
                prevCloseForCalc = null;
              }
            } else {
              // 장 마감: Sina quote.price = 오늘 종가, Sina prevClose = 어제 종가
              closePrice = sinaData.price || quote.regularMarketPrice;
              prevCloseForCalc = sinaData.prevClose;
            }
          } else if (isOpen) {
            const chartLast = closes.length >= 1 ? closes[closes.length - 1] : null;
            const chartSecondLast = closes.length >= 2 ? closes[closes.length - 2] : null;

            if (isFx) {
              closePrice = chartLast || quotePrevClose || quote.regularMarketPrice;
              prevCloseForCalc = chartSecondLast || quotePrevClose;
            } else if (chartLast && quotePrevClose && Math.abs(quotePrevClose - chartLast) > 0.5) {
              closePrice = Math.max(quotePrevClose, chartLast);
              prevCloseForCalc = Math.min(quotePrevClose, chartLast);
            } else if (chartLast) {
              closePrice = chartLast;
              prevCloseForCalc = chartSecondLast || quotePrevClose;
            } else {
              closePrice = quotePrevClose || quote.regularMarketPrice;
              prevCloseForCalc = null;
            }
          } else {
            closePrice = quote.regularMarketPrice;
            prevCloseForCalc = quotePrevClose;
          }

          // 1D fallback
          if (!prevCloseForCalc && quotePrevClose && closePrice && Math.abs(closePrice - quotePrevClose) > 0.01) {
            prevCloseForCalc = quotePrevClose;
          }
          // 최종 fallback: Yahoo의 자체 1D 사용 (차트 데이터 없는 종목)
          let ret1D: number | null = (closePrice && prevCloseForCalc && Math.abs(prevCloseForCalc) > 0.0001)
            ? ((closePrice - prevCloseForCalc) / prevCloseForCalc) * 100
            : null;
          if (ret1D === null && quote.regularMarketChangePercent != null) {
            ret1D = quote.regularMarketChangePercent;
          }

          // 한국 장중: Naver의 오늘 등락률이 가장 정확 (두 소스 간 시차 오류 방지)
          if (isKoreaIndex && isOpen && naverData.length >= 1 && naverData[0].changePercent != null) {
            ret1D = naverData[0].changePercent;
          }

          // 1W: closePrice vs ~5 trading days ago
          let ret1W: number | null = null;
          if (isKoreaIndex && naverData.length >= 6) {
            // 장중: [0]=오늘 실시간, [1]=어제, [6]=5거래일 전
            // 장 마감: [0]=오늘 확정, [5]=5거래일 전
            const nBase = isOpen ? naverData[6]?.close : naverData[5].close;
            const nHead = naverData[0].close; // 오늘 실시간 or 확정
            if (nBase) ret1W = ((nHead - nBase) / nBase) * 100;
          } else if (isChinaIndex && sinaData.history && sinaData.history.length >= 6) {
            const sh = sinaData.history;
            const base = sh[sh.length - 6].close;
            ret1W = ((closePrice - base) / base) * 100;
          } else {
            const close5dAgo = closes.length >= 5 ? closes[closes.length - 5] : (closes.length >= 2 ? closes[0] : null);
            ret1W = (closePrice && close5dAgo) ? ((closePrice - close5dAgo) / close5dAgo) * 100 : null;
          }

          // 장기 수익률의 종점 가격
          // 한국 장중: naverData[0].close = 오늘 실시간가 (closePrice는 어제 종가로 교체됐으므로)
          // 그 외: closePrice 그대로 사용
          const headPrice = (isKoreaIndex && isOpen && naverData.length >= 1)
            ? naverData[0].close
            : closePrice;

          // Longer periods: 마지막 값 = headPrice로 보정
          function calcReturnWithClose(chartData: any[], useOpen?: boolean): number | null {
            const filtered = filterChart(chartData);
            if (filtered.length < 1) return null;
            const first = useOpen ? (filtered[0].open || filtered[0].close) : filtered[0].close;
            if (!first) return null;
            return ((headPrice - first) / first) * 100;
          }

          // 연평균 수익률 계산: total return / years
          function annualized(chartData: any[], years: number): number | null {
            const total = calcReturnWithClose(chartData);
            if (total === null) return null;
            return total / years;
          }

          let returns: Record<string, number | null> = {
            '1D': ret1D,
            '1W': ret1W,
            'YTD': calcReturnWithClose(chartYtd, true),
            '1M': calcReturnWithClose(chart1mo),
            '3M': calcReturnWithClose(chart3mo),
            '6M': calcReturnWithClose(chart6mo),
            '1Y': calcReturnWithClose(chart1y),
            '3Y/A': annualized(chart3y, 3),
            '5Y/A': annualized(chart5y, 5),
            '10Y/A': annualized(chart10y, 10),
          };

          // HSTECH.HK: Yahoo 히스토리 없음 → 3088.HK ETF 수익률로 대용
          if (symbol === 'HSTECH.HK') {
            const hasGaps = Object.values(returns).some((v, i) => i > 0 && v === null);
            if (hasGaps) {
              try {
                const proxySymbol = '3088.HK';
                const [p5d, pytd, p1mo, p3mo, p6mo, p1y, p3y, p5y] = await Promise.all([
                  getChart(proxySymbol, '10d', '1d'), getChart(proxySymbol, 'ytd', '1d'),
                  getChart(proxySymbol, '1mo', '1d'), getChart(proxySymbol, '3mo', '1d'),
                  getChart(proxySymbol, '6mo', '1d'), getChart(proxySymbol, '1y', '1d'),
                  getChart(proxySymbol, '3y', '1wk'), getChart(proxySymbol, '5y', '1wk'),
                ]);
                const pFilter = (d: any[]) => filterChart(d);
                const pCalc = (d: any[]) => { const f = pFilter(d); return f.length >= 2 ? ((f[f.length-1].close - f[0].close) / f[0].close) * 100 : null; };
                if (returns['1W'] === null) returns['1W'] = pCalc(p5d);
                if (returns['YTD'] === null) returns['YTD'] = pCalc(pytd);
                if (returns['1M'] === null) returns['1M'] = pCalc(p1mo);
                if (returns['3M'] === null) returns['3M'] = pCalc(p3mo);
                if (returns['6M'] === null) returns['6M'] = pCalc(p6mo);
                if (returns['1Y'] === null) returns['1Y'] = pCalc(p1y);
                if (returns['3Y/A'] === null) { const r = pCalc(p3y); if (r !== null) returns['3Y/A'] = r / 3; }
                if (returns['5Y/A'] === null) { const r = pCalc(p5y); if (r !== null) returns['5Y/A'] = r / 5; }
              } catch {}
            }
          }

          // 실시간: 장 개장 중일 때만
          const livePrice = isOpen ? quote.regularMarketPrice : null;
          const realtime = (isOpen && closePrice > 0)
            ? ((quote.regularMarketPrice - closePrice) / closePrice) * 100
            : null;
          const realtimePrevClose = isOpen ? closePrice : null;

          // Timestamps
          const realtimeKST = isOpen ? quote.timeKST : null;
          const realtimeLocal = isOpen ? quote.timeLocal : null;
          const tzShort = quote.tzShort || '';

          // === 종가 기준일 결정 ===
          // 원칙: closePrice가 어느 날짜의 종가인지 정확히 표시
          // regularMarketTime = Yahoo가 제공하는 실제 마지막 거래 시각 (가장 정확)
          let lastCloseDate: string | null = null;

          if (!isOpen && quote.regularMarketTime) {
            // 장 마감: regularMarketTime = 실제 마지막 거래일 (휴장일 자동 반영)
            const rmt = new Date(quote.regularMarketTime * 1000);
            const localTz = quote.timezone || 'UTC';
            lastCloseDate = rmt.toLocaleDateString('en-CA', { timeZone: localTz });
          } else if (isOpen) {
            // 장 개장 중: closePrice = 전일 종가 → 차트의 마지막 날짜 사용
            if (isChinaIndex && sinaData.history && sinaData.history.length >= 1) {
              lastCloseDate = sinaData.history[sinaData.history.length - 1].day;
            } else if (isKoreaIndex && naverData.length >= 2) {
              // Naver [0]=오늘(아직 미확정), [1]=어제 → closePrice는 [0].close이므로 [0].date
              // 하지만 장중 closePrice = naverData[0].close = 전일종가이므로 차트 기준 사용
              const chartLastDate = closedChart.length >= 1 ? closedChart[closedChart.length - 1].time : null;
              lastCloseDate = chartLastDate || naverData[1]?.date || null;
            } else {
              const chartLastDate = closedChart.length >= 1 ? closedChart[closedChart.length - 1].time : null;
              if (chartLastDate) {
                lastCloseDate = chartLastDate;
              } else if (quote.regularMarketTime) {
                const rmt = new Date(quote.regularMarketTime * 1000);
                const localTz = quote.timezone || 'UTC';
                const localDate = rmt.toLocaleDateString('en-CA', { timeZone: localTz });
                const d = new Date(localDate);
                d.setDate(d.getDate() - 1);
                lastCloseDate = d.toISOString().split('T')[0];
              }
            }
          }

          // FX: 차트 날짜가 하루 밀려있으므로 +1일 보정
          const closeDateForDisplay = (isFx && lastCloseDate) ? addOneDay(lastCloseDate) : lastCloseDate;

          const closeTimeInfo = getCloseTimeInfo(symbol, closeDateForDisplay, isFx);

          return {
            symbol, name, group, type,
            livePrice,
            closePrice,
            realtime,
            realtimePrevClose,
            realtimeKST,
            realtimeLocal,
            tzShort,
            closeBase: closeDateForDisplay,
            closeBaseAdj: closeDateForDisplay,
            closeLocalTime: closeTimeInfo.closeLocalTime,
            closeKST: closeTimeInfo.closeKST,
            closeTzShort: closeTimeInfo.closeTzShort,
            prevBase: closedChart.length >= 2 ? closedChart[closedChart.length - 2].time : null,
            weekBase: closedChart.length >= 5 ? closedChart[closedChart.length - 5].time : null,
            baseDate: quote.baseDate,
            marketState: quote.marketState,
            timezone: quote.timezone,
            tradingPeriod: quote.tradingPeriod,
            returns,
          };
        } catch (e) {
          console.error(`Overview fetch failed for ${symbol}:`, (e as any).message);
          return {
            symbol, name, group, type,
            livePrice: null, closePrice: 0,
            realtime: null, realtimePrevClose: null,
            realtimeKST: null, realtimeLocal: null, tzShort: '',
            closeBase: null, closeBaseAdj: null,
            closeLocalTime: null, closeKST: null, closeTzShort: null,
            prevBase: null, weekBase: null,
            baseDate: null, marketState: 'CLOSED', returns: {},
          };
        }
      })
    );

    // === Synthetic cross rates: XXX/KRW = USDKRW / USDXXX ===
    const usdkrw = results.find((r: any) => r.symbol === 'USDKRW=X');
    const synthetics = [
      { usdXxx: 'USDCNY=X', name: 'CNY/KRW', group: '🇨🇳 중국', insertAfter: 'USDCNY=X' },
      { usdXxx: 'USDBRL=X', name: 'BRL/KRW', group: '🇧🇷 브라질', insertAfter: 'USDBRL=X' },
    ];

    for (const synth of synthetics) {
      const usdXxx = results.find((r: any) => r.symbol === synth.usdXxx);
      if (!usdkrw || !usdXxx) continue;

      // Calculate cross rate for each period
      function synthReturn(period: string): number | null {
        const krwRet = usdkrw.returns?.[period];
        const xxxRet = usdXxx.returns?.[period];
        if (krwRet == null || xxxRet == null) return null;
        // XXX/KRW = USDKRW / USDXXX
        // If USDKRW goes up 2% and USDCNY goes up 1%, then CNY/KRW goes up ~1%
        // Exact: (1+krw%)/(1+xxx%) - 1
        return ((1 + krwRet / 100) / (1 + xxxRet / 100) - 1) * 100;
      }

      const liveKrw = usdkrw.livePrice;
      const liveXxx = usdXxx.livePrice;
      const closeKrw = usdkrw.closePrice || 0;
      const closeXxx = usdXxx.closePrice || 1;

      const synthItem = {
        symbol: synth.name.replace('/', '') + '=X',
        name: synth.name,
        group: synth.group,
        type: 'fx',
        livePrice: (liveKrw && liveXxx) ? liveKrw / liveXxx : null,
        closePrice: closeXxx > 0 ? closeKrw / closeXxx : 0,
        realtime: (usdkrw.realtime != null && usdXxx.realtime != null)
          ? ((1 + usdkrw.realtime / 100) / (1 + usdXxx.realtime / 100) - 1) * 100
          : null,
        realtimeChange: null,
        realtimeBase: usdkrw.realtimeBase,
        closeBase: usdkrw.closeBase,
        prevBase: null,
        weekBase: null,
        baseDate: usdkrw.baseDate,
        marketState: usdkrw.marketState,
        returns: {
          '1D': synthReturn('1D'),
          '1W': synthReturn('1W'),
          'YTD': synthReturn('YTD'),
          '1M': synthReturn('1M'),
          '3M': synthReturn('3M'),
          '6M': synthReturn('6M'),
          '1Y': synthReturn('1Y'),
        },
      };

      // Insert after the USDXXX row
      const insertIdx = results.findIndex((r: any) => r.symbol === synth.insertAfter);
      if (insertIdx >= 0) {
        results.splice(insertIdx + 1, 0, synthItem as any);
      } else {
        results.push(synthItem as any);
      }
    }

    // 그룹별 장 시간: Yahoo tradingPeriod에서 동적 생성 (서머타임 자동 반영)
    const KST = 'Asia/Seoul';
    const fmtHM = (ts: number, tz: string) => new Date(ts * 1000).toLocaleTimeString('ko-KR', { timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false });

    // 점심시간 정보 (하드코딩 — 동적 제공 불가)
    const lunchBreaks: Record<string, string> = {
      '🇨🇳 중국': ', 점심 12:30~14:00 KST (11:30~13:00 CST)',
      '🇭🇰 홍콩': ', 점심 13:00~14:00 KST (12:00~13:00 HKT)',
    };

    // 각 그룹의 대표 지수에서 tradingPeriod 추출
    const groupRepresentative: Record<string, string> = {
      '🇨🇳 중국': '000001.SS', '🇭🇰 홍콩': '^HSI', '🇯🇵 일본': '^N225',
      '🇰🇷 한국': '^KS11', '🇹🇼 대만': '^TWII', '🇮🇳 인도': '^NSEI',
      '🇸🇬 싱가포르': '^STI', '🇧🇷 브라질': '^BVSP',
      '🇺🇸 미국': '^GSPC',
    };

    const groupMeta: Record<string, string> = {};
    for (const [group, repSymbol] of Object.entries(groupRepresentative)) {
      const item = results.find((r: any) => r.symbol === repSymbol);
      const tp = item?.tradingPeriod;
      if (tp) {
        const tz = item.timezone || 'UTC';
        const tzLabel = item.tzShort || '';
        const startKST = fmtHM(tp.start, KST);
        let endKST = fmtHM(tp.end, KST);
        const startLocal = fmtHM(tp.start, tz);
        let endLocal = fmtHM(tp.end, tz);
        const lunch = lunchBreaks[group] || '';

        // 홍콩: Yahoo가 16:10(경매) 반환 → 정규장 16:00으로 표시
        if (group === '🇭🇰 홍콩') {
          endLocal = '16:00';
          endKST = '17:00';
        }

        if (tz === KST) {
          groupMeta[group] = `${startKST}~${endKST} KST${lunch}`;
        } else {
          groupMeta[group] = `${startKST}~${endKST} KST (${startLocal}~${endLocal} ${tzLabel})${lunch}`;
        }
      }
    }

    const response = { items: results, groupMeta };
    _cache = { data: response, time: Date.now() };
    res.json(response);
  } catch (error: any) {
    console.error('Overview error:', error.message);
    res.status(500).json({ error: 'Failed to fetch overview data' });
  }
});

export default router;
