import { Router, Request, Response } from 'express';
import { createRequire } from 'module';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import https from 'https';

const require = createRequire(import.meta.url);
const router = Router();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const HISTORY_FILE = path.join(__dirname, '../../../data/factset_history.json');

// Load history from disk
function loadHistory(): FactSetEntry[] {
  try {
    if (fs.existsSync(HISTORY_FILE)) {
      return JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf-8'));
    }
  } catch {}
  return [];
}

// Save history to disk
function saveHistory(history: FactSetEntry[]): void {
  try {
    fs.writeFileSync(HISTORY_FILE, JSON.stringify(history, null, 2));
  } catch (e) {
    console.error('[factset] Failed to save history:', e);
  }
}

interface FactSetEntry {
  date: string;       // "April 17, 2026"
  isoDate: string;    // "2026-04-17"
  quarter: string;    // "Q1 2026"
  forwardPE: number;
  avg5Y: number;
  avg10Y: number;
  earningsGrowth: number;  // blended %
  epsBeatRate: number;     // %
  revBeatRate: number;     // %
  fetchedAt: string;       // ISO timestamp
}

// Generate Friday dates for the past N weeks
function getRecentFridays(count: number): Date[] {
  const fridays: Date[] = [];
  const now = new Date();
  // Find most recent Friday
  let d = new Date(now);
  const day = d.getDay(); // 0=Sun, 5=Fri
  const daysToFri = day >= 5 ? day - 5 : day + 2;
  d.setDate(d.getDate() - daysToFri);
  for (let i = 0; i < count; i++) {
    fridays.push(new Date(d));
    d.setDate(d.getDate() - 7);
  }
  return fridays;
}

// Convert Date -> MMDDYY (FactSet filename format)
function toFactSetDate(d: Date): string {
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  const yy = String(d.getFullYear()).slice(-2);
  return mm + dd + yy;
}

