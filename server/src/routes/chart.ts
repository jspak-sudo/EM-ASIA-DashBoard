import { Router } from 'express';
import { getChart } from '../yahooApi.js';

const router = Router();

const PERIOD_MAP: Record<string, { range: string; interval: string }> = {
  '1W': { range: '5d', interval: '1h' },
  'YTD': { range: 'ytd', interval: '1d' },
  '1M': { range: '1mo', interval: '1d' },
  '3M': { range: '3mo', interval: '1d' },
  '1Y': { range: '1y', interval: '1d' },
  '3Y': { range: '3y', interval: '1wk' },
  '5Y': { range: '5y', interval: '1wk' },
  'ALL': { range: 'max', interval: '1mo' },
};

router.get('/:symbol', async (req, res) => {
  try {
    const { symbol } = req.params;
    const period = (req.query.period as string) || '1Y';
    const config = PERIOD_MAP[period] || PERIOD_MAP['1Y'];

    const data = await getChart(symbol, config.range, config.interval);
    res.json(data);
  } catch (error: any) {
    console.error('Chart error:', error.message);
    res.status(500).json({ error: 'Failed to fetch chart data' });
  }
});

export default router;
