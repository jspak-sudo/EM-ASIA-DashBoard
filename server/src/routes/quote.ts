import { Router } from 'express';
import { getQuote } from '../yahooApi.js';

const router = Router();

router.get('/:symbol', async (req, res) => {
  try {
    const { symbol } = req.params;
    const quote = await getQuote(symbol);
    res.json(quote);
  } catch (error: any) {
    console.error('Quote error:', error.message);
    res.status(500).json({ error: 'Failed to fetch quote' });
  }
});

export default router;
