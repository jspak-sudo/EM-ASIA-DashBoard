import { Router } from 'express';
import { getQuote, getChart } from '../yahooApi.js';

const router = Router();

const MACRO_SYMBOLS = [
  { symbol: '^TNX', name: '미국 10년 국채 금리' },
  { symbol: '^VIX', name: 'VIX 변동성 지수' },
  { symbol: 'DX-Y.NYB', name: '달러 인덱스 (DXY)' },
  { symbol: 'GC=F', name: '금 (Gold)' },
  { symbol: 'CL=F', name: '원유 (WTI)' },
  { symbol: '^GSPC', name: 'S&P 500' },
];

router.get('/', async (req, res) => {
  try {
    const results = await Promise.all(
      MACRO_SYMBOLS.map(async ({ symbol, name }) => {
        try {
          const [quote, chartData] = await Promise.all([
            getQuote(symbol),
            getChart(symbol, '1y', '1d'),
          ]);

          const data = chartData.map((d: any) => ({ time: d.time, value: d.close }));

          return {
            name,
            symbol,
            value: quote.regularMarketPrice,
            change: quote.regularMarketChange,
            changePercent: quote.regularMarketChangePercent,
            data,
          };
        } catch {
          return { name, symbol, value: 0, change: 0, changePercent: 0, data: [] };
        }
      })
    );

    res.json(results);
  } catch (error: any) {
    console.error('Macro error:', error.message);
    res.status(500).json({ error: 'Failed to fetch macro data' });
  }
});

export default router;
