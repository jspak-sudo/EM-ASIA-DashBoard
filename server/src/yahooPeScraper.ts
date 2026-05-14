// Yahoo Finance PE 데이터 HTML 스크레이퍼
// Node's undici fetch가 Yahoo의 큰 헤더에서 HeadersOverflowError를 내므로 https 모듈 사용
import https from 'https';
import zlib from 'zlib';

interface PeData {
  trailingPE: number | null;
  forwardPE: number | null;
  eps: number | null;
  epsForward: number | null;
}

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml',
  'Accept-Language': 'en-US,en;q=0.9',
  'Accept-Encoding': 'gzip, deflate',
};

function fetchHtml(url: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: HEADERS,
      // Increase max header size to handle Yahoo's large headers
      maxHeaderSize: 65536 * 4,
    }, (res) => {
      const chunks: Buffer[] = [];
      let stream: NodeJS.ReadableStream = res;

      // Handle gzip/deflate
      const enc = res.headers['content-encoding'];
      if (enc === 'gzip') stream = res.pipe(zlib.createGunzip());
      else if (enc === 'deflate') stream = res.pipe(zlib.createInflate());

      stream.on('data', (chunk: Buffer) => chunks.push(chunk));
      stream.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
      stream.on('error', reject);
    });
    req.on('error', reject);
    req.setTimeout(10000, () => { req.destroy(new Error('timeout')); });
  });
}

// 심볼별 캐시 (24시간 — PER은 일일 변동 작음)
const _peCache: Record<string, { data: PeData; at: number }> = {};
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

export async function getYahooPE(symbol: string): Promise<PeData> {
  const cached = _peCache[symbol];
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.data;

  const result: PeData = { trailingPE: null, forwardPE: null, eps: null, epsForward: null };
  try {
    const url = `https://finance.yahoo.com/quote/${encodeURIComponent(symbol)}/`;
    const html = await fetchHtml(url);

    // HTML에 embedded JSON, 이스케이프된 형태도 있음:
    //   "trailingPE":{"raw":33.29962,...}
    //   \"trailingPE\":{\"raw\":33.29962
    const patterns: { key: keyof PeData; regex: RegExp }[] = [
      { key: 'trailingPE', regex: /["\\]trailingPE[\\"]*:\{[\\"]*raw[\\"]*:(-?[0-9.]+)/ },
      { key: 'forwardPE', regex: /["\\]forwardPE[\\"]*:\{[\\"]*raw[\\"]*:(-?[0-9.]+)/ },
      { key: 'eps', regex: /["\\]epsTrailingTwelveMonths[\\"]*:\{[\\"]*raw[\\"]*:(-?[0-9.]+)/ },
      { key: 'epsForward', regex: /["\\]epsForward[\\"]*:\{[\\"]*raw[\\"]*:(-?[0-9.]+)/ },
    ];
    for (const { key, regex } of patterns) {
      const m = html.match(regex);
      if (m) result[key] = parseFloat(m[1]);
    }
    _peCache[symbol] = { data: result, at: Date.now() };
  } catch (e: any) {
    console.error(`[PE] ${symbol} error:`, e.message);
  }
  return result;
}
