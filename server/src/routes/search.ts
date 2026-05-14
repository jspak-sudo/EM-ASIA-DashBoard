import { Router } from 'express';
import { searchSymbols } from '../yahooApi.js';

const router = Router();

router.get('/', async (req, res) => {
  try {
    const query = req.query.q as string;
    if (!query) return res.json([]);
    const results = await searchSymbols(query);
    res.json(results);
  } catch (error: any) {
    console.error('Search error:', error.message);
    res.status(500).json({ error: 'Failed to search' });
  }
});

export default router;
