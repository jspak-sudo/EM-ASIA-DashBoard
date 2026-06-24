import express from 'express';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import quoteRouter from './routes/quote.js';
import chartRouter from './routes/chart.js';
import financialsRouter from './routes/financials.js';
import correlationRouter from './routes/correlation.js';
import macroRouter from './routes/macro.js';
import searchRouter from './routes/search.js';
import overviewRouter from './routes/overview.js';
import intradayRouter from './routes/intraday.js';
import fxRouter from './routes/fx.js';
import feargreedRouter from './routes/feargreed.js';
import vixRouter from './routes/vix.js';
import fundsRouter from './routes/funds.js';
import liquidityRouter from './routes/liquidity.js';
import repressionRouter from './routes/repression.js';
import stocksRouter from './routes/stocks.js';
import factsetRouter from './routes/factset.js';
import fedwatchRouter from './routes/fedwatch.js';
import fedRouter from './routes/fed.js';
import backtestRouter from './routes/backtest.js';
import soxvolRouter from './routes/soxvol.js';

const app = express();
const PORT = 3002;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

app.use(cors());
app.use(express.json());

// Serve dashboard.html at root
app.use(express.static(path.join(__dirname, '../../')));

app.use('/api/quote', quoteRouter);
app.use('/api/chart', chartRouter);
app.use('/api/financials', financialsRouter);
app.use('/api/correlation', correlationRouter);
app.use('/api/macro', macroRouter);
app.use('/api/search', searchRouter);
app.use('/api/overview', overviewRouter);
app.use('/api/intraday', intradayRouter);
app.use('/api/fx', fxRouter);
app.use('/api/feargreed', feargreedRouter);
app.use('/api/vix', vixRouter);
app.use('/api/funds', fundsRouter);
app.use('/api/liquidity', liquidityRouter);
app.use('/api/repression', repressionRouter);
app.use('/api/stocks', stocksRouter);
app.use('/api/factset', factsetRouter);
app.use('/api/valuation', factsetRouter); // alias
app.use('/api/fedwatch', fedwatchRouter);
app.use('/api/fed', fedRouter);
app.use('/api/backtest', backtestRouter);
app.use('/api/soxvol', soxvolRouter);

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