// Download PDF buffer from URL
function downloadPdf(url: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    const req = https.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120',
        'Accept': 'application/pdf,*/*',
      },
      timeout: 20000,
    }, (res) => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        const loc = res.headers.location;
        if (loc) return resolve(downloadPdf(loc));
        return reject(new Error('Redirect without location'));
      }
      if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}`));
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => resolve(Buffer.concat(chunks)));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
  });
}

// Parse FactSet PDF buffer, extract key metrics
async function parsePdf(buf: Buffer): Promise<Omit<FactSetEntry, 'fetchedAt'> | null> {
  try {
    const { PDFParse } = require('pdf-parse');
    const parser = new PDFParse({ data: buf });
    const result = await parser.getText();
    const text: string = result.text;

    // 날짜/분기는 원본 텍스트에서, 나머지는 정규화된 텍스트에서 추출
    const dateM    = text.match(/([A-Z][a-z]+ \d{1,2}, 20\d{2})/);
    const quarterM = text.match(/For (Q\d \d{4})/);

    // 줄바꿈을 공백으로 정규화 → 멀티라인 패턴 매칭 대응
    const t = text.replace(/\s+/g, ' ');
    const fwdPE = t.match(/forward 12-month P\/E ratio for the S&P 500 is (\d+\.\d+)/);
    const avg5  = t.match(/5-year average\s*\((\d+\.\d+)\)/);
    // 10Y avg: bracket form "(18.9)" or inline "10-year average of 18.9"
    const avg10 = t.match(/10-year average\s*\((\d+\.\d+)\)/) ||
                  t.match(/above the 10-year average\s*\((\d+\.\d+)\)/) ||
                  t.match(/10-year average of (\d+\.\d+)/);
    // "blended/estimated earnings growth rate/decline for the S&P 500 is X.X%"
    const growth = t.match(/(?:blended|estimated)\s+earnings\s+(?:growth\s+rate|decline)\s+for\s+the\s+S&P\s+500\s+is\s+(-?\d+\.?\d*)%/) ||
                   t.match(/earnings\s+(?:growth\s+rate|decline)\s+for\s+the\s+S&P\s+500\s+is\s+(-?\d+\.?\d*)%/);
    // EPS beat
    const epsBeat = t.match(/(\d+)% of S&P 500\s*companies ha(?:s|ve) reported a positive EPS surprise/);
    // Revenue beat: 다양한 연도별 문장 포맷 처리
    const revBeat = t.match(/positive EPS surprise and (\d+)% of S&P 500 companies ha(?:s|ve) reported a positive revenue/) ||
                    t.match(/positive EPS surprise and (\d+)% have reported a positive revenue/) ||
                    t.match(/EPS surprise[^.]*?and (\d+)%[^.]*?positive revenue/) ||
                    t.match(/(\d+)% of S&P 500 companies ha(?:s|ve) reported a positive revenue/);

    if (!fwdPE) return null;  // not a valid FactSet earnings insight PDF

    const dateStr = dateM ? dateM[1] : '';
    const isoDate = dateStr ? toIsoDate(dateStr) : '';

    return {
      date: dateStr,
      isoDate,
      quarter: quarterM ? quarterM[1] : '',
      forwardPE: fwdPE ? parseFloat(fwdPE[1]) : 0,
      avg5Y: avg5 ? parseFloat(avg5[1]) : 0,
      avg10Y: avg10 ? parseFloat(avg10[1]) : 0,
      earningsGrowth: growth ? parseFloat(growth[1]) : 0,
      epsBeatRate: epsBeat ? parseInt(epsBeat[1]) : 0,
      revBeatRate: revBeat ? parseInt(revBeat[1]) : 0,
    };
  } catch (e) {
    console.error('[factset] PDF parse error:', e);
    return null;
  }
}

// "April 17, 2026" -> "2026-04-17"
function toIsoDate(dateStr: string): string {
  try {
    // Use Intl or manual parse to avoid UTC offset issues
    const months: Record<string, string> = {
      January:'01', February:'02', March:'03', April:'04', May:'05', June:'06',
      July:'07', August:'08', September:'09', October:'10', November:'11', December:'12'
    };
    const m = dateStr.match(/^([A-Za-z]+)\s+(\d{1,2}),\s+(\d{4})$/);
    if (!m) return '';
    const mm = months[m[1]];
    if (!mm) return '';
    const dd = m[2].padStart(2, '0');
    return `${m[3]}-${mm}-${dd}`;
  } catch {
    return '';
  }
}

// Try to fetch the latest FactSet PDF (last 10 Fridays)
async function fetchLatest(): Promise<FactSetEntry | null> {
  const fridays = getRecentFridays(10);
  const BASE = 'https://advantage.factset.com/hubfs/Website/Resources%20Section/Research%20Desk/Earnings%20Insight/EarningsInsight_';

  for (const fri of fridays) {
    const code = toFactSetDate(fri);
    const url = `${BASE}${code}.pdf`;
    console.log(`[factset] Trying: ${url}`);
    try {
      const buf = await downloadPdf(url);
      if (buf.length < 50000) continue; // too small, not a PDF
      const parsed = await parsePdf(buf);
      if (parsed) {
        console.log(`[factset] ✅ Parsed: ${parsed.date} | FwdPE=${parsed.forwardPE} | EPS=${parsed.epsBeatRate}%`);
        return { ...parsed, fetchedAt: new Date().toISOString() };
      }
    } catch (e: any) {
      console.log(`[factset] ❌ ${code}: ${e.message}`);
    }
  }
  return null;
}

// Generate all Fridays between two dates (inclusive)
function getAllFridaysBetween(from: Date, to: Date): Date[] {
  const result: Date[] = [];
  const d = new Date(from);
  // Advance to next Friday
  const dow = d.getDay();
  const daysToFri = dow <= 5 ? 5 - dow : 6; // 0=Sun → 5 days, 5=Fri → 0 days, 6=Sat → 6 days
  d.setDate(d.getDate() + (dow === 5 ? 0 : daysToFri));
  while (d <= to) {
    result.push(new Date(d));
    d.setDate(d.getDate() + 7);
  }
  return result;
}

// Backfill progress state
interface BackfillProgress {
  running: boolean;
  total: number;
  tried: number;
  found: number;
  skipped: number;
  failed: number;
  startedAt: string;
  finishedAt: string | null;
  lastFound: string | null;
}
let _backfillProgress: BackfillProgress | null = null;

async function runBackfill(fromDate: Date): Promise<void> {
  const BASE = 'https://advantage.factset.com/hubfs/Website/Resources%20Section/Research%20Desk/Earnings%20Insight/EarningsInsight_';
  const now = new Date();
  const fridays = getAllFridaysBetween(fromDate, now);

  let history = loadHistory();
  const existingDates = new Set(history.map(e => e.isoDate));

  _backfillProgress = {
    running: true,
    total: fridays.length,
    tried: 0,
    found: 0,
    skipped: 0,
    failed: 0,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    lastFound: null,
  };

  console.log(`[factset/backfill] Starting: ${fridays.length} Fridays from ${fromDate.toISOString().slice(0,10)}`);

  for (const fri of fridays) {
    if (!_backfillProgress.running) break; // allow cancellation

    const code = toFactSetDate(fri);
    const isoApprox = fri.toISOString().slice(0, 10);

    // Skip if we already have a nearby date (within ±3 days)
    const alreadyHave = [...existingDates].some(d => Math.abs(new Date(d).getTime() - fri.getTime()) < 4 * 86400000);
    if (alreadyHave) {
      _backfillProgress.tried++;
      _backfillProgress.skipped++;
      continue;
    }

    const url = `${BASE}${code}.pdf`;
    try {
      const buf = await downloadPdf(url);
      if (buf.length < 50000) {
        _backfillProgress.tried++;
        _backfillProgress.failed++;
        continue;
      }
      const parsed = await parsePdf(buf);
      if (parsed && parsed.isoDate) {
        const entry: FactSetEntry = { ...parsed, fetchedAt: new Date().toISOString() };
        // Reload history each time to avoid stale state
        history = loadHistory();
        const idx = history.findIndex(e => e.isoDate === parsed.isoDate);
        if (idx >= 0) history[idx] = entry;
        else { history.push(entry); history.sort((a, b) => a.isoDate.localeCompare(b.isoDate)); }
        saveHistory(history);
        existingDates.add(parsed.isoDate);
        _backfillProgress.found++;
        _backfillProgress.lastFound = parsed.isoDate;
        console.log(`[factset/backfill] ✅ ${parsed.isoDate} ${parsed.quarter} PE=${parsed.forwardPE}`);
      } else {
        _backfillProgress.failed++;
      }
    } catch {
      _backfillProgress.failed++;
    }

    _backfillProgress.tried++;
    // 400ms delay to be polite
    await new Promise(r => setTimeout(r, 400));
  }

  _backfillProgress.running = false;
  _backfillProgress.finishedAt = new Date().toISOString();
  console.log(`[factset/backfill] Done: found=${_backfillProgress.found} failed=${_backfillProgress.failed} skipped=${_backfillProgress.skipped}`);
}

// Cache in memory: { data: FactSetEntry|null, ts: number }
let _cache: { entry: FactSetEntry | null; ts: number } | null = null;
const CACHE_TTL = 6 * 60 * 60 * 1000; // 6 hours

router.get('/', async (req: Request, res: Response) => {
  try {
    let history = loadHistory();

    // Check if we need to re-fetch (no cache or stale)
    const now = Date.now();
    const needFetch = !_cache || (now - _cache.ts > CACHE_TTL);

    if (needFetch) {
      const latest = await fetchLatest();
      _cache = { entry: latest, ts: now };

      if (latest && latest.isoDate) {
        // Upsert into history by isoDate
        const idx = history.findIndex(e => e.isoDate === latest.isoDate);
        if (idx >= 0) {
          history[idx] = latest;
        } else {
          history.push(latest);
          // Sort chronologically
          history.sort((a, b) => a.isoDate.localeCompare(b.isoDate));
        }
        saveHistory(history);
      }
    }

    const current = _cache?.entry ?? (history.length > 0 ? history[history.length - 1] : null);

    res.json({
      current,
      history: history.map(e => ({
        isoDate: e.isoDate,
        date: e.date,
        quarter: e.quarter,
        forwardPE: e.forwardPE,
        avg5Y: e.avg5Y,
        avg10Y: e.avg10Y,
        earningsGrowth: e.earningsGrowth,
        epsBeatRate: e.epsBeatRate,
        revBeatRate: e.revBeatRate,
      })),
    });
  } catch (e: any) {
    console.error('[factset] Route error:', e);
    // Fall back to history only
    const history = loadHistory();
    const current = history.length > 0 ? history[history.length - 1] : null;
    res.json({ current, history, error: e.message });
  }
});

// GET /api/factset/backfill?from=2019-01-01  → start background backfill
router.get('/backfill', (req: Request, res: Response) => {
  if (_backfillProgress?.running) {
    res.json({ status: 'already_running', progress: _backfillProgress });
    return;
  }

  const fromStr = (req.query.from as string) || '2019-01-01';
  const fromDate = new Date(fromStr);
  if (isNaN(fromDate.getTime())) {
    res.status(400).json({ error: 'Invalid from date' });
    return;
  }

  // Fire and forget
  runBackfill(fromDate).catch(e => console.error('[factset/backfill] Error:', e));

  const now = new Date();
  const totalEst = getAllFridaysBetween(fromDate, now).length;
  res.json({
    status: 'started',
    from: fromDate.toISOString().slice(0, 10),
    estimatedFridays: totalEst,
    estimatedMinutes: Math.ceil(totalEst * 0.4 / 60),
    message: `${fromDate.toISOString().slice(0,10)}부터 ${totalEst}개 금요일 날짜 시도 중 (~${Math.ceil(totalEst * 0.4 / 60)}분 소요 예상)`,
  });
});

// GET /api/factset/backfill/status → poll progress
router.get('/backfill/status', (_req: Request, res: Response) => {
  if (!_backfillProgress) {
    res.json({ status: 'idle' });
    return;
  }
  res.json({
    status: _backfillProgress.running ? 'running' : 'done',
    progress: _backfillProgress,
  });
});

// GET /api/factset/backfill/stop → cancel
router.get('/backfill/stop', (_req: Request, res: Response) => {
  if (_backfillProgress?.running) {
    _backfillProgress.running = false;
    res.json({ status: 'stopped' });
  } else {
    res.json({ status: 'not_running' });
  }
});

// ── Repair: revBeatRate=0 or avg10Y=0 인 항목만 재파싱 ──
let _repairProgress: { running: boolean; total: number; done: number; fixed: number; lastFixed: string | null } | null = null;

async function runRepair(): Promise<void> {
  const BASE = 'https://advantage.factset.com/hubfs/Website/Resources%20Section/Research%20Desk/Earnings%20Insight/EarningsInsight_';
  let history = loadHistory();

  // 수정이 필요한 항목: revBeatRate=0 OR avg10Y=0
  // 단, 초기 시즌(earnings 발표 전)의 EPS/Rev=0는 합리적일 수 있으므로
  // revBeatRate=0 이지만 epsBeatRate>0 인 항목 → 확실한 파싱 오류
  // avg10Y=0 인 항목 → 무조건 오류
  const toRepair = history.filter(e =>
    e.avg10Y === 0 ||
    (e.revBeatRate === 0 && e.epsBeatRate > 0) ||
    e.earningsGrowth === 0
  );

  _repairProgress = { running: true, total: toRepair.length, done: 0, fixed: 0, lastFixed: null };
  console.log(`[factset/repair] ${toRepair.length}개 항목 재파싱 시작`);

  for (const entry of toRepair) {
    if (!_repairProgress.running) break;

    // isoDate → MMDDYY 변환
    const d = new Date(entry.isoDate + 'T12:00:00Z');
    const code = toFactSetDate(d);
    const url = `${BASE}${code}.pdf`;

    try {
      const buf = await downloadPdf(url);
      if (buf.length < 50000) { _repairProgress.done++; continue; }
      const parsed = await parsePdf(buf);
      if (parsed) {
        const newEntry: FactSetEntry = { ...entry, ...parsed, fetchedAt: new Date().toISOString() };
        history = loadHistory();
        const idx = history.findIndex(e => e.isoDate === entry.isoDate);
        if (idx >= 0) history[idx] = newEntry;
        saveHistory(history);
        _repairProgress.fixed++;
        _repairProgress.lastFixed = entry.isoDate;
        console.log(`[factset/repair] ✅ ${entry.isoDate} rev=${newEntry.revBeatRate}% 10Y=${newEntry.avg10Y}`);
      }
    } catch (e: any) {
      console.log(`[factset/repair] ❌ ${entry.isoDate}: ${e.message}`);
    }

    _repairProgress.done++;
    await new Promise(r => setTimeout(r, 400));
  }

  _repairProgress.running = false;
  console.log(`[factset/repair] 완료: ${_repairProgress.fixed}/${_repairProgress.total} 수정`);
}

router.get('/repair', (_req: Request, res: Response) => {
  if (_repairProgress?.running) {
    res.json({ status: 'already_running', progress: _repairProgress });
    return;
  }
  const history = loadHistory();
  const needRepair = history.filter(e => e.avg10Y === 0 || (e.revBeatRate === 0 && e.epsBeatRate > 0) || e.earningsGrowth === 0);
  if (needRepair.length === 0) {
    res.json({ status: 'nothing_to_repair' });
    return;
  }
  runRepair().catch(console.error);
  res.json({ status: 'started', count: needRepair.length, estimatedMinutes: Math.ceil(needRepair.length * 0.4 / 60) });
});

router.get('/repair/status', (_req: Request, res: Response) => {
  if (!_repairProgress) { res.json({ status: 'idle' }); return; }
  res.json({ status: _repairProgress.running ? 'running' : 'done', progress: _repairProgress });
});

// ── 자동 백필: 서버 시작 시 갭 감지 후 필요하면 자동 실행 ──
function autoBackfillIfNeeded(): void {
  const history = loadHistory();
  const TARGET_FROM = new Date('2019-01-01');

  if (_backfillProgress?.running) return; // 이미 실행 중

  if (history.length === 0) {
    console.log('[factset] 이력 없음 → 2019년부터 자동 백필 시작');
    runBackfill(TARGET_FROM).catch(console.error);
    return;
  }

  const sorted = [...history].sort((a, b) => a.isoDate.localeCompare(b.isoDate));

  // 가장 오래된 날짜가 2019-06-01 이후면 → 초반 데이터 없음
  const missingEarly = sorted[0].isoDate > '2019-06-01';

  // 연속된 항목 간 60일 이상 공백이 있으면 → 중간 누락
  let gapFrom: Date | null = null;
  for (let i = 1; i < sorted.length; i++) {
    const prev = new Date(sorted[i - 1].isoDate);
    const curr = new Date(sorted[i].isoDate);
    if ((curr.getTime() - prev.getTime()) / 86400000 > 60) {
      gapFrom = prev;
      break;
    }
  }

  // 마지막 데이터 이후 현재까지 60일 이상 비어 있으면 → 최근 누락
  const lastDate = new Date(sorted[sorted.length - 1].isoDate);
  const daysSinceLast = (Date.now() - lastDate.getTime()) / 86400000;
  const missingRecent = daysSinceLast > 60;

  if (missingEarly || gapFrom || missingRecent) {
    // 시작점: 갭 직전 날짜 or 2019-01-01 중 이른 것
    const startFrom = gapFrom
      ? new Date(Math.min(gapFrom.getTime(), TARGET_FROM.getTime()))
      : TARGET_FROM;
    console.log(`[factset] 자동 백필 트리거 → ${startFrom.toISOString().slice(0, 10)}부터 (missingEarly=${missingEarly}, gap=${gapFrom?.toISOString().slice(0,10) ?? 'none'}, missingRecent=${missingRecent})`);
    runBackfill(startFrom).catch(console.error);
  } else {
    console.log(`[factset] 이력 완전 (${sorted.length}개, ${sorted[0].isoDate}~${sorted[sorted.length-1].isoDate}) → 백필 불필요`);
  }
}

// 서버 시작 후 자동 실행
setTimeout(() => {
  autoBackfillIfNeeded();
  // 파싱 오류 항목 자동 repair (백필 완료 후 실행되도록 10초 후)
  setTimeout(() => {
    const history = loadHistory();
    const needRepair = history.filter(e => e.avg10Y === 0 || (e.revBeatRate === 0 && e.epsBeatRate > 0) || e.earningsGrowth === 0);
    if (needRepair.length > 0 && !_backfillProgress?.running) {
      console.log(`[factset] 자동 repair 트리거 (${needRepair.length}개 파싱 오류 감지)`);
      runRepair().catch(console.error);
    }
  }, 10000);
}, 2000);

export default router;
