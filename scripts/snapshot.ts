/**
 * 스냅샷 생성 스크립트
 * 사용: npm run snapshot
 * 결과: docs/index.html (self-contained, 서버 없이 동작)
 */

import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const BASE = 'http://localhost:3002';

// ── HTTP GET ────────────────────────────────────────────────────────────────
function get(url: string, timeoutMs = 60000): Promise<any> {
  return new Promise((resolve, reject) => {
    const req = http.get(url, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error(`JSON 파싱 오류 (${url}): ${(e as Error).message}`)); }
      });
      res.on('error', reject);
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`타임아웃: ${url}`)));
  });
}

async function tryGet(url: string, fallback: any = {}): Promise<any> {
  try {
    const result = await get(url);
    return result;
  } catch (e) {
    console.log(` ❌ 실패 (${(e as Error).message})`);
    return fallback;
  }
}

// ── 메인 ─────────────────────────────────────────────────────────────────────
async function main() {
  console.log('');
  console.log('📸 대시보드 스냅샷 생성');
  console.log('─'.repeat(50));

  const snap: Record<string, any> = {};

  // ── 1. 기본 지표 ────────────────────────────────────────────────────────────
  console.log('\n[1/5] 기본 지표 데이터');
  const simpleEndpoints: [string, string][] = [
    ['/api/overview',   'overview'],
    ['/api/feargreed',  'feargreed'],
    ['/api/vix',        'vix'],
    ['/api/liquidity',  'liquidity'],
    ['/api/repression', 'repression'],
    ['/api/valuation',  'valuation'],
    ['/api/fed',        'fed'],
    ['/api/fedwatch',   'fedwatch'],
  ];
  for (const [endpoint, label] of simpleEndpoints) {
    process.stdout.write(`  ${label}... `);
    snap[endpoint] = await tryGet(BASE + endpoint);
    if (snap[endpoint] && Object.keys(snap[endpoint]).length > 0) console.log('✅');
  }

  // ── 2. 주식 시장 (전체 탭) ──────────────────────────────────────────────────
  console.log('\n[2/5] 주식 시장 데이터');
  const markets = ['us', 'cn_sh', 'cn_sz', 'cn_star', 'cn_chinext', 'hk', 'jp', 'tw', 'in'];
  for (const m of markets) {
    process.stdout.write(`  ${m}... `);
    snap[`/api/stocks?market=${m}`] = await tryGet(`${BASE}/api/stocks?market=${m}`);
    console.log('✅');
  }

  // ── 3. ETF 전체 목록 ────────────────────────────────────────────────────────
  console.log('\n[3/5] ETF 전체 목록');
  process.stdout.write('  전체 목록 (최대 2000개)... ');
  const fundsList = await tryGet(`${BASE}/api/funds/naver/list?limit=2000`, { results: [], total: 0 });
  snap['/api/funds/naver/list'] = fundsList;
  const codes: string[] = fundsList.results?.map((r: any) => r.itemcode) || [];
  console.log(`✅ ${codes.length}개`);

  // ── 4. 수익률 + 평균시총 ────────────────────────────────────────────────────
  console.log('\n[4/5] 수익률 & 평균시총');

  // 수익률 (200개 청크)
  const returns: Record<string, any> = {};
  process.stdout.write(`  수익률 ${codes.length}개`);
  for (let i = 0; i < codes.length; i += 200) {
    const chunk = codes.slice(i, i + 200);
    try {
      const r = await get(`${BASE}/api/funds/naver/returns?codes=${chunk.join(',')}`);
      Object.assign(returns, r);
      process.stdout.write('.');
    } catch { process.stdout.write('x'); }
  }
  snap['__returns__'] = returns;
  console.log(` ✅ ${Object.keys(returns).length}개`);

  // 평균시총 (50개 청크)
  const avgcaps: Record<string, any> = {};
  process.stdout.write(`  평균시총 ${codes.length}개`);
  for (let i = 0; i < codes.length; i += 50) {
    const chunk = codes.slice(i, i + 50);
    try {
      const r = await get(`${BASE}/api/funds/naver/avgcaps?codes=${chunk.join(',')}`);
      Object.assign(avgcaps, r);
      process.stdout.write('.');
    } catch { process.stdout.write('x'); }
  }
  snap['__avgcaps__'] = avgcaps;
  console.log(` ✅ ${Object.keys(avgcaps).length}개`);

  // ── 5. 보유종목 전체 수집 ───────────────────────────────────────────────────
  console.log('\n[5/6] 보유종목 전체 수집');
  const holdings: Record<string, any> = {};
  const CONCURRENCY = 8; // 동시 요청 수
  let done = 0;
  process.stdout.write(`  홀딩스 ${codes.length}개 `);

  for (let i = 0; i < codes.length; i += CONCURRENCY) {
    const chunk = codes.slice(i, i + CONCURRENCY);
    await Promise.all(chunk.map(async code => {
      try {
        const r = await get(`${BASE}/api/funds/naver/holdings/${code}`, 30000);
        if (r && (r.holdings?.length > 0 || r.weightedAvgMarketCap != null)) {
          holdings[code] = r;
        }
        done++;
        if (done % 50 === 0) process.stdout.write('.');
      } catch {
        done++;
      }
    }));
  }
  snap['__holdings__'] = holdings;
  console.log(` ✅ ${Object.keys(holdings).length}개`);

  // ── 6. HTML 생성 ────────────────────────────────────────────────────────────
  console.log('\n[6/6] HTML 생성');

  const now = new Date().toLocaleString('ko-KR', {
    timeZone: 'Asia/Seoul', hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit',
  });

  // fetch 오버라이드 + 스냅샷 데이터 인젝션
  const injectScript = `
<script>
/* ═══════════════════════════════════════════════════
   SNAPSHOT: ${now} KST
   이 파일은 자동 생성됩니다. 직접 수정하지 마세요.
═══════════════════════════════════════════════════ */
window.__SNAPSHOT__ = ${JSON.stringify(snap).replace(/<\/script>/gi, '<\\/script>').replace(/<!--/g, '<\\!--')};
window.__SNAPSHOT_TIME__ = '${now}';

// ── 폴리필: AbortSignal.timeout / AbortSignal.any ────────────────────────────
// Chrome 103+ / Safari 16+ 미만 구형 모바일 대응
if (typeof AbortSignal !== 'undefined') {
  if (!AbortSignal.timeout) {
    AbortSignal.timeout = function(ms) {
      const ctrl = new AbortController();
      const id = setTimeout(function() {
        try { ctrl.abort(new DOMException('signal timed out', 'TimeoutError')); } catch(e) { ctrl.abort(); }
      }, ms);
      ctrl.signal.addEventListener('abort', function() { clearTimeout(id); }, { once: true });
      return ctrl.signal;
    };
  }
  if (!AbortSignal.any) {
    AbortSignal.any = function(signals) {
      const ctrl = new AbortController();
      for (let i = 0; i < signals.length; i++) {
        const s = signals[i];
        if (s && s.aborted) { try { ctrl.abort(s.reason); } catch(e) { ctrl.abort(); } return ctrl.signal; }
        if (s) s.addEventListener('abort', function() { try { ctrl.abort(s.reason); } catch(e) { ctrl.abort(); } }, { once: true });
      }
      return ctrl.signal;
    };
  }
}

(function() {
  const snap = window.__SNAPSHOT__;

  // new Response() 없이도 동작하는 mock 생성 (구형 모바일 대응)
  function mockResponse(data) {
    var json = typeof data === 'string' ? data : JSON.stringify(data);
    return {
      ok: true,
      status: 200,
      headers: { get: function() { return 'application/json'; } },
      json: function() { return Promise.resolve(JSON.parse(json)); },
      text: function() { return Promise.resolve(json); },
      clone: function() { return mockResponse(data); }
    };
  }

  window.fetch = async function(url, opts) {
    const u = String(url).replace(/^https?:\\/\\/localhost:\\d+/, '');
    const qIdx = u.indexOf('?');
    const basePath = qIdx >= 0 ? u.slice(0, qIdx) : u;
    const qp = new URLSearchParams(qIdx >= 0 ? u.slice(qIdx + 1) : '');

    // ── 정확한 경로 매칭 ─────────────────────────────
    if (snap[u] !== undefined) {
      return mockResponse(snap[u]);
    }

    // ── /api/stocks ─────────────────────────────────
    if (basePath === '/api/stocks') {
      const key = '/api/stocks?market=' + (qp.get('market') || 'us');
      return mockResponse(snap[key] || []);
    }

    // ── ETF 목록 ────────────────────────────────────
    if (basePath === '/api/funds/naver/list' || basePath === '/api/funds/naver') {
      const full = snap['/api/funds/naver/list'];
      if (!full) return mockResponse({ results: [], total: 0 });

      let results = (full.results || []).slice();
      const cat  = qp.get('categoryKey');
      const q    = qp.get('q');
      const sort = qp.get('sort') || 'marketSum';
      const lim  = parseInt(qp.get('limit') || '50', 10);

      if (cat === 'new_this_month') {
        results = results.filter(function(r) { return r.isNew; });
      } else if (cat) {
        results = results.filter(function(r) { return r.categoryKey === cat; });
      }
      if (q) {
        const ql = q.toLowerCase().replace(/\\s/g, '');
        results = results.filter(function(r) {
          return r.name.toLowerCase().replace(/\\s/g, '').indexOf(ql) >= 0 ||
                 r.itemcode.indexOf(q) === 0;
        });
      }
      if (sort === 'changeRate') results.sort(function(a, b) { return b.changeRate - a.changeRate; });
      else if (sort === 'threeMonthReturn') results.sort(function(a, b) { return b.threeMonthReturn - a.threeMonthReturn; });
      else results.sort(function(a, b) { return b.marketSum - a.marketSum; });

      return mockResponse({
        results: results.slice(0, lim),
        total: results.length,
        categoryCounts: full.categoryCounts,
        categoryMarketSums: full.categoryMarketSums,
        totalMarketSum: full.totalMarketSum,
      });
    }

    // ── 수익률 ──────────────────────────────────────
    if (basePath === '/api/funds/naver/returns') {
      const codes = (qp.get('codes') || '').split(',').filter(Boolean);
      const data = {};
      for (let i = 0; i < codes.length; i++) {
        const c = codes[i];
        if (snap.__returns__ && snap.__returns__[c]) data[c] = snap.__returns__[c];
      }
      return mockResponse(data);
    }

    // ── 평균시총 ────────────────────────────────────
    if (basePath === '/api/funds/naver/avgcaps') {
      const codes = (qp.get('codes') || '').split(',').filter(Boolean);
      const data = {};
      for (let i = 0; i < codes.length; i++) {
        const c = codes[i];
        if (snap.__avgcaps__ && snap.__avgcaps__[c]) data[c] = snap.__avgcaps__[c];
      }
      return mockResponse(data);
    }

    // ── 홀딩스 ──────────────────────────────────────
    if (basePath.indexOf('/api/funds/naver/holdings') === 0) {
      const code = basePath.split('/').pop() || '';
      const h = snap.__holdings__ && snap.__holdings__[code];
      if (h) return mockResponse(h);
      return mockResponse({
        holdings: [], weightedAvgMarketCap: null,
        _snapshotNote: '보유종목 데이터 없음'
      });
    }

    // ── 검색 (빈 결과 반환) ─────────────────────────
    if (u.indexOf('/search') >= 0) {
      return mockResponse({ results: [], total: 0 });
    }

    // ── 기타 ────────────────────────────────────────
    return mockResponse({});
  };
})();
</script>`;

  process.stdout.write('  dashboard.html 읽기... ');
  let html = fs.readFileSync(path.join(ROOT, 'dashboard.html'), 'utf-8');
  console.log('✅');

  // 스냅샷 배너 추가 (상단에 날짜 표시)
  const banner = `
<div id="snapshot-banner" style="background:#1a2035;border-bottom:1px solid #2a3a5a;padding:6px 16px;font-size:11px;color:#6b8aad;display:flex;align-items:center;gap:8px;font-family:sans-serif;">
  <span style="color:#4a9eff">📸</span>
  <span>스냅샷 버전</span>
  <span style="color:#4a5568">|</span>
  <span>기준: ${now} KST</span>
  <span style="color:#4a5568">|</span>
  <span style="color:#4a5568">실시간 데이터 미지원 (홀딩스/검색 제한)</span>
</div>`;

  // 주입: </head> 직전에 스크립트, <body> 직후에 배너
  html = html.replace('</head>', injectScript + '\n</head>');
  html = html.replace('<body', '<body');
  // body 태그 이후 첫 번째 위치에 배너 삽입
  html = html.replace(/(<body[^>]*>)/, `$1\n${banner}`);

  // docs 폴더 생성 및 저장
  const docsDir = path.join(ROOT, 'docs');
  if (!fs.existsSync(docsDir)) fs.mkdirSync(docsDir, { recursive: true });

  const outPath = path.join(docsDir, 'index.html');
  fs.writeFileSync(outPath, html, 'utf-8');

  const sizeMB = (fs.statSync(outPath).size / 1024 / 1024).toFixed(1);
  console.log(`  ✅ docs/index.html 저장 완료 (${sizeMB} MB)`);

  // ── 완료 ──────────────────────────────────────────────────────────────────
  console.log('\n' + '─'.repeat(50));
  console.log(`✅ 스냅샷 완료! (${now} KST)`);
  console.log('');
  console.log('📤 GitHub 업로드:');
  console.log('   git add docs/');
  console.log(`   git commit -m "스냅샷 업데이트 ${now}"`);
  console.log('   git push');
  console.log('');
}

main().catch(e => {
  console.error('\n❌ 오류:', e);
  process.exit(1);
});
