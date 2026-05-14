import { Router } from 'express';
import { getChart } from '../yahooApi.js';

const router = Router();

router.get('/:symbol', async (req, res) => {
  try {
    const { symbol } = req.params;
    // Use 5Y chart data to calculate annual performance
    const data = await getChart(symbol, '5y', '1mo');

    if (data.length === 0) {
      return res.json([]);
    }

    // Group by year and calculate annual returns
    const yearlyData = new Map<string, { first: number; last: number }>();
    for (const point of data) {
      const year = point.time.slice(0, 4);
      if (!yearlyData.has(year)) {
        yearlyData.set(year, { first: point.close, last: point.close });
      } else {
        yearlyData.get(year)!.last = point.close;
      }
    }

    const years = [...yearlyData.keys()].sort();
    const result = years.map((year, i) => {
      const d = yearlyData.get(year)!;
      const prevYear = years[i - 1];
      const prevD = prevYear ? yearlyData.get(prevYear)! : null;
      const annualReturn = prevD ? ((d.last - prevD.last) / prevD.last) * 100 : null;

      return {
        year,
        revenue: null,
        revenueYoY: null,
        netIncome: null,
        netIncomeYoY: null,
        eps: null,
        epsYoY: null,
        annualReturn,
        startPrice: d.first,
        endPrice: d.last,
        isEstimate: false,
      };
    });

    res.json(result);
  } catch (error: any) {
    console.error('Financials error:', error.message);
    res.status(500).json({ error: 'Failed to fetch financials' });
  }
});

export default router;
