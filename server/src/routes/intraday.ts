import { Router } from 'express';
import { getQuote, getChart } from '../yahooApi.js';

const router = Router();

const INDICES = [
  { symbol: '^KS11', name: 'KOSPI' },
  { symbol: '^KQ11', name: 'KOSDAQ' },
  { symbol: '^N225', name: '니케이 225' },
  { symbol: '1306.T', name: 'TOPIX' },
  { symbol: '000001.SS', name: '상해종합' },
  { symbol: '399001.SZ', name: '심천종합' },
  { symbol: '000300.SS', name: 'CSI 300' },
  { symbol: '^HSI', name: '항셍지수' },
  { symbol: 'HSTECH.HK', name: '항셍테크' },
  { symbol: '^TWII', name: '대만 가권' },
  { symbol: '^NSEI', name: 'Nifty 50' },
  { symbol: '^STI', name: 'STI' },
  { symbol: '^BVSP', name: 'IBOVESPA' },
];

router.get('/', async (req, res) => {
  try {
    const results = await Promise.all(
      INDICES.map(async ({ symbol, name }) => {
        try {
          const [quote, chart] = await Promise.all([
            getQuote(symbol),
            getChart(symbol, '1d', '5m'),
          ]);

          const intradayData = chart.map((d: any) => ({
            time: d.time,
            value: d.close,
          }));

          const prevClose = quote.regularMarketPrice - quote.regularMarketChange;

          return {
            symbol,
            name,
            price: quote.regularMarketPrice,
            change: quote.regularMarketChange,
            changePercent: quote.regularMarketChangePercent,
            prevClose,
            currency: quote.currency,
            marketState: quote.marketState,
            exchangeName: quote.exchangeName,
            baseDate: quote.baseDate,
            intradayData,
          };
        } catch {
          return {
            symbol, name,
            price: 0, change: 0, changePercent: 0,
            prevClose: 0, currency: 'USD',
            marketState: 'CLOSED', exchangeName: '', baseDate: null,
            intradayData: [],
          };
        }
      })
    );

    res.json(results);
  } catch (error: any) {
    console.error('Intraday error:', error.message);
    res.status(500).json({ error: 'Failed to fetch intraday data' });
  }
});

export default router;
