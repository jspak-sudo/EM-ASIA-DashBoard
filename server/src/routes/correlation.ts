import { Router } from 'express';
import { getChart } from '../yahooApi.js';

const router = Router();

function calcCorrelation(x: number[], y: number[]): number {
  const n = Math.min(x.length, y.length);
  if (n < 2) return 0;

  const meanX = x.slice(0, n).reduce((a, b) => a + b, 0) / n;
  const meanY = y.slice(0, n).reduce((a, b) => a + b, 0) / n;

  let sumXY = 0, sumX2 = 0, sumY2 = 0;
  for (let i = 0; i < n; i++) {
    const dx = x[i] - meanX;
    const dy = y[i] - meanY;
    sumXY += dx * dy;
    sumX2 += dx * dx;
    sumY2 += dy * dy;
  }

  const denom = Math.sqrt(sumX2 * sumY2);
  return denom === 0 ? 0 : sumXY / denom;
}

const RANGE_MAP: Record<string, { range: string; interval: string }> = {
  '1W': { range: '5d', interval: '15m' },
  '1M': { range: '1mo', interval: '1d' },
  '3M': { range: '3mo', interval: '1d' },
  '1Y': { range: '1y', interval: '1d' },
  '3Y': { range: '3y', interval: '1wk' },
  '5Y': { range: '5y', interval: '1wk' },
  'ALL': { range: 'max', interval: '1mo' },
};

router.get('/', async (req, res) => {
  try {
    const { symbol1, symbol2, period = '1Y' } = req.query as any;
    if (!symbol1 || !symbol2) {
      return res.status(400).json({ error: 'symbol1 and symbol2 required' });
    }

    const config = RANGE_MAP[period] || RANGE_MAP['1Y'];

    const [data1, data2] = await Promise.all([
      getChart(symbol1, config.range, config.interval),
      getChart(symbol2, config.range, config.interval),
    ]);

    // Align by date
    const map1 = new Map(data1.map((d: any) => [d.time, d.close]));
    const map2 = new Map(data2.map((d: any) => [d.time, d.close]));
    const commonDates = [...map1.keys()].filter((d) => map2.has(d)).sort();

    const prices1 = commonDates.map((d) => map1.get(d)!);
    const prices2 = commonDates.map((d) => map2.get(d)!);

    const correlation = calcCorrelation(prices1, prices2);

    const base1 = prices1[0] || 1;
    const base2 = prices2[0] || 1;

    const norm1 = commonDates.map((d, i) => ({ time: d, value: (prices1[i] / base1) * 100 }));
    const norm2 = commonDates.map((d, i) => ({ time: d, value: (prices2[i] / base2) * 100 }));

    res.json({ symbol1, symbol2, correlation, data1: norm1, data2: norm2 });
  } catch (error: any) {
    console.error('Correlation error:', error.message);
    res.status(500).json({ error: 'Failed to calculate correlation' });
  }
});

export default router;
