import { Router, Request, Response } from 'express';
import https from 'https';

const router = Router();

// ── Yahoo 일별 시계열 ─────────────────────────────────────────────────────────
function fetchYahoo(symbol: string): Promise<{ date: string; value: number }[]> {
  // 2000-01-01 ~ 현재
  const p1 = Math.floor(new Date('2000-01-01').getTime() / 1000);
  const p2 = Math.floor(Date.now() / 1000);
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&period1=${p1}&period2=${p2}`;
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, res => {
      const chunks: Buffer[] = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        try {
          const j = JSON.parse(Buffer.concat(chunks).toString());
          const r = j.chart?.result?.[0];
          if (!r) return resolve([]);
          const ts: number[] = r.timestamp || [];
          const closes: (number | null)[] = r.indicators?.quote?.[0]?.close || [];
          const out: { date: string; value: number }[] = [];
          for (let i = 0; i < ts.length; i++) {
            const c = closes[i];
            if (c != null && !isNaN(c)) out.push({ date: new Date(ts[i] * 1000).toISOString().slice(0, 10), value: +c.toFixed(2) });
          }
          resolve(out);
        } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.setTimeout(20000, () => req.destroy(new Error('timeout')));
  });
}

// ── 캐시 ─────────────────────────────────────────────────────────────────────
let _cache: { data: any; ts: number } | null = null;
const TTL = 30 * 60 * 1000; // 30분

// ^SOX 실현변동성(연율화, %) — 종가 로그수익률의 N일 표준편차 × √252
function realizedVol(prices: { date: string; value: number }[], window = 30): { date: string; value: number }[] {
  const out: { date: string; value: number }[] = [];
  const rets: number[] = [];
  for (let i = 1; i < prices.length; i++) rets.push(Math.log(prices[i].value / prices[i - 1].value));
  for (let i = window; i < rets.length; i++) {
    const slice = rets.slice(i - window, i);
    const m = slice.reduce((a, b) => a + b, 0) / window;
    const v = slice.reduce((a, b) => a + (b - m) ** 2, 0) / window;
    const annual = Math.sqrt(v) * Math.sqrt(252) * 100;
    out.push({ date: prices[i + 1].date, value: +annual.toFixed(2) });
  }
  return out;
}

router.get('/', async (_req: Request, res: Response) => {
  try {
    if (_cache && Date.now() - _cache.ts < TTL) return res.json(_cache.data);

    // ^VXN(나스닥100 변동성, 옵션 IV) + ^SOX(필라델피아 반도체, 실현변동성 산출)
    const [vxn, sox, vix] = await Promise.all([
      fetchYahoo('^VXN').catch(() => []),
      fetchYahoo('^SOX').catch(() => []),
      fetchYahoo('^VIX').catch(() => []),
    ]);

    const soxRV = sox.length > 40 ? realizedVol(sox, 30) : [];

    const latest = (arr: { date: string; value: number }[]) => arr.length ? arr[arr.length - 1] : null;
    // 퍼센타일 (현재값이 과거 대비 어느 위치)
    const pct = (arr: { date: string; value: number }[]) => {
      if (!arr.length) return null;
      const cur = arr[arr.length - 1].value;
      const below = arr.filter(d => d.value <= cur).length;
      return +(below / arr.length * 100).toFixed(0);
    };

    const data = {
      vxn:    { name: 'CBOE 나스닥100 변동성 (^VXN)', series: vxn,   latest: latest(vxn),   percentile: pct(vxn) },
      soxRV:  { name: 'SOX 30일 실현변동성',          series: soxRV, latest: latest(soxRV), percentile: pct(soxRV) },
      vix:    { name: 'CBOE S&P500 변동성 (^VIX)',    series: vix,   latest: latest(vix),   percentile: pct(vix) },
      sox:    { name: '필라델피아 반도체 지수 (^SOX)', series: sox,   latest: latest(sox) },
      fetchedAt: new Date().toISOString(),
    };
    _cache = { data, ts: Date.now() };
    res.json(data);
  } catch (e: any) {
    res.status(500).json({ error: String(e?.message || e) });
  }
});

export default router;
