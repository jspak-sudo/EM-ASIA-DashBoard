import { Router } from 'express';
import { getQuote } from '../yahooApi.js';

const router = Router();

const FX_KRW = [
  { symbol: 'USDKRW=X', label: 'USD/KRW', name: '달러/원' },
  { symbol: 'CNYKRW=X', label: 'CNY/KRW', name: '위안/원' },
  { symbol: 'JPYKRW=X', label: 'JPY/KRW', name: '엔/원 (1¥)' },
  { symbol: 'INRKRW=X', label: 'INR/KRW', name: '루피/원' },
  { symbol: 'TWDKRW=X', label: 'TWD/KRW', name: '대만달러/원' },
  { symbol: 'AUDKRW=X', label: 'AUD/KRW', name: '호주달러/원' },
  { symbol: 'BRLKRW=X', label: 'BRL/KRW', name: '헤알/원' },
];

const FX_USD = [
  { symbol: 'USDKRW=X', label: 'USD/KRW', name: '달러/원' },
  { symbol: 'USDCNY=X', label: 'USD/CNY', name: '달러/위안' },
  { symbol: 'USDJPY=X', label: 'USD/JPY', name: '달러/엔' },
  { symbol: 'USDINR=X', label: 'USD/INR', name: '달러/루피' },
  { symbol: 'USDTWD=X', label: 'USD/TWD', name: '달러/대만달러' },
  { symbol: 'AUDUSD=X', label: 'AUD/USD', name: '호주달러/달러' },
  { symbol: 'USDBRL=X', label: 'USD/BRL', name: '달러/헤알' },
];

async function fetchFxData(items: typeof FX_KRW) {
  // Deduplicate symbols
  const uniqueSymbols = [...new Set(items.map(i => i.symbol))];
  const quotes = new Map();

  await Promise.all(uniqueSymbols.map(async (symbol) => {
    try {
      const q = await getQuote(symbol);
      quotes.set(symbol, q);
    } catch {
      quotes.set(symbol, null);
    }
  }));

  return items.map(item => {
    const q = quotes.get(item.symbol);
    return {
      symbol: item.symbol,
      label: item.label,
      name: item.name,
      price: q?.regularMarketPrice || 0,
      change: q?.regularMarketChange || 0,
      changePercent: q?.regularMarketChangePercent || 0,
      baseDate: q?.baseDate || null,
    };
  });
}

router.get('/', async (req, res) => {
  try {
    const [krw, usd] = await Promise.all([
      fetchFxData(FX_KRW),
      fetchFxData(FX_USD),
    ]);
    res.json({ krw, usd });
  } catch (error: any) {
    console.error('FX error:', error.message);
    res.status(500).json({ error: 'Failed to fetch FX data' });
  }
});

export default router;
