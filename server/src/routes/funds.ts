import { Router, Request, Response } from 'express';
import https from 'https';
import iconv from 'iconv-lite';
import crypto from 'crypto';
import { fetchTimeEtfHoldings, TIME_ETF_MAP } from './timeEtf.js';
import { getMorningstarAvgCapKrwBillion } from './morningstar.js';

// USD millions → KRW 억 원 (고정 환율 1400원 기준, STATIC_CAP_KRW와 일관)
// Morningstar 캐시에서 이미 KRW 억원으로 정규화됨 (변환 불필요)

const router = Router();

// Morningstar UK — EU/UK funds & ETFs (SICAV, UCITS, LSE 등)
const MS_SEARCH_URL = 'https://www.morningstar.co.uk/uk/util/SecuritySearch.ashx';
// Yahoo Finance — US ETFs (SPY/QQQ/VOO) + Korean ETFs (TIGER/KODEX, .KS/.KQ)
const YF_SEARCH_URL = 'https://query1.finance.yahoo.com/v1/finance/search';
// Naver Finance — 국내 상장 ETF 전체 (한글 검색)
const NAVER_ETF_LIST_URL = 'https://finance.naver.com/api/sise/etfItemList.naver';

interface FundSearchResult {
  id: string;
  perfId: string;
  name: string;
  type: 'FUND' | 'ETF';
  ticker: string;
  exchange: string;
  starRating: string;
  category: string;
  source: 'morningstar' | 'yahoo' | 'naver';
  region?: string;
  detailUrl?: string;
  categoryKey?: string;
  // 한국 ETF 전용
  nav?: number;
  marketSum?: number;   // 시총 (억원)
  threeMonthReturn?: number;
  nowVal?: number;
  changeRate?: number;
  etfTabCode?: number;
}

// ── Naver ETF 카테고리 ──────────────────────────────────────────────────────
const NAVER_ETF_CATEGORIES: Record<number, string> = {
  1: '국내 주식',
  2: '국내 채권/파생',
  3: '국내 기타',
  4: '해외 주식',
  5: '해외 채권',
  6: '단기채/통화',
  7: '해외 기타',
};

// ── Naver ETF 리스트 캐시 (5분) ───────────────────────────────────────────
interface NaverETFItem {
  itemcode: string;
  etfTabCode: number;
  itemname: string;
  nowVal: number;
  changeRate: number;
  nav: number;
  threeMonthEarnRate: number;
  marketSum: number;   // 억원
}

let _naverCache: NaverETFItem[] | null = null;
let _naverCacheTs = 0;
const NAVER_CACHE_TTL = 10 * 60 * 1000; // 10분으로 증대

// 가공된 데이터 캐시 (분류 포함)
let _naverClassifiedCache: any[] | null = null;
let _naverSummaryCache: { counts: Record<string, number>, marketSums: Record<string, number>, totalMarketSum: number } | null = null;

async function fetchNaverETFList(): Promise<NaverETFItem[]> {
  if (_naverCache && Date.now() - _naverCacheTs < NAVER_CACHE_TTL) return _naverCache;

  try {
    const buf = await new Promise<Buffer>((resolve, reject) => {
      const req = https.get(NAVER_ETF_LIST_URL, {
        headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://finance.naver.com/etf/' }
      }, res => {
        const chunks: Buffer[] = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => resolve(Buffer.concat(chunks)));
      });
      req.on('error', reject);
      req.setTimeout(10000, () => { req.destroy(); reject(new Error('Naver API Timeout')); });
    });

    const decoded = iconv.decode(buf, 'EUC-KR');
    const data = JSON.parse(decoded);
    const items: NaverETFItem[] = data.result.etfItemList;

    _naverCache = items;
    _naverCacheTs = Date.now();
    
    // 캐시가 갱신될 때 분류 캐시도 초기화
    _naverClassifiedCache = null;
    _naverSummaryCache = null;
    
    return items;
  } catch (err) {
    console.error('fetchNaverETFList failed:', err);
    return _naverCache || []; // 실패 시 예전 캐시라도 반환
  }
}

// ── ETF 이름 기반 분류 ────────────────────────────────────────────────────────
// 우선순위 순서대로 매칭 (위에서 먼저 걸리면 해당 카테고리)
interface ETFCategory {
  key: string;
  label: string;
  emoji: string;
}

const ETF_CATEGORIES: ETFCategory[] = [
  // 1순위: 파생/레버리지/인버스 (이름에 자산군+레버리지 같이 있어도 여기로)
  { key: 'leverage',   label: '레버리지',    emoji: '📈' },
  { key: 'inverse',    label: '인버스',      emoji: '📉' },
  { key: 'longshort',  label: '롱/숏전략',   emoji: '↔️' },
  // 2순위: 혼합자산 (채권혼합·주식혼합 — 섹터/지역보다 우선)
  { key: 'tdf',        label: '자산배분/TDF', emoji: '🗂️' },
  { key: 'mixed',      label: '채권혼합',    emoji: '🔀' },
  // 2순위: 커버드콜 (옵션 매도 전략 — 섹터/지역보다 우선)
  { key: 'coveredcall', label: '커버드콜',   emoji: '📋' },
  // 3순위: 채권/통화/부동산/원자재 (자산군)
  // 만기매칭형 먼저 — "26-12 회사채" 등 YY-MM 패턴
  { key: 'maturity',   label: '만기매칭/연장형',  emoji: '📅' },
  // 글로벌단기채/FX 먼저 — 달러·엔화·SOFR·해외머니마켓 등 (국내 단기채보다 우선)
  { key: 'currency',   label: '글로벌단기채/FX', emoji: '💵' },
  // 국내 단기채권 — CD금리·KOFR·MMF 등 원화 단기물
  { key: 'bond_short', label: '국내단기채/MMF', emoji: '⏱️' },
  // 글로벌채권 먼저 — 미국·일본·유럽·글로벌·해외·하이일드 등 명시적 해외 채권 (국내채권보다 우선)
  { key: 'bond_global',label: '글로벌채권',  emoji: '🌐' },
  // 국내채권 — 한국 채권 키워드 + 분류 안 된 잔여 채권 (catch-all 채권|bond)
  { key: 'bond_kr',    label: '국내채권',    emoji: '🏦' },
  { key: 'reits',      label: '부동산/리츠',  emoji: '🏢' },
  { key: 'commodity',  label: '원자재/채굴생산기업',      emoji: '🪙' },
  // 4순위: 섹터 — 구체적 테마 먼저, 광역 IT는 나중에
  { key: 'semi',        label: '반도체',      emoji: '💾' },
  { key: 'battery',     label: '2차전지',     emoji: '🔋' },
  { key: 'kculture',   label: 'K컬처/소비/화장품/엔터/게임', emoji: '🎭' },
  { key: 'auto',        label: '자동차/전기차', emoji: '🚗' },
  { key: 'bio',         label: '바이오/헬스', emoji: '💊' },
  { key: 'power_infra', label: '전력인프라',  emoji: '⚡' },
  { key: 'ai_infra',    label: 'AI인프라',    emoji: '🖥️' },
  // 구체 테마: IT보다 먼저 — "우주테크"→defense, "로봇테크"→robot 등
  { key: 'quantum',     label: '양자',        emoji: '⚛️' },
  { key: 'robot',       label: '로봇',        emoji: '🤖' },
  { key: 'shipbuilding',label: '조선',        emoji: '🚢' },
  { key: 'defense',     label: '우주/방산/항공', emoji: '🚀' },
  // 지역 특화 (차이나항셍테크 등) — IT보다 앞에 두어 지역이 우선
  { key: 'china',       label: '중국주식',    emoji: '🇨🇳' },
  // IT — 위 테마·지역에 안 걸린 것만
  // 글로벌IT 먼저 — 명시적 미국/글로벌 키워드만 여기로
  { key: 'it_global',   label: '글로벌IT',    emoji: '🌐' },
  // 국내IT — 국내·혼합(한국+대만 등)·키워드만 있는 나머지 전부
  { key: 'it_kr',       label: '국내IT',      emoji: '💻' },
  { key: 'industrial',  label: '산업재',      emoji: '🏗️' },
  // finance 먼저 — "금융지주"가 samsung의 지주 키워드에 잡히지 않도록
  { key: 'finance',     label: '금융/보험',   emoji: '🏛️' },
  { key: 'samsung',     label: '그룹/지주사',  emoji: '🏢' },
  { key: 'energy',      label: '에너지',      emoji: '🛢️' },
  { key: 'esg',         label: '친환경/ESG',  emoji: '🌿' },
  { key: 'dividend',    label: '가치/배당/주주환원', emoji: '💰' },
  { key: 'growth',     label: '성장/모멘텀',       emoji: '🌱' },
  // 밸류체인 — 섹터 뒤에 위치: "2차전지밸류체인"→battery, "테슬라밸류체인"→여기로
  { key: 'valuechain',  label: '종목밸류체인', emoji: '🔗' },
  // 5순위: 해외 지역 (섹터 키워드 없는 광범위 지역 지수; china는 4순위에서 이미 처리)
  { key: 'us',         label: '미국인덱스',  emoji: '🇺🇸' },
  // 글로벌/선진국인덱스 — 유럽지수 + 토탈월드·ACWI 등 광역 선진 글로벌 지수
  { key: 'developed',  label: '글로벌/선진국', emoji: '🌍' },
  { key: 'em',         label: '아시아/신흥국',  emoji: '🌏' },
  // 6순위: 국내 지수
  { key: 'kr_small',   label: '국내중소형/코스닥', emoji: '📈' },
  { key: 'kr_idx',     label: '국내대형/코스피',  emoji: '📊' },
  // 7순위: 미분류 (어느 규칙에도 해당 안 되는 ETF)
  { key: 'unclassified', label: '기타',      emoji: '❓' },
];

const ETF_RULES: Record<string, RegExp> = {
  leverage:   /레버리지|2[Xx배]|3[Xx배]|bull/i,
  inverse:    /인버스|곱버스|-[12]X|bear/i,
  longshort:  /롱.*숏|숏.*롱|롱숏|long.?short|market.?neutral/i,
  // 혼합자산 (채권혼합·주식혼합 — 섹터/지역보다 우선 매칭)
  tdf:        /TDF|TRF|TIF\b|자산배분|비중전환|lifecycle|목표헤지/i,
  mixed:      /채권혼합|채혼합|주식혼합|혼합자산|리츠.*채권|인프라.*채권/i,
  coveredcall:/커버드콜|covered.?call/i,
  // 단기채권 먼저 — CD금리·KOFR·MMF 등 단기물
  bond_short: /(?<!중)단기|전단채|CD.{0,4}금리|KOFR|MMF|CP\b|초단기|머니마켓|money.?market|\d+~\d+년/i,
  // 만기매칭/연장형 — YY-MM 패턴 + 만기자동/자동연장 형태 (bond_short/global/kr 보다 먼저 체크)
  maturity:    /\b\d{2}-\d{2}\b|만기자동|자동연장/,
  // 글로벌채권 — 명시적 해외 키워드 + 채(권)|국채|회사채|금융채|TIPS 등 채권 자산
  // 잔여는 bond_kr로 fallback (catch-all 제거)
  bond_global: /미국채|일본채|유럽채|글로벌채|해외채|선진국채|신흥국채|중국채|아시아채|이머징채|월드채|국제채|독일채|영국채|호주채|캐나다채|멕시코채|EM채|(?:미국|미합중국|US\b|일본|유럽|선진국|글로벌|해외|월드|world|국제|중국|아시아|신흥국|EM\b|이머징|emerging|호주|캐나다|멕시코)\s*[A-Z0-9가-힣]{0,8}\s*(?:채권|회사채|국채|장기채|중장기채|단기채|은행채|금융채|크레딧|커버드|MBS|TIPS|국공채|투자등급|IG\s*채|하이일드|high.?yield)|TIPS\b|treasury|하이일드|high.?yield|EM\s*bond|emerging.*bond|sovereign.?bond|kbond.*global/i,
  // 국내채권 — 한국 채권 키워드 + 잔여 채권 catch-all (해외로 분류 안 된 모든 채권은 한국으로 fallback)
  bond_kr:    /국고채|통안채|회사채|종합채권|금융채|장기채|중단기채|중단기국채|중장기채|중장기국채|국내.*채권|채권.*국내|그룹채권|우량채권|국공채|물가채|(?<![미일중])국채|채권|bond/i,
  // 통화/FX — 순수 환헤지·통화 ETF
  // (?!노출): "엔화노출"·"달러노출" 같은 환노출 주식형 ETF 제외
  // 유로화 로 강제: "유로스탁스" 오탐 방지
  // 글로벌단기채/FX — 해외 통화·환헤지 + 달러/SOFR/머니마켓 계열 해외 단기물
  currency:   /달러(?!노출|채권)|엔화(?!노출)|엔선물|엔\s*선물|위안|유로화|통화|환헤지|SOFR|미국.*머니마켓|달러머니마켓|선진하이일드|단기.*하이일드|하이일드.*단기|미국단기|미국.*단기채|미국.*초단기|초단기.*국채/i,
  reits:      /리츠|REITs|부동산|리얼티/i,
  // \b금\b·\b은\b 은 한글 환경에서 word boundary 미동작 → 구체 패턴으로 대체
  commodity:  /금현물|금선물|금액티브|금채굴|채굴기업|광산|mining|국제금|골드|은현물|은선물|은액티브|gold|silver|원유|구리|천연가스|농산물|원자재|상품|니켈|팔라듐|밀|콩|자원생산기업|생산기업|농업경제/i,
  // 섹터 — 지역보다 먼저: "미국반도체"→semi, "글로벌2차전지"→battery 등
  semi:         /반도체|semiconductor|SOX|HBM|AI.*칩|팹리스/i,
  battery:      /2차전지|배터리|battery|이차전지|리튬/i,
  kculture:     /K컬처|K-컬처|한류|KPOP|K-POP|엔터테인먼트|엔터(?!프)|화장품|뷰티|K-뷰티|게임|게임즈|미디어|콘텐츠|컨텐츠|웹툰|소비|유통|리테일|명품|럭셔리|음식료|여행|레저|골프|K.?푸드|내수주|e커머스|이커머스|저작권/i,
  auto:         /자동차|전기차|모빌리티|mobility|로보택시|robotaxi|automotive|자율주행/i,
  bio:          /바이오|헬스케어|제약|헬스|메디컬|medical|치매|뇌질환|바이오시밀러|비만치료제|비만산업|빅파마|의료기기|의료AI|시니어|bio|health/i,
  // 전력인프라 먼저 — "AI전력인프라"는 power_infra로
  // 수소(?!비): "필수소비재"·"내수소비" 오탐 방지
  power_infra:  /전력|원자력|원전|태양광|풍력|수소(?!비)|신재생|재생에너지|유틸리티|utility/i,
  // AI인프라 — power_infra 이후에 와야 "AI전력인프라" 중복 방지
  ai_infra:     /AI인프라|AI.*인프라|AI에이전트|AI코리아|글로벌AI|글로벌.*AI|온디바이스AI|생성형AI|데이터.?센터|클라우드|소버린|광통신|네트워크인프라/i,
  valuechain:   /밸류체인|value.?chain/i,
  // 글로벌IT — 명시적 미국/글로벌 키워드만
  it_global:    /빅테크|미국테크|글로벌테크|FAANG?|나스닥.*테크|미국.*IT|글로벌.*IT|글로벌.*인터넷|글로벌.*플랫폼|미국.*커뮤니케이션|글로벌.*메타버스|해외.*메타버스|미국.*메타버스/i,
  // 국내IT — 나머지 IT/tech 키워드 전부 (한국+해외 혼합 포함)
  it_kr:        /IT\b|테크|tech|인터넷|플랫폼|소프트웨어|게임|미디어|메가테크|커뮤니케이션서비스|메타버스|5G/i,
  quantum:      /양자|quantum/i,
  robot:        /로봇|로보틱스|휴머노이드|피지컬AI|피지컬\s*AI|physicalAI|physical\s*AI|humanoid|robot|robotics/i,
  shipbuilding: /조선|shipbuilding/i,
  // defense — "항공" 단독 제거 (항공사·항공화물 오탐 방지); 우주·방산 키워드로 충분히 커버
  defense:      /방산|방위|defense|우주|항공우주|aerospace|드론|UAM/i,
  industrial:   /산업재|중공업|기계|건설|인프라|infrastructure|철강|소재(?!밸류)|제조업|희토류|CAPEX|설비투자|운송|물류|농업융복합/i,
  // 그룹/지주사 — 삼성·현대·LG·SK·롯데 등 대기업 그룹 ETF + 지주사 ETF
  samsung:      /지주|삼성그룹|삼성.*그룹|그룹.*삼성|삼성밸류|현대그룹|현대.*그룹|그룹.*현대|LG그룹|LG.*그룹|SK그룹|SK.*그룹|롯데그룹|롯데.*그룹|한화그룹|한화.*그룹|포스코그룹|포스코.*그룹|두산그룹|카카오그룹|그룹주/i,
  finance:      /금융|금융지주|은행|보험|(?<!우선)증권|저축|캐피탈|finance|bank|insurance/i,
  energy:       /에너지|energy/i,
  // 친환경/ESG — 순수 ESG지수·탄소·그린 테마 (신재생에너지 인프라는 power_infra에서 처리)
  esg:          /ESG|SRI|탄소배출권|탄소중립|탄소효율|그린뉴딜|친환경|지속가능|sustainability|녹색채권|그린본드|기후변화|워터/i,
  dividend:     /배당|dividend|고배당|월배당|분기배당|주주환원|주주가치|자사주|가치주|밸류(?!체인)|가치|우선증권|우선주|경기방어|로우볼|최소변동성|퀄리티|인컴|하이인컴|우량주|우량업종/i,
  growth:       /성장주|성장액티브|성장형|growth|모멘텀|momentum|퀀트|BBIG|이노베이션|혁신|포스트IPO|미래전략|주도업종|R&D\s*액티브|뉴딜|영에이지/i,
  // 해외 지역 — 섹터 키워드 없는 광범위 지역 지수
  us:           /미국(?!채)|나스닥|S&?P\s?500|필라델피아|다우|러셀|NYSE|버크셔/i,
  china:      /중국|차이나|항셍|홍콩|CSI|MSCI.*China|심천|선전/i,
  // 선진국 — 일본 포함 (일본반도체 등 섹터 ETF는 semi 등이 앞에서 처리)
  developed:  /유로스탁스|STOXX|유럽주식|유럽.*주식|Europe\b|DAX|FTSE|CAC|선진국|토탈월드|Total.*World|ACWI|MSCI.*World|전세계|일본|TOPIX|닛케이|Nikkei|블루칩|글로벌MSCI|글로벌브랜드|일등기업|주식분산|글로벌탑픽|글로벌수급|대장장이/i,
  // 신흥국 — 인도·동남아·라틴·중동 등 (중국은 china 규칙이 앞에서 처리)
  em:         /신흥국|아시아|Asia|대만|Taiwan|아태|EM|이머징|베트남|브라질|아세안|동남아|인도(?!네시아반도체)|India|Nifty|러시아|Russia|라틴|Latin|멕시코|Mexico|터키|Turkey|중동|GCC|사우디|인도네시아|Indonesia|말레이시아|Malaysia|태국|Thailand|필리핀|Philippines/i,
  kr_small:   /KOSDAQ|코스닥|중소형|중형주|소형주/i,
  kr_idx:     /KOSPI|코스피|KRX|대형주|코리아|\bkorea\b|\b200(?:TR)?\b|\b150(?:TR)?\b|Top\d+Plus|KTOP|K200\b|200ex|K수출|수출주|동학개미|멀티팩터|Top10동일가중|베스트일레븐/i,
};

export function classifyETFByName(name: string): { key: string; label: string; emoji: string } {
  for (const cat of ETF_CATEGORIES) {
    const re = ETF_RULES[cat.key];
    if (re && re.test(name)) return cat;
  }
  return { key: 'unclassified', label: '기타', emoji: '❓' };
}

// ── Naver ETF 검색 ──────────────────────────────────────────────────────────
async function searchNaver(q: string, limit: number): Promise<FundSearchResult[]> {
  const items = await fetchNaverETFList();
  const qLower = q.toLowerCase().replace(/\s/g, '');

  const matched = items.filter(item => {
    const nameLower = item.itemname.toLowerCase().replace(/\s/g, '');
    const code = item.itemcode;
    return (
      nameLower.includes(qLower) ||
      code.startsWith(q) ||
      code === q
    );
  });

  // 시총 순 정렬
  matched.sort((a, b) => b.marketSum - a.marketSum);

  return matched.slice(0, limit).map(item => {
    const cat = classifyETFByName(item.itemname);
    return {
      id: item.itemcode,
      perfId: '',
      name: item.itemname,
      type: 'ETF' as const,
      ticker: item.itemcode + '.KS',
      exchange: 'KRX',
      starRating: '',
      category: cat.emoji + ' ' + cat.label,
      categoryKey: cat.key,
      source: 'naver' as const,
      region: 'KR',
      detailUrl: `https://finance.naver.com/item/main.naver?code=${item.itemcode}`,
      nav: item.nav,
      marketSum: item.marketSum,
      threeMonthReturn: item.threeMonthEarnRate,
      nowVal: item.nowVal,
      changeRate: item.changeRate,
      etfTabCode: item.etfTabCode,
    };
  });
}

// ── Naver ETF 상세 (총보수율, 운용사) ────────────────────────────────────────
// ⚠️ finance.naver.com/item/main.naver 는 EUC-KR 페이지 → iconv 디코딩 필수
async function fetchNaverETFDetail(itemcode: string): Promise<Record<string, string>> {
  const buf = await new Promise<Buffer>((resolve, reject) => {
    const req = https.get(`https://finance.naver.com/item/main.naver?code=${itemcode}`, {
      headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://finance.naver.com/' }
    }, res => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.setTimeout(10000, () => { req.destroy(new Error('Naver detail timeout')); });
  });

  // EUC-KR 디코딩 (UTF-8로 읽으면 한글 정규식이 전혀 매칭되지 않음)
  const html = iconv.decode(buf, 'EUC-KR');

  const expRatio   = html.match(/<td>연<em>([\d.]+%)<\/em><\/td>/)?.[1] ?? '';
  const manager    = html.match(/자산운용사<\/th>[\s\S]*?<span[^>]*>([^<]+)<\/span>/)?.[1]?.trim() ?? '';
  // 상장일: "YYYY.MM.DD" 또는 "YYYY-MM-DD" 두 형식 모두 포착
  const listedDate = html.match(/상장일\s*<\/th>\s*<td[^>]*>([\d.\-]+)<\/td>/)?.[1]?.trim() ?? '';

  return { expRatio, manager, listedDate };
}

// ── 동시성 제한 헬퍼 (전체에서 사용) ─────────────────────────────────────────
async function pLimit<T>(tasks: Array<() => Promise<T>>, concurrency: number): Promise<T[]> {
  const results: T[] = new Array(tasks.length);
  let idx = 0;
  async function worker() {
    while (idx < tasks.length) {
      const i = idx++;
      results[i] = await tasks[i]();
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, tasks.length) }, worker));
  return results;
}

// ── ETF 구성종목 & 평균 시총 ───────────────────────────────────────────────────
interface HoldingInfo {
  code: string;     // 종목코드 (없으면 '')
  name: string;
  weight: number;        // %
  shares?: number;       // 주식수/계약수 (wisereport)
  marketCapBillion: number | null;  // 억원
}

// 캐시: top10 (코드 포함) / full (전체, wisereport)
const _holdingsTop10Cache: Record<string, { h: HoldingInfo[]; ts: number }> = {};
const _holdingsFullCache: Record<string, { h: HoldingInfo[]; ts: number; source?: string }> = {};
const _capCache: Record<string, { cap: number | null; ts: number }> = {};
const HOLDINGS_TTL = 12 * 3600 * 1000;   // 12h
const STOCK_CAP_TTL = 6 * 3600 * 1000;   // 6h — 시총은 장중에도 크게 변하지 않아 크롤링 빈도 절감

// ── 글로벌 종목 시총 캐시 (전일 기준 24h) ───────────────────────────────────────
const _globalCapCache: Record<string, { cap: number | null; ts: number }> = {};
const _fxCache: Record<string, { rate: number; ts: number }> = {};
const GLOBAL_CAP_TTL = 24 * 3600 * 1000;
const FX_TTL = 8 * 3600 * 1000;

type FxCurrency = 'USD' | 'JPY' | 'EUR' | 'GBP' | 'CHF' | 'HKD';

/** 1 단위 외화 → KRW (Yahoo Finance 전일 종가) */
async function fetchKRWRate(currency: FxCurrency): Promise<number> {
  if (currency === 'USD') {
    const pair = 'KRW=X';
    const c = _fxCache[pair];
    if (c && Date.now() - c.ts < FX_TTL) return c.rate;
    try {
      const html = await fetchPageUtf8(
        `https://query1.finance.yahoo.com/v8/finance/chart/KRW=X?interval=1d&range=5d`,
        'https://finance.yahoo.com/'
      );
      const meta = JSON.parse(html)?.chart?.result?.[0]?.meta;
      const rate = meta?.previousClose || meta?.regularMarketPrice || 1350;
      _fxCache[pair] = { rate, ts: Date.now() };
      return rate;
    } catch { return 1350; }
  }
  const yPair = `${currency}KRW=X`;
  const c2 = _fxCache[yPair];
  if (c2 && Date.now() - c2.ts < FX_TTL) return c2.rate;
  try {
    const html = await fetchPageUtf8(
      `https://query1.finance.yahoo.com/v8/finance/chart/${yPair}?interval=1d&range=5d`,
      'https://finance.yahoo.com/'
    );
    const meta = JSON.parse(html)?.chart?.result?.[0]?.meta;
    const defaults: Record<string, number> = { JPY: 9, EUR: 1480, GBP: 1720, CHF: 1520, HKD: 173 };
    const rate = meta?.previousClose || meta?.regularMarketPrice || defaults[currency] || 1000;
    _fxCache[yPair] = { rate, ts: Date.now() };
    return rate;
  } catch {
    const defaults: Record<string, number> = { JPY: 9, EUR: 1480, GBP: 1720, CHF: 1520, HKD: 173 };
    return defaults[currency] || 1000;
  }
}

// ── Naver 해외주식 시총 조회 ──────────────────────────────────────────────────
const _reutersCodeCache: Record<string, string | null> = {};

/** 미국 티커 → Naver reutersCode (자동완성 API, 결과 영구 캐시) */
async function resolveNaverWorldCode(ticker: string): Promise<string | null> {
  if (ticker in _reutersCodeCache) return _reutersCodeCache[ticker];
  try {
    const txt = await fetchPageUtf8(
      `https://ac.stock.naver.com/ac?q=${encodeURIComponent(ticker)}&target=stock`,
      'https://m.stock.naver.com/'
    );
    const items = JSON.parse(txt).items || [];
    // 해외 종목 중 code가 티커와 정확히 일치하는 것 우선 (PL, FN 같은 짧은 티커 오매칭 방지)
    const foreign = items.filter((i: any) => i.nationCode && i.nationCode !== 'KOR' && i.reutersCode);
    const exact = foreign.find((i: any) => i.code === ticker);
    const rc = (exact || (foreign.length === 1 ? foreign[0] : null))?.reutersCode || null;
    _reutersCodeCache[ticker] = rc;
    return rc;
  } catch {
    _reutersCodeCache[ticker] = null;
    return null;
  }
}

/** reutersCode → Naver basic API 시총(억 KRW)
 *  marketValue 형식: "2,210억 USD" / "1.5조 USD" 등 → 억 KRW 환산 */
async function fetchNaverBasicCapKRW(reutersCode: string): Promise<number | null> {
  try {
    const txt = await fetchPageUtf8(
      `https://api.stock.naver.com/stock/${encodeURIComponent(reutersCode)}/basic`,
      'https://m.stock.naver.com/'
    );
    if (!txt || txt[0] !== '{') return null;
    const j = JSON.parse(txt);
    const mv = (j.stockItemTotalInfos || []).find((x: any) => x.code === 'marketValue');
    if (!mv) return null;

    // 1순위: valueDesc = Naver 제공 원화 환산값 ("1,537조 2,700억원" / "8,900억원")
    if (mv.valueDesc) {
      const s = String(mv.valueDesc).replace(/,/g, '');
      const jo = s.match(/([\d.]+)\s*조/);
      const uk = s.match(/(?:조\s*)?([\d.]+)\s*억/);
      const total = (jo ? parseFloat(jo[1]) * 10000 : 0) + (uk ? parseFloat(uk[1]) : 0);
      if (isFinite(total) && total > 0) return Math.round(total);
    }

    // 2순위: value = 외화 표기 ("1조 58억 USD" / "2210억 USD") → 환율 환산
    if (!mv.value) return null;
    const s2 = String(mv.value).replace(/,/g, '');
    const curM = s2.match(/([A-Z]{3})\s*$/);
    const jo2 = s2.match(/([\d.]+)\s*조/);
    const uk2 = s2.match(/(?:조\s*)?([\d.]+)\s*억/);
    let amount = (jo2 ? parseFloat(jo2[1]) * 10000 : 0) + (uk2 ? parseFloat(uk2[1]) : 0);
    if (!jo2 && !uk2) {
      const plain = s2.match(/^([\d.]+)/);     // 단위 없는 순수 숫자 (가능성 낮음)
      amount = plain ? parseFloat(plain[1]) : 0;
    }
    if (!isFinite(amount) || amount <= 0) return null;
    const cur = curM ? curM[1] : 'USD';
    const fxCur: FxCurrency = (['USD','JPY','EUR','GBP','CHF','HKD'].includes(cur) ? cur : 'USD') as FxCurrency;
    const rate = await fetchKRWRate(fxCur);   // 1 외화당 KRW
    return Math.round(amount * rate);         // 억 외화 × KRW환율 = 억 KRW
  } catch {
    return null;
  }
}

/** 티커 → Naver 실시간 시총(억 KRW) */
async function fetchNaverWorldCapKRW(ticker: string): Promise<number | null> {
  const rc = await resolveNaverWorldCode(ticker);
  if (!rc) return null;
  return fetchNaverBasicCapKRW(rc);
}

// ── 회사명 → 시총 (GLOBAL_TICKER_MAP 미등록 종목 자동 해결) ──────────────────
const _nameCapCache: Record<string, { cap: number | null; ts: number }> = {};

/** 영문/한글 회사명으로 Naver 자동완성 검색 → 해외종목 시총(억 KRW) */
async function fetchNaverWorldCapByName(rawName: string): Promise<number | null> {
  const key = rawName.toLowerCase().trim();
  const c = _nameCapCache[key];
  if (c && Date.now() - c.ts < GLOBAL_CAP_TTL) return c.cap;

  try {
    // 법인 접미사·클래스 표기 제거: "ZEBRA TECHNOLOGIES CORP-CL A" → "ZEBRA TECHNOLOGIES"
    const cleaned = rawName
      .replace(/-?\s*(CL|CLASS)\s*[A-Z]$/i, '')
      .replace(/\b(INC|CORP|CO|PLC|LTD|LLC|SA|NV|AG|SE|OYJ|PBC|ADR|HOLDINGS?|GROUP)\b\.?/gi, ' ')
      .replace(/[,\.&']/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (cleaned.length < 2) { _nameCapCache[key] = { cap: null, ts: Date.now() }; return null; }

    const txt = await fetchPageUtf8(
      `https://ac.stock.naver.com/ac?q=${encodeURIComponent(cleaned)}&target=stock`,
      'https://m.stock.naver.com/'
    );
    const foreign = (JSON.parse(txt).items || [])
      .filter((i: any) => i.nationCode && i.nationCode !== 'KOR' && i.reutersCode);
    if (!foreign.length) { _nameCapCache[key] = { cap: null, ts: Date.now() }; return null; }

    const cap = await fetchNaverBasicCapKRW(foreign[0].reutersCode);
    _nameCapCache[key] = { cap, ts: Date.now() };
    return cap;
  } catch {
    _nameCapCache[key] = { cap: null, ts: Date.now() };
    return null;
  }
}

/** 해외종목 시총(억 KRW) 조회: 1차 Naver 실시간 → 2차 정적 추정표 폴백 */
async function fetchYahooMarketCapKRW(ticker: string, currency: FxCurrency): Promise<number | null> {
  const cacheKey = ticker;
  const cached = _globalCapCache[cacheKey];
  if (cached && Date.now() - cached.ts < GLOBAL_CAP_TTL) return cached.cap;

  // 1차: Naver 해외주식 실시간 시총 (전일 종가 기준, 환율 반영)
  const naverCap = await fetchNaverWorldCapKRW(ticker);
  if (naverCap !== null) {
    _globalCapCache[cacheKey] = { cap: naverCap, ts: Date.now() };
    return naverCap;
  }

  // 기준 시가총액 표 (USD 기준, 2025년 초 기준값 × 현재가 비율로 조정)
  // 값: [기준가(USD), 기준시총(억 KRW)] — 기준 환율 1400원 기준
  const STATIC_CAP_KRW: Record<string, number> = {
    // 미국 빅테크 (2025년 기준시총, 억KRW)
    'NVDA':   49000000, 'AAPL':  44000000, 'MSFT':  38000000, 'AMZN': 24000000,
    'META':   18000000, 'GOOGL': 22000000, 'GOOG':  22000000, 'TSLA': 10000000,
    'AVGO':   10000000, 'NFLX':   4000000, 'AMD':    1500000, 'INTC':   980000,
    'QCOM':   2000000, 'ADBE':   2000000, 'CRM':   2500000, 'TXN':  2500000,
    'MU':     1500000, 'AMAT':  1500000, 'ASML':  3500000, 'INTU': 2000000,
    'PLTR':   3000000, 'ORCL':  5000000, 'CSCO':  2500000, 'NOW':  2500000,
    'WDAY':    800000, 'SNOW':   500000, 'DDOG':   500000, 'CRWD': 1000000,
    'PANW':   1200000, 'NET':    600000, 'SMCI':   300000, 'DELL': 700000,
    'ARM':    1500000,
    // 미국 금융
    'JPM':    7500000, 'V':    5500000, 'MA':    5000000, 'BAC':  4000000,
    'WFC':    2500000, 'GS':   2000000, 'MS':    2000000, 'AXP': 2500000,
    'BLK':    2000000, 'C':    1000000, 'BRK-B': 12000000, 'BRK-A': 12000000,
    // 미국 헬스케어
    'LLY':    8000000, 'UNH':  5500000, 'JNJ':  4000000, 'ABBV': 4000000,
    'MRK':    3000000, 'PFE':  2000000, 'TMO':  2500000, 'ISRG': 2000000,
    'REGN':  1500000, 'VRTX': 1500000, 'NVO':  5000000, 'AZN': 3000000,
    'MRNA':   200000, 'GILD': 1500000, 'AMGN': 1500000, 'ABT': 2500000,
    // 미국 소비재
    'COST':   4500000, 'HD':   4000000, 'WMT':  9000000, 'NKE': 1000000,
    'MCD':    2500000, 'SBUX': 1000000, 'PG':   4000000, 'KO':  3000000,
    'PEP':    2500000, 'BKNG': 2000000, 'ABNB':  700000, 'UBER': 2000000,
    'PM':    2000000, 'CL':    700000, 'MDLZ':  700000, 'HLT': 700000,
    'MAR':   1000000, 'F':     700000, 'GM':    700000, 'RIVN': 150000,
    'CMCSA': 1500000,
    // 미국 에너지/원자재
    'XOM':   5000000, 'CVX':  3000000, 'COP':  1500000, 'FCX':  700000,
    'NEM':    500000, 'GOLD':  400000, 'LIN':  2000000,
    // 미국 산업재/방산
    'CAT':   2000000, 'BA':   1100000, 'LMT':  1500000, 'RTX': 2200000,
    'GE':    2500000, 'HON':  1800000, 'UPS':  1500000, 'FDX': 900000,
    'UNP':   1500000, 'DE':   1500000, 'ETN':  1500000, 'VRT':  800000,
    'NOC':    770000, 'GD':    910000, 'LHX':  308000,  'HII':  154000,
    'HWM':    630000, 'MOG.A':  49000, 'TDG':  420000,
    // 미국 통신/유틸리티/리츠
    'T':     1000000, 'VZ':  1000000, 'TMUS': 2500000, 'NEE': 1500000,
    'AMT':   1000000, 'PLD': 1500000, 'EQIX': 1000000,
    // 기타 미국 금융/지수
    'SPGI':  1500000, 'MSCI':  500000, 'ICE':  900000, 'CME': 1000000,
    'SCHW':  1700000, 'CB':    1100000, 'PGR':  1600000,
    // 미국 헬스케어 추가 (위에 없는 것만)
    'ILMN':   300000, 'BIIB':   400000, 'ALNY':  560000,
    'NTRA':   430000, 'IONS':   180000, 'ARWR':   155000,
    'RVTY':   155000, 'MEDP':   170000, 'ICLR':   133000, 'EXEL':   171000,
    // 양자컴퓨팅
    'IBM':   2100000, 'IONQ':   98000, 'RGTI':   42000, 'QBTS':   28000,
    'QUBT':   42000,  'ARQQ':   14000,
    // 로봇/자동화/산업재 추가
    'ROK':    700000, 'EMR':    700000, 'ABB':   1000000,
    // 우주/방산 추가
    'KTOS':    84000, 'RKLB':   56000, 'SPCE':    4000,
    'AJRD':   140000, 'BWXT':  126000, 'VSAT':   28000,
    'ASTS':    84000, 'PL':     14000, 'RDW':     7000,
    'MNTS':     3500, 'ASTR':    1400, 'NARO':    2800,
    // AI 광통신/네트워크
    'NOK':    440000, 'COHR':   210000, 'LITE':   110000, 'CIEN':   170000,
    'MRVL':   830000, 'AAOI':    20000, 'GLW':    620000, 'TSEM':    70000,
    'CLS':    170000, 'FN':     110000, 'ANET':  1700000, 'JNPR':   180000,
    'EXTR':    25000, 'INFN':    30000, 'VIAV':    25000, 'ALAB':   170000,
    'CRDO':   110000,
    // 에너지/원자력 추가
    'CCJ':    700000, 'NNE':    280000, 'SMR':   140000, 'OKLO':   126000,
    'VST':   1400000, 'CEG':    840000, 'NRG':    420000,
    // 2차전지/EV 추가 (TSLA는 위에 있음)
    'NIO':    140000, 'XPEV':   140000, 'LI':    280000,
    'QS':     56000,  'CHPT':   14000,  'BLNK':    7000,
    // 인도/신흥국
    'INFY':  700000, 'WIT':   280000, 'RELIANCE.NS': 3000000,
    // 일본 (JPY 기준 KRW 환산)
    '7203.T': 3500000, '6758.T': 1800000, '9984.T': 1200000, '6861.T': 1500000,
    '8306.T': 2000000, '7974.T': 1000000, '6098.T': 1200000, '8035.T': 2500000,
    '9983.T': 1000000, '6857.T': 1800000, '6501.T':  800000, '4063.T':  700000,
    '6367.T':  800000, '7267.T':  700000, '6981.T':  700000, '8316.T': 1000000,
    '7751.T':  400000, '8058.T': 1500000, '8001.T': 1500000, '4502.T':  700000,
    // 유럽 ADR (USD 기준 KRW)
    'LVMUY': 3500000, 'NVS':  2000000, 'RHHBY': 2500000, 'SAP': 3000000,
    'SHEL':  2500000, 'BP':   1000000, 'UL':    900000, 'HSBC': 2000000,
    'TTE':   1800000, 'SIEGY': 1500000, 'ALIZY': 1000000, 'NSRGY': 2500000,
    // 유럽 방산 (현지 상장, 억KRW 기준)
    'AIR.PA':  2200000,  // Airbus          ~€150B
    'RR.L':     950000,  // Rolls-Royce     ~£55B
    'SAF.PA':  1100000,  // Safran          ~€75B
    'BA.L':     690000,  // BAE Systems     ~£40B
    'HO.PA':    560000,  // Thales          ~€38B
    'LDO.MI':   310000,  // Leonardo        ~€21B
    'RHM.DE':   810000,  // Rheinmetall     ~€55B
    'KOG.OL':   390000,  // Kongsberg       ~NOK280B≈$26B
    'SAAB-B.ST':240000,  // Saab            ~SEK160B≈$15B
    'AM.PA':    270000,  // Dassault Aviatn ~€18B
    'IDR.MC':    60000,  // Indra Sistemas  ~€4B
    'HAG.DE':   190000,  // Hensoldt        ~€13B
    'MTX.DE':   210000,  // MTU Aero Engines~€14B
    'QQ.L':     140000,  // QinetiQ         ~£8B
    'BAB.L':     90000,  // Babcock Intl    ~£5B
    'CSG.AS':   250000,  // CSG NV (Czech)  ~€17B (2026.01 IPO)
    // 중국/홍콩 (HKD 기준 KRW)
    '0700.HK': 4000000, 'BABA': 2500000, 'JD': 800000, 'PDD': 2000000,
    'NTES':   500000, 'BIDU': 400000, '3690.HK': 1500000, '1211.HK': 1500000,
    // 기타 글로벌
    '005930.KS': 3000000, 'TSM': 9000000,
  };

  const baseCap = STATIC_CAP_KRW[ticker];
  if (!baseCap) {
    _globalCapCache[cacheKey] = { cap: null, ts: Date.now() };
    return null;
  }
  _globalCapCache[cacheKey] = { cap: baseCap, ts: Date.now() };
  return baseCap;
}

// ── 글로벌 종목 한글명 → Yahoo ticker 사전 ─────────────────────────────────────
const GLOBAL_TICKER_MAP: Record<string, { ticker: string; currency: FxCurrency }> = {
  // ─ 미국 빅테크 / 나스닥100 ────────────────────────────────────
  '애플':                        { ticker: 'AAPL',  currency: 'USD' },
  '마이크로소프트':               { ticker: 'MSFT',  currency: 'USD' },
  '엔비디아':                    { ticker: 'NVDA',  currency: 'USD' },
  '아마존닷컴':                   { ticker: 'AMZN',  currency: 'USD' },
  '아마존':                      { ticker: 'AMZN',  currency: 'USD' },
  '알파벳A':                     { ticker: 'GOOGL', currency: 'USD' },
  '알파벳 A':                    { ticker: 'GOOGL', currency: 'USD' },
  '알파벳C':                     { ticker: 'GOOG',  currency: 'USD' },
  '알파벳 C':                    { ticker: 'GOOG',  currency: 'USD' },
  '메타 플랫폼스':                { ticker: 'META',  currency: 'USD' },
  '메타플랫폼스':                 { ticker: 'META',  currency: 'USD' },
  '메타':                        { ticker: 'META',  currency: 'USD' },
  '테슬라':                      { ticker: 'TSLA',  currency: 'USD' },
  '브로드컴':                    { ticker: 'AVGO',  currency: 'USD' },
  '넷플릭스':                    { ticker: 'NFLX',  currency: 'USD' },
  '어드밴스드마이크로디바이스':   { ticker: 'AMD',   currency: 'USD' },
  '어드밴스드 마이크로 디바이스': { ticker: 'AMD',   currency: 'USD' },
  'AMD':                         { ticker: 'AMD',   currency: 'USD' },
  '인텔':                        { ticker: 'INTC',  currency: 'USD' },
  '퀄컴':                        { ticker: 'QCOM',  currency: 'USD' },
  '어도비':                      { ticker: 'ADBE',  currency: 'USD' },
  '세일즈포스':                   { ticker: 'CRM',   currency: 'USD' },
  '텍사스인스트루먼트':            { ticker: 'TXN',   currency: 'USD' },
  '텍사스 인스트루먼트':          { ticker: 'TXN',   currency: 'USD' },
  '마이크론테크놀로지':            { ticker: 'MU',    currency: 'USD' },
  '마이크론 테크놀로지':          { ticker: 'MU',    currency: 'USD' },
  '어플라이드머티어리얼즈':        { ticker: 'AMAT',  currency: 'USD' },
  'ASML홀딩':                    { ticker: 'ASML',  currency: 'USD' },
  'ASML 홀딩':                   { ticker: 'ASML',  currency: 'USD' },
  '인튜이트':                    { ticker: 'INTU',  currency: 'USD' },
  '팔란티어테크놀로지스':          { ticker: 'PLTR',  currency: 'USD' },
  '팔란티어 테크놀로지스':        { ticker: 'PLTR',  currency: 'USD' },
  '팔란티어':                    { ticker: 'PLTR',  currency: 'USD' },
  '오라클':                      { ticker: 'ORCL',  currency: 'USD' },
  '시스코시스템스':               { ticker: 'CSCO',  currency: 'USD' },
  '서비스나우':                   { ticker: 'NOW',   currency: 'USD' },
  '워크데이':                    { ticker: 'WDAY',  currency: 'USD' },
  '스노우플레이크':               { ticker: 'SNOW',  currency: 'USD' },
  '데이터독':                    { ticker: 'DDOG',  currency: 'USD' },
  '크라우드스트라이크':            { ticker: 'CRWD',  currency: 'USD' },
  '팔로알토네트웍스':              { ticker: 'PANW',  currency: 'USD' },
  '팔로알토 네트웍스':            { ticker: 'PANW',  currency: 'USD' },
  '클라우드플레어':               { ticker: 'NET',   currency: 'USD' },
  '줌비디오':                    { ticker: 'ZM',    currency: 'USD' },
  '슈퍼마이크로컴퓨터':           { ticker: 'SMCI',  currency: 'USD' },
  '슈퍼마이크로 컴퓨터':         { ticker: 'SMCI',  currency: 'USD' },
  '델테크놀로지스':               { ticker: 'DELL',  currency: 'USD' },
  '델 테크놀로지스':             { ticker: 'DELL',  currency: 'USD' },
  'ARM':                         { ticker: 'ARM',   currency: 'USD' },
  // ─ 미국 금융 ────────────────────────────────────────────────
  'JP모건체이스':                 { ticker: 'JPM',   currency: 'USD' },
  'JP모건 체이스':               { ticker: 'JPM',   currency: 'USD' },
  '비자':                        { ticker: 'V',     currency: 'USD' },
  '마스터카드':                   { ticker: 'MA',    currency: 'USD' },
  '뱅크오브아메리카':              { ticker: 'BAC',   currency: 'USD' },
  '뱅크 오브 아메리카':          { ticker: 'BAC',   currency: 'USD' },
  '웰스파고':                    { ticker: 'WFC',   currency: 'USD' },
  '골드만삭스그룹':               { ticker: 'GS',    currency: 'USD' },
  '골드만 삭스':                 { ticker: 'GS',    currency: 'USD' },
  '모건스탠리':                   { ticker: 'MS',    currency: 'USD' },
  '모건 스탠리':                 { ticker: 'MS',    currency: 'USD' },
  '아메리칸익스프레스':            { ticker: 'AXP',   currency: 'USD' },
  '블랙록':                      { ticker: 'BLK',   currency: 'USD' },
  '씨티그룹':                    { ticker: 'C',     currency: 'USD' },
  '버크셔해서웨이B':              { ticker: 'BRK-B', currency: 'USD' },
  '버크셔해서웨이 B':            { ticker: 'BRK-B', currency: 'USD' },
  '버크셔 해서웨이':             { ticker: 'BRK-B', currency: 'USD' },
  // ─ 미국 헬스케어 ────────────────────────────────────────────
  '일라이릴리':                   { ticker: 'LLY',   currency: 'USD' },
  '일라이 릴리':                 { ticker: 'LLY',   currency: 'USD' },
  '일라이릴리앤드컴퍼니':         { ticker: 'LLY',   currency: 'USD' },
  '유나이티드헬스그룹':            { ticker: 'UNH',   currency: 'USD' },
  '유나이티드 헬스그룹':          { ticker: 'UNH',   currency: 'USD' },
  '존슨앤드존슨':                 { ticker: 'JNJ',   currency: 'USD' },
  '존슨 앤드 존슨':              { ticker: 'JNJ',   currency: 'USD' },
  '애브비':                      { ticker: 'ABBV',  currency: 'USD' },
  '머크':                        { ticker: 'MRK',   currency: 'USD' },
  '화이자':                      { ticker: 'PFE',   currency: 'USD' },
  '서모피셔사이언티픽':            { ticker: 'TMO',   currency: 'USD' },
  '인튜이티브서지컬':              { ticker: 'ISRG',  currency: 'USD' },
  '리제네론파마슈티컬스':          { ticker: 'REGN',  currency: 'USD' },
  '버텍스파마슈티컬스':            { ticker: 'VRTX',  currency: 'USD' },
  '노보노디스크':                 { ticker: 'NVO',   currency: 'USD' },
  '아스트라제네카':               { ticker: 'AZN',   currency: 'USD' },
  '모더나':                      { ticker: 'MRNA',  currency: 'USD' },
  '길리어드사이언시스':            { ticker: 'GILD',  currency: 'USD' },
  '암젠':                        { ticker: 'AMGN',  currency: 'USD' },
  '일루미나':                    { ticker: 'ILMN',  currency: 'USD' },
  '바이오젠':                    { ticker: 'BIIB',  currency: 'USD' },
  '알닐람파마슈티컬스':           { ticker: 'ALNY',  currency: 'USD' },
  '나테라':                      { ticker: 'NTRA',  currency: 'USD' },
  '테바파마슈티컬':               { ticker: 'TEVA',  currency: 'USD' },
  '이오니스파마슈티컬스':          { ticker: 'IONS',  currency: 'USD' },
  '아로우헤드파마슈티컬스':        { ticker: 'ARWR',  currency: 'USD' },
  '메드페이스홀딩스':              { ticker: 'MEDP',  currency: 'USD' },
  '아이콘PLC':                   { ticker: 'ICLR',  currency: 'USD' },
  '엑셀리시스':                   { ticker: 'EXEL',  currency: 'USD' },
  '리비티인크':                   { ticker: 'RVTY',  currency: 'USD' },
  '사노피':                      { ticker: 'SNY',   currency: 'USD' },
  // ─ 양자컴퓨팅 ──────────────────────────────────────────────
  'IBM':                         { ticker: 'IBM',   currency: 'USD' },
  '아이비엠':                    { ticker: 'IBM',   currency: 'USD' },
  '아이온큐':                    { ticker: 'IONQ',  currency: 'USD' },
  'IonQ':                        { ticker: 'IONQ',  currency: 'USD' },
  '리게티컴퓨팅':                 { ticker: 'RGTI',  currency: 'USD' },
  'Rigetti Computing':           { ticker: 'RGTI',  currency: 'USD' },
  'D-Wave Quantum':              { ticker: 'QBTS',  currency: 'USD' },
  'Quantum Computing':           { ticker: 'QUBT',  currency: 'USD' },
  // ─ 미국 소비재 ─────────────────────────────────────────────
  '코스트코홀세일':               { ticker: 'COST',  currency: 'USD' },
  '코스트코 홀세일':             { ticker: 'COST',  currency: 'USD' },
  '홈디포':                      { ticker: 'HD',    currency: 'USD' },
  '홈 디포':                    { ticker: 'HD',    currency: 'USD' },
  '월마트':                      { ticker: 'WMT',   currency: 'USD' },
  '나이키':                      { ticker: 'NKE',   currency: 'USD' },
  '맥도날드':                    { ticker: 'MCD',   currency: 'USD' },
  '스타벅스':                    { ticker: 'SBUX',  currency: 'USD' },
  '프록터앤드갬블':               { ticker: 'PG',    currency: 'USD' },
  '프록터 앤드 갬블':            { ticker: 'PG',    currency: 'USD' },
  '코카콜라':                    { ticker: 'KO',    currency: 'USD' },
  '펩시코':                      { ticker: 'PEP',   currency: 'USD' },
  '부킹홀딩스':                   { ticker: 'BKNG',  currency: 'USD' },
  '부킹 홀딩스':                 { ticker: 'BKNG',  currency: 'USD' },
  '에어비앤비':                   { ticker: 'ABNB',  currency: 'USD' },
  '우버테크놀로지스':              { ticker: 'UBER',  currency: 'USD' },
  '우버 테크놀로지스':            { ticker: 'UBER',  currency: 'USD' },
  '리비안':                      { ticker: 'RIVN',  currency: 'USD' },
  '힐튼월드와이드':               { ticker: 'HLT',   currency: 'USD' },
  '매리어트인터내셔널':            { ticker: 'MAR',   currency: 'USD' },
  '몬덜리즈인터내셔널':            { ticker: 'MDLZ',  currency: 'USD' },
  '필립모리스인터내셔널':          { ticker: 'PM',    currency: 'USD' },
  // ─ 미국 에너지/원자재 ──────────────────────────────────────
  '엑슨모빌':                    { ticker: 'XOM',   currency: 'USD' },
  '쉐브론':                      { ticker: 'CVX',   currency: 'USD' },
  '코노코필립스':                 { ticker: 'COP',   currency: 'USD' },
  '프리포트맥모런':               { ticker: 'FCX',   currency: 'USD' },
  '뉴몬트':                      { ticker: 'NEM',   currency: 'USD' },
  '바릭골드':                    { ticker: 'GOLD',  currency: 'USD' },
  // ─ 미국 산업재/방산 ────────────────────────────────────────
  '캐터필러':                    { ticker: 'CAT',   currency: 'USD' },
  '보잉':                        { ticker: 'BA',    currency: 'USD' },
  '록히드마틴':                   { ticker: 'LMT',   currency: 'USD' },
  '록히드 마틴':                 { ticker: 'LMT',   currency: 'USD' },
  '레이시온테크놀로지스':          { ticker: 'RTX',   currency: 'USD' },
  '제너럴일렉트릭':               { ticker: 'GE',    currency: 'USD' },
  'GE에어로스페이스':             { ticker: 'GE',    currency: 'USD' },
  '하니웰인터내셔널':              { ticker: 'HON',   currency: 'USD' },
  '유나이티드파슬서비스':          { ticker: 'UPS',   currency: 'USD' },
  '페덱스':                      { ticker: 'FDX',   currency: 'USD' },
  '유니온퍼시픽':                 { ticker: 'UNP',   currency: 'USD' },
  '디어앤드컴퍼니':               { ticker: 'DE',    currency: 'USD' },
  '이튼':                        { ticker: 'ETN',   currency: 'USD' },
  '버티브홀딩스':                 { ticker: 'VRT',   currency: 'USD' },
  '버티브 홀딩스':               { ticker: 'VRT',   currency: 'USD' },
  '노스롭그루먼':                 { ticker: 'NOC',   currency: 'USD' },
  'RTX':                         { ticker: 'RTX',   currency: 'USD' },
  // ─ 미국 통신/유틸리티 ──────────────────────────────────────
  '버라이즌커뮤니케이션스':        { ticker: 'VZ',    currency: 'USD' },
  'AT&T':                        { ticker: 'T',     currency: 'USD' },
  'T-모바일':                    { ticker: 'TMUS',  currency: 'USD' },
  '넥스트에라에너지':              { ticker: 'NEE',   currency: 'USD' },
  '아메리칸타워':                 { ticker: 'AMT',   currency: 'USD' },
  '프롤로지스':                   { ticker: 'PLD',   currency: 'USD' },
  '이퀴닉스':                    { ticker: 'EQIX',  currency: 'USD' },
  // ─ 일본 ────────────────────────────────────────────────────
  '도요타자동차':                 { ticker: '7203.T', currency: 'JPY' },
  '소니그룹':                    { ticker: '6758.T', currency: 'JPY' },
  '소프트뱅크그룹':               { ticker: '9984.T', currency: 'JPY' },
  '키엔스':                      { ticker: '6861.T', currency: 'JPY' },
  '미쓰비시UFJ금융그룹':          { ticker: '8306.T', currency: 'JPY' },
  '닌텐도':                      { ticker: '7974.T', currency: 'JPY' },
  '리크루트홀딩스':               { ticker: '6098.T', currency: 'JPY' },
  '도쿄일렉트론':                 { ticker: '8035.T', currency: 'JPY' },
  '패스트리테일링':               { ticker: '9983.T', currency: 'JPY' },
  '아드반테스트':                 { ticker: '6857.T', currency: 'JPY' },
  '히타치제작소':                 { ticker: '6501.T', currency: 'JPY' },
  '신에츠화학공업':               { ticker: '4063.T', currency: 'JPY' },
  '다이킨공업':                   { ticker: '6367.T', currency: 'JPY' },
  '혼다기연공업':                 { ticker: '7267.T', currency: 'JPY' },
  '무라타제작소':                 { ticker: '6981.T', currency: 'JPY' },
  '스미토모미쓰이금융그룹':        { ticker: '8316.T', currency: 'JPY' },
  '캐논':                        { ticker: '7751.T', currency: 'JPY' },
  '미쓰비시상사':                 { ticker: '8058.T', currency: 'JPY' },
  '이토추상사':                   { ticker: '8001.T', currency: 'JPY' },
  '다케다약품공업':               { ticker: '4502.T', currency: 'JPY' },
  // ─ 유럽 (ADR 또는 직접 상장) ───────────────────────────────
  'LVMH':                        { ticker: 'LVMUY', currency: 'USD' },
  '노바티스':                    { ticker: 'NVS',   currency: 'USD' },
  '로슈홀딩':                    { ticker: 'RHHBY', currency: 'USD' },
  'SAP':                         { ticker: 'SAP',   currency: 'USD' },
  '아스트라제네카ADR':            { ticker: 'AZN',   currency: 'USD' },
  '셸':                          { ticker: 'SHEL',  currency: 'USD' },
  'BP':                          { ticker: 'BP',    currency: 'USD' },
  '유니레버':                    { ticker: 'UL',    currency: 'USD' },
  'HSBC홀딩스':                  { ticker: 'HSBC',  currency: 'USD' },
  '토탈에너지스':                 { ticker: 'TTE',   currency: 'USD' },
  '지멘스':                      { ticker: 'SIEGY', currency: 'USD' },
  '알리안츠':                    { ticker: 'ALIZY', currency: 'USD' },
  'BNP파리바':                   { ticker: 'BNPQY', currency: 'USD' },
  '네슬레':                      { ticker: 'NSRGY', currency: 'USD' },
  // ─ 중국/홍콩 ───────────────────────────────────────────────
  '텐센트홀딩스':                 { ticker: '0700.HK', currency: 'HKD' },
  '알리바바그룹':                 { ticker: 'BABA',  currency: 'USD' },
  '알리바바그룹홀딩':             { ticker: 'BABA',  currency: 'USD' },
  'JD닷컴':                      { ticker: 'JD',    currency: 'USD' },
  '핀둬둬홀딩스':                 { ticker: 'PDD',   currency: 'USD' },
  '넷이즈':                      { ticker: 'NTES',  currency: 'USD' },
  '바이두':                      { ticker: 'BIDU',  currency: 'USD' },
  '메이투안':                    { ticker: '3690.HK', currency: 'HKD' },
  '비야디':                      { ticker: '1211.HK', currency: 'HKD' },
  // ─ 기타 글로벌 ─────────────────────────────────────────────
  '삼성전자':                    { ticker: '005930.KS', currency: 'USD' },
  'TSMC':                        { ticker: 'TSM',   currency: 'USD' },
  '타이완세미컨덕터':              { ticker: 'TSM',   currency: 'USD' },
  '타이완반도체':                 { ticker: 'TSM',   currency: 'USD' },

  // ─ 영문명 (wisereport STK_NM_KOR가 영문으로 오는 경우) ─────────────────────
  // 미국 빅테크 / 나스닥100
  'NVIDIA CORP':                  { ticker: 'NVDA',  currency: 'USD' },
  'APPLE INC':                    { ticker: 'AAPL',  currency: 'USD' },
  'MICROSOFT CORP':               { ticker: 'MSFT',  currency: 'USD' },
  'AMAZON.COM INC':               { ticker: 'AMZN',  currency: 'USD' },
  'META PLATFORMS INC':           { ticker: 'META',  currency: 'USD' },
  'META PLATFORMS INC-CLASS A':   { ticker: 'META',  currency: 'USD' },
  'ALPHABET INC-CL A':            { ticker: 'GOOGL', currency: 'USD' },
  'ALPHABET INC-CL C':            { ticker: 'GOOG',  currency: 'USD' },
  'ALPHABET INC-CLASS A':         { ticker: 'GOOGL', currency: 'USD' },
  'ALPHABET INC-CLASS C':         { ticker: 'GOOG',  currency: 'USD' },
  'TESLA INC':                    { ticker: 'TSLA',  currency: 'USD' },
  'BROADCOM INC':                 { ticker: 'AVGO',  currency: 'USD' },
  'NETFLIX INC':                  { ticker: 'NFLX',  currency: 'USD' },
  'ADVANCED MICRO DEVICES':       { ticker: 'AMD',   currency: 'USD' },
  'ADVANCED MICRO DEVICES INC':   { ticker: 'AMD',   currency: 'USD' },
  'INTEL CORP':                   { ticker: 'INTC',  currency: 'USD' },
  'QUALCOMM INC':                 { ticker: 'QCOM',  currency: 'USD' },
  'ADOBE INC':                    { ticker: 'ADBE',  currency: 'USD' },
  'SALESFORCE INC':               { ticker: 'CRM',   currency: 'USD' },
  'TEXAS INSTRUMENTS INC':        { ticker: 'TXN',   currency: 'USD' },
  'MICRON TECHNOLOGY INC':        { ticker: 'MU',    currency: 'USD' },
  'APPLIED MATERIALS INC':        { ticker: 'AMAT',  currency: 'USD' },
  'ASML HOLDING NV':              { ticker: 'ASML',  currency: 'USD' },
  'INTUIT INC':                   { ticker: 'INTU',  currency: 'USD' },
  'PALANTIR TECHNOLOGIES INC-A':  { ticker: 'PLTR',  currency: 'USD' },
  'PALANTIR TECHNOLOGIES INC':    { ticker: 'PLTR',  currency: 'USD' },
  'ORACLE CORP':                  { ticker: 'ORCL',  currency: 'USD' },
  'CISCO SYSTEMS INC':            { ticker: 'CSCO',  currency: 'USD' },
  'SERVICENOW INC':               { ticker: 'NOW',   currency: 'USD' },
  'WORKDAY INC':                  { ticker: 'WDAY',  currency: 'USD' },
  'SNOWFLAKE INC':                { ticker: 'SNOW',  currency: 'USD' },
  'DATADOG INC-CLASS A':          { ticker: 'DDOG',  currency: 'USD' },
  'CROWDSTRIKE HOLDINGS INC-A':   { ticker: 'CRWD',  currency: 'USD' },
  'PALO ALTO NETWORKS INC':       { ticker: 'PANW',  currency: 'USD' },
  'CLOUDFLARE INC - CLASS A':     { ticker: 'NET',   currency: 'USD' },
  'CLOUDFLARE INC-CLASS A':       { ticker: 'NET',   currency: 'USD' },
  'SUPER MICRO COMPUTER INC':     { ticker: 'SMCI',  currency: 'USD' },
  'DELL TECHNOLOGIES INC':        { ticker: 'DELL',  currency: 'USD' },
  'ARM HOLDINGS PLC':             { ticker: 'ARM',   currency: 'USD' },
  // 미국 금융
  'JPMORGAN CHASE & CO':          { ticker: 'JPM',   currency: 'USD' },
  'VISA INC-CLASS A SHARES':      { ticker: 'V',     currency: 'USD' },
  'VISA INC':                     { ticker: 'V',     currency: 'USD' },
  'MASTERCARD INC-CLASS A':       { ticker: 'MA',    currency: 'USD' },
  'MASTERCARD INC':               { ticker: 'MA',    currency: 'USD' },
  'BANK OF AMERICA CORP':         { ticker: 'BAC',   currency: 'USD' },
  'WELLS FARGO & CO':             { ticker: 'WFC',   currency: 'USD' },
  'GOLDMAN SACHS GROUP INC/THE':  { ticker: 'GS',    currency: 'USD' },
  'MORGAN STANLEY':               { ticker: 'MS',    currency: 'USD' },
  'AMERICAN EXPRESS CO':          { ticker: 'AXP',   currency: 'USD' },
  'BLACKROCK INC':                { ticker: 'BLK',   currency: 'USD' },
  'CITIGROUP INC':                { ticker: 'C',     currency: 'USD' },
  'BERKSHIRE HATHAWAY INC-CL B':  { ticker: 'BRK-B', currency: 'USD' },
  'BERKSHIRE HATHAWAY INC-CL A':  { ticker: 'BRK-A', currency: 'USD' },
  // 미국 헬스케어
  'ELI LILLY & CO':               { ticker: 'LLY',   currency: 'USD' },
  'UNITEDHEALTH GROUP INC':       { ticker: 'UNH',   currency: 'USD' },
  'JOHNSON & JOHNSON':            { ticker: 'JNJ',   currency: 'USD' },
  'ABBVIE INC':                   { ticker: 'ABBV',  currency: 'USD' },
  'MERCK & CO INC':               { ticker: 'MRK',   currency: 'USD' },
  'PFIZER INC':                   { ticker: 'PFE',   currency: 'USD' },
  'THERMO FISHER SCIENTIFIC INC': { ticker: 'TMO',   currency: 'USD' },
  'INTUITIVE SURGICAL INC':       { ticker: 'ISRG',  currency: 'USD' },
  'REGENERON PHARMACEUTICALS INC':{ ticker: 'REGN',  currency: 'USD' },
  'VERTEX PHARMACEUTICALS INC':   { ticker: 'VRTX',  currency: 'USD' },
  'NOVO NORDISK A/S-B':           { ticker: 'NVO',   currency: 'USD' },
  'ASTRAZENECA PLC':              { ticker: 'AZN',   currency: 'USD' },
  'MODERNA INC':                  { ticker: 'MRNA',  currency: 'USD' },
  'GILEAD SCIENCES INC':          { ticker: 'GILD',  currency: 'USD' },
  'AMGEN INC':                    { ticker: 'AMGN',  currency: 'USD' },
  'ABBOTT LABORATORIES':          { ticker: 'ABT',   currency: 'USD' },
  // 미국 소비재
  'COSTCO WHOLESALE CORP':        { ticker: 'COST',  currency: 'USD' },
  'HOME DEPOT INC/THE':           { ticker: 'HD',    currency: 'USD' },
  'WALMART INC':                  { ticker: 'WMT',   currency: 'USD' },
  'NIKE INC -CL B':               { ticker: 'NKE',   currency: 'USD' },
  'NIKE INC':                     { ticker: 'NKE',   currency: 'USD' },
  "MCDONALD'S CORP":              { ticker: 'MCD',   currency: 'USD' },
  'STARBUCKS CORP':               { ticker: 'SBUX',  currency: 'USD' },
  'PROCTER & GAMBLE CO/THE':      { ticker: 'PG',    currency: 'USD' },
  'COCA-COLA CO/THE':             { ticker: 'KO',    currency: 'USD' },
  'PEPSICO INC':                  { ticker: 'PEP',   currency: 'USD' },
  'BOOKING HOLDINGS INC':         { ticker: 'BKNG',  currency: 'USD' },
  'AIRBNB INC-CLASS A':           { ticker: 'ABNB',  currency: 'USD' },
  'UBER TECHNOLOGIES INC':        { ticker: 'UBER',  currency: 'USD' },
  'PHILIP MORRIS INTERNATIONAL':  { ticker: 'PM',    currency: 'USD' },
  'COLGATE-PALMOLIVE CO':         { ticker: 'CL',    currency: 'USD' },
  'MONDELEZ INTERNATIONAL INC':   { ticker: 'MDLZ',  currency: 'USD' },
  'HILTON WORLDWIDE HOLDINGS INC':{ ticker: 'HLT',   currency: 'USD' },
  'MARRIOTT INTERNATIONAL INC/MD':{ ticker: 'MAR',   currency: 'USD' },
  'FORD MOTOR CO':                { ticker: 'F',     currency: 'USD' },
  'GENERAL MOTORS CO':            { ticker: 'GM',    currency: 'USD' },
  'RIVIAN AUTOMOTIVE INC-CL A':   { ticker: 'RIVN',  currency: 'USD' },
  'COMCAST CORP-CLASS A':         { ticker: 'CMCSA', currency: 'USD' },
  // 미국 에너지/원자재
  'EXXON MOBIL CORP':             { ticker: 'XOM',   currency: 'USD' },
  'CHEVRON CORP':                 { ticker: 'CVX',   currency: 'USD' },
  'CONOCOPHILLIPS':               { ticker: 'COP',   currency: 'USD' },
  'FREEPORT-MCMORAN INC':         { ticker: 'FCX',   currency: 'USD' },
  'NEWMONT CORP':                 { ticker: 'NEM',   currency: 'USD' },
  'BARRICK GOLD CORP':            { ticker: 'GOLD',  currency: 'USD' },
  'LINDE PLC':                    { ticker: 'LIN',   currency: 'USD' },
  // 미국 산업재/방산
  'CATERPILLAR INC':              { ticker: 'CAT',   currency: 'USD' },
  'BOEING CO/THE':                { ticker: 'BA',    currency: 'USD' },
  'LOCKHEED MARTIN CORP':         { ticker: 'LMT',   currency: 'USD' },
  'RTX CORP':                     { ticker: 'RTX',   currency: 'USD' },
  'RAYTHEON TECHNOLOGIES CORP':   { ticker: 'RTX',   currency: 'USD' },
  'GE AEROSPACE':                 { ticker: 'GE',    currency: 'USD' },
  'GENERAL ELECTRIC CO':          { ticker: 'GE',    currency: 'USD' },
  'HONEYWELL INTERNATIONAL INC':  { ticker: 'HON',   currency: 'USD' },
  'GENERAL DYNAMICS CORP':        { ticker: 'GD',    currency: 'USD' },
  'L3HARRIS TECHNOLOGIES INC':    { ticker: 'LHX',   currency: 'USD' },
  'HUNTINGTON INGALLS INDUSTRIES INC': { ticker: 'HII', currency: 'USD' },
  'HOWMET AEROSPACE INC':         { ticker: 'HWM',   currency: 'USD' },
  'MOOG INC':                     { ticker: 'MOG.A', currency: 'USD' },
  'MOOG INC-CLASS A':             { ticker: 'MOG.A', currency: 'USD' },
  'TRANSDIGM GROUP INC':          { ticker: 'TDG',   currency: 'USD' },
  'KRATOS DEFENSE & SECURITY SOLUTIONS INC': { ticker: 'KTOS', currency: 'USD' },
  'ROCKET LAB USA INC':           { ticker: 'RKLB',  currency: 'USD' },
  'PLANET LABS PBC':              { ticker: 'PL',    currency: 'USD' },
  'AST SPACEMOBILE INC':          { ticker: 'ASTS',  currency: 'USD' },
  'AST SPACEMOBILE INC-CLASS A':  { ticker: 'ASTS',  currency: 'USD' },
  'REDWIRE CORP':                 { ticker: 'RDW',   currency: 'USD' },
  'BWX TECHNOLOGIES INC':         { ticker: 'BWXT',  currency: 'USD' },
  'VIASAT INC':                   { ticker: 'VSAT',  currency: 'USD' },
  'AEROJET ROCKETDYNE HOLDINGS':  { ticker: 'AJRD',  currency: 'USD' },
  'UNITED PARCEL SERVICE INC-CL B':{ ticker: 'UPS',  currency: 'USD' },
  'FEDEX CORP':                   { ticker: 'FDX',   currency: 'USD' },
  'UNION PACIFIC CORP':           { ticker: 'UNP',   currency: 'USD' },
  'DEERE & CO':                   { ticker: 'DE',    currency: 'USD' },
  'EATON CORP PLC':               { ticker: 'ETN',   currency: 'USD' },
  'VERTIV HOLDINGS CO':           { ticker: 'VRT',   currency: 'USD' },
  'NORTHROP GRUMMAN CORP':        { ticker: 'NOC',   currency: 'USD' },
  // AI 광통신/네트워크 (Naver/ETFCheck 영문명)
  'Nokia Oyj':                    { ticker: 'NOK',   currency: 'USD' },
  'NOKIA OYJ':                    { ticker: 'NOK',   currency: 'USD' },
  'COHERENT CORP':                { ticker: 'COHR',  currency: 'USD' },
  'Coherent Corp':                { ticker: 'COHR',  currency: 'USD' },
  'Lumentum Holdings Inc':        { ticker: 'LITE',  currency: 'USD' },
  'LUMENTUM HOLDINGS INC':        { ticker: 'LITE',  currency: 'USD' },
  'Ciena Corp':                   { ticker: 'CIEN',  currency: 'USD' },
  'CIENA CORP':                   { ticker: 'CIEN',  currency: 'USD' },
  'MARVELL TECHNOLOGY INC':       { ticker: 'MRVL',  currency: 'USD' },
  'Marvell Technology Inc':       { ticker: 'MRVL',  currency: 'USD' },
  '마벨테크놀로지':                 { ticker: 'MRVL',  currency: 'USD' },
  'Applied Optoelectronics Inc':  { ticker: 'AAOI',  currency: 'USD' },
  'APPLIED OPTOELECTRONICS INC':  { ticker: 'AAOI',  currency: 'USD' },
  'CORNING INC':                  { ticker: 'GLW',   currency: 'USD' },
  'Corning Inc':                  { ticker: 'GLW',   currency: 'USD' },
  '코닝':                          { ticker: 'GLW',   currency: 'USD' },
  'Tower Semiconductor Ltd':      { ticker: 'TSEM',  currency: 'USD' },
  'TOWER SEMICONDUCTOR LTD':      { ticker: 'TSEM',  currency: 'USD' },
  'Celestica Inc':                { ticker: 'CLS',   currency: 'USD' },
  'CELESTICA INC':                { ticker: 'CLS',   currency: 'USD' },
  'Fabrinet':                     { ticker: 'FN',    currency: 'USD' },
  'FABRINET':                     { ticker: 'FN',    currency: 'USD' },
  'ARISTA NETWORKS INC':          { ticker: 'ANET',  currency: 'USD' },
  'Arista Networks Inc':          { ticker: 'ANET',  currency: 'USD' },
  '아리스타네트웍스':               { ticker: 'ANET',  currency: 'USD' },
  'JUNIPER NETWORKS INC':         { ticker: 'JNPR',  currency: 'USD' },
  'ASTERA LABS INC':              { ticker: 'ALAB',  currency: 'USD' },
  'Astera Labs Inc':              { ticker: 'ALAB',  currency: 'USD' },
  'CREDO TECHNOLOGY GROUP HOLDING': { ticker: 'CRDO', currency: 'USD' },
  'Credo Technology Group Holding Ltd': { ticker: 'CRDO', currency: 'USD' },
  // 미국 통신/유틸리티/리츠
  'AT&T INC':                     { ticker: 'T',     currency: 'USD' },
  'VERIZON COMMUNICATIONS INC':   { ticker: 'VZ',    currency: 'USD' },
  'T-MOBILE US INC':              { ticker: 'TMUS',  currency: 'USD' },
  'NEXTERA ENERGY INC':           { ticker: 'NEE',   currency: 'USD' },
  'AMERICAN TOWER CORP':          { ticker: 'AMT',   currency: 'USD' },
  'PROLOGIS INC':                 { ticker: 'PLD',   currency: 'USD' },
  'EQUINIX INC':                  { ticker: 'EQIX',  currency: 'USD' },
  // 기타 미국 대형주
  'S&P GLOBAL INC':               { ticker: 'SPGI',  currency: 'USD' },
  'MSCI INC-CLASS A':             { ticker: 'MSCI',  currency: 'USD' },
  'INTERCONTINENTAL EXCHANGE INC':{ ticker: 'ICE',   currency: 'USD' },
  'CME GROUP INC':                { ticker: 'CME',   currency: 'USD' },
  // 일본 (Bloomberg 영문명)
  'TOYOTA MOTOR CORP':            { ticker: '7203.T', currency: 'JPY' },
  'SONY GROUP CORP':              { ticker: '6758.T', currency: 'JPY' },
  'SOFTBANK GROUP CORP':          { ticker: '9984.T', currency: 'JPY' },
  'KEYENCE CORP':                 { ticker: '6861.T', currency: 'JPY' },
  'MITSUBISHI UFJ FINANCIAL GROUP':{ ticker: '8306.T', currency: 'JPY' },
  'NINTENDO CO LTD':              { ticker: '7974.T', currency: 'JPY' },
  'RECRUIT HOLDINGS CO LTD':      { ticker: '6098.T', currency: 'JPY' },
  'TOKYO ELECTRON LTD':           { ticker: '8035.T', currency: 'JPY' },
  'FAST RETAILING CO LTD':        { ticker: '9983.T', currency: 'JPY' },
  'ADVANTEST CORP':               { ticker: '6857.T', currency: 'JPY' },
  'HITACHI LTD':                  { ticker: '6501.T', currency: 'JPY' },
  'SHIN-ETSU CHEMICAL CO LTD':    { ticker: '4063.T', currency: 'JPY' },
  'DAIKIN INDUSTRIES LTD':        { ticker: '6367.T', currency: 'JPY' },
  'HONDA MOTOR CO LTD':           { ticker: '7267.T', currency: 'JPY' },
  'MURATA MANUFACTURING CO LTD':  { ticker: '6981.T', currency: 'JPY' },
  'SUMITOMO MITSUI FINANCIAL GRP':{ ticker: '8316.T', currency: 'JPY' },
  'CANON INC':                    { ticker: '7751.T', currency: 'JPY' },
  'MITSUBISHI CORP':              { ticker: '8058.T', currency: 'JPY' },
  'ITOCHU CORP':                  { ticker: '8001.T', currency: 'JPY' },
  'TAKEDA PHARMACEUTICAL CO LTD': { ticker: '4502.T', currency: 'JPY' },
  // 유럽
  'LVMH MOET HENNESSY LOUIS VUITTON': { ticker: 'LVMUY', currency: 'USD' },
  'NOVARTIS AG-REG':              { ticker: 'NVS',   currency: 'USD' },
  'ROCHE HOLDING AG-GENUSS':      { ticker: 'RHHBY', currency: 'USD' },
  'SAP SE':                       { ticker: 'SAP',   currency: 'USD' },
  'SHELL PLC':                    { ticker: 'SHEL',  currency: 'USD' },
  'BP PLC':                       { ticker: 'BP',    currency: 'USD' },
  'UNILEVER PLC':                 { ticker: 'UL',    currency: 'USD' },
  'HSBC HOLDINGS PLC':            { ticker: 'HSBC',  currency: 'USD' },
  'TOTALENERGIES SE':             { ticker: 'TTE',   currency: 'USD' },
  'SIEMENS AG-REG':               { ticker: 'SIEGY', currency: 'USD' },
  'ALLIANZ SE-REG':               { ticker: 'ALIZY', currency: 'USD' },
  'BNP PARIBAS':                  { ticker: 'BNPQY', currency: 'USD' },
  'NESTLE SA-REG':                { ticker: 'NSRGY', currency: 'USD' },
  // 중국/홍콩
  'TENCENT HOLDINGS LTD':         { ticker: '0700.HK', currency: 'HKD' },
  'ALIBABA GROUP HOLDING-SP ADR': { ticker: 'BABA',  currency: 'USD' },
  'ALIBABA GROUP HOLDING LTD':    { ticker: 'BABA',  currency: 'USD' },
  'JD.COM INC-CLASS A ADR':       { ticker: 'JD',    currency: 'USD' },
  'PDD HOLDINGS INC-ADR':         { ticker: 'PDD',   currency: 'USD' },
  'NETEASE INC-ADR':              { ticker: 'NTES',  currency: 'USD' },
  'BAIDU INC-SPON ADR':           { ticker: 'BIDU',  currency: 'USD' },
  'MEITUAN-W':                    { ticker: '3690.HK', currency: 'HKD' },
  'BYD CO LTD-H SHS':            { ticker: '1211.HK', currency: 'HKD' },
  // 기타 글로벌
  'SAMSUNG ELECTRONICS CO LTD':   { ticker: '005930.KS', currency: 'USD' },
  'TAIWAN SEMICONDUCTOR MFG':     { ticker: 'TSM',   currency: 'USD' },
  'TAIWAN SEMICONDUCTOR MFG CO':  { ticker: 'TSM',   currency: 'USD' },
  'TAIWAN SEMICONDUCTOR-SP ADR':  { ticker: 'TSM',   currency: 'USD' },
  // ─ 유럽 방산 (ETFCheck 구성종목명 기준 — 대문자/타이틀케이스 모두 등록) ──────────
  // HANARO 유럽방산 스타일 (전체 대문자)
  'AIRBUS SE':                    { ticker: 'AIR.PA',    currency: 'EUR' },
  'ROLLS-ROYCE HOLDINGS PLC':     { ticker: 'RR.L',      currency: 'GBP' },
  'SAFRAN SA':                    { ticker: 'SAF.PA',    currency: 'EUR' },
  'BAE SYSTEMS PLC':              { ticker: 'BA.L',      currency: 'GBP' },
  'THALES SA':                    { ticker: 'HO.PA',     currency: 'EUR' },
  'LEONARDO SPA':                 { ticker: 'LDO.MI',    currency: 'EUR' },
  'RHEINMETALL AG':               { ticker: 'RHM.DE',    currency: 'EUR' },
  'KONGSBERG GRUPPEN ASA':        { ticker: 'KOG.OL',    currency: 'EUR' },
  'SAAB AB':                      { ticker: 'SAAB-B.ST', currency: 'EUR' },
  'DASSAULT AVIATION SA':         { ticker: 'AM.PA',     currency: 'EUR' },
  'INDRA SISTEMAS SA':            { ticker: 'IDR.MC',    currency: 'EUR' },
  // ACE 유럽방산TOP10 스타일 (타이틀케이스)
  'Rolls-Royce Holdings PLC':     { ticker: 'RR.L',      currency: 'GBP' },
  'Kongsberg Gruppen ASA':        { ticker: 'KOG.OL',    currency: 'EUR' },
  'Rheinmetall AG':               { ticker: 'RHM.DE',    currency: 'EUR' },
  'BAE Systems PLC':              { ticker: 'BA.L',      currency: 'GBP' },
  'Thales SA':                    { ticker: 'HO.PA',     currency: 'EUR' },
  'Saab AB':                      { ticker: 'SAAB-B.ST', currency: 'EUR' },
  'Leonardo SpA':                 { ticker: 'LDO.MI',    currency: 'EUR' },
  'Dassault Aviation SA':         { ticker: 'AM.PA',     currency: 'EUR' },
  'Indra Sistemas SA':            { ticker: 'IDR.MC',    currency: 'EUR' },
  'Safran SA':                    { ticker: 'SAF.PA',    currency: 'EUR' },
  'Airbus SE':                    { ticker: 'AIR.PA',    currency: 'EUR' },
  // 추가 유럽 방산 (ACE/HANARO ETF 구성 가능 종목)
  'CSG NV':                       { ticker: 'CSG.AS',    currency: 'EUR' },
  'CSG N.V.':                     { ticker: 'CSG.AS',    currency: 'EUR' },
  'CSG':                          { ticker: 'CSG.AS',    currency: 'EUR' },
  'Hensoldt AG':                  { ticker: 'HAG.DE',    currency: 'EUR' },
  'HENSOLDT AG':                  { ticker: 'HAG.DE',    currency: 'EUR' },
  'MTU Aero Engines AG':          { ticker: 'MTX.DE',    currency: 'EUR' },
  'MTU AERO ENGINES AG':          { ticker: 'MTX.DE',    currency: 'EUR' },
  'QinetiQ Group PLC':            { ticker: 'QQ.L',      currency: 'GBP' },
  'QINETIQ GROUP PLC':            { ticker: 'QQ.L',      currency: 'GBP' },
  'Babcock International Group PLC': { ticker: 'BAB.L',  currency: 'GBP' },
  'BABCOCK INTERNATIONAL GROUP PLC': { ticker: 'BAB.L',  currency: 'GBP' },
  'Leonardo S.p.A.':              { ticker: 'LDO.MI',    currency: 'EUR' },
  'Leonardo S.P.A.':              { ticker: 'LDO.MI',    currency: 'EUR' },
  'LEONARDO S.P.A.':              { ticker: 'LDO.MI',    currency: 'EUR' },
  'Saab AB (publ)':               { ticker: 'SAAB-B.ST', currency: 'EUR' },
  'SAAB AB (PUBL)':               { ticker: 'SAAB-B.ST', currency: 'EUR' },
  'Kongsberg Gruppen':            { ticker: 'KOG.OL',    currency: 'EUR' },
  'KONGSBERG GRUPPEN':            { ticker: 'KOG.OL',    currency: 'EUR' },
  'Dassault Aviation':            { ticker: 'AM.PA',     currency: 'EUR' },
  'DASSAULT AVIATION':            { ticker: 'AM.PA',     currency: 'EUR' },
};

// 소문자 정규화 맵: 대소문자/점/공백 차이 흡수용 (GLOBAL_TICKER_MAP 빌드 후 파생)
const _GLOBAL_TICKER_MAP_LOWER: Record<string, { ticker: string; currency: FxCurrency }> = (() => {
  const m: Record<string, { ticker: string; currency: FxCurrency }> = {};
  for (const [k, v] of Object.entries(GLOBAL_TICKER_MAP)) {
    // 소문자 + 점/괄호/공백 정규화
    const norm = k.toLowerCase().replace(/[.\s\(\)]/g, '');
    if (!m[norm]) m[norm] = v;
  }
  return m;
})();

/** 종목명 → GLOBAL_TICKER_MAP 조회 (대소문자 및 구두점 차이 무시) */
function lookupGlobalTicker(name: string) {
  return GLOBAL_TICKER_MAP[name]
    || _GLOBAL_TICKER_MAP_LOWER[name.toLowerCase().replace(/[.\s\(\)]/g, '')];
}

/** ETFCheck 토큰 생성 (Koscom 보안 파라미터) */
function getEtfCheckToken() {
  const KEY = '4lm@flEh68';
  const a = String(Math.floor(Date.now() / 60000));
  let r = '';
  for (let i = 0; i < a.length; i++) r += KEY[parseInt(a[i])];
  return crypto.createHash('sha256').update(r).digest('hex');
}

/** ETFCheck API를 통한 전체 구성종목 및 비중 추출 (해외/국내 모두 지원) */
async function fetchEtfCheckHoldings(itemcode: string): Promise<HoldingInfo[]> {
  try {
    const token = getEtfCheckToken();
    const url = `https://www.etfcheck.co.kr/user/etp/getEtfPdfRankListBefWeight?code=${itemcode}`;
    
    const body = await new Promise<string>((resolve, reject) => {
      https.get(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0',
          'Referer': 'https://www.etfcheck.co.kr/',
          'Checkclient': token,
          'Accept': 'application/json',
        }
      }, res => {
        let data = '';
        res.on('data', c => data += c);
        res.on('end', () => resolve(data));
      }).on('error', reject);
    });

    const parsed = JSON.parse(body);
    if (!parsed.results || !parsed.results.length) return [];

    return parsed.results.map((r: any) => ({
      code: /^\d{6}$/.test(r.F16013 || '') ? r.F16013 : '', // 국내 종목 코드 (있을 경우)
      name: r.NAME || r.F16004 || '',
      weight: r.WEIGHT ? parseFloat(r.WEIGHT) : 0,
      shares: r.F33861 ? Math.round(parseFloat(r.F33861)) : undefined,
      marketCapBillion: null,
    }));
  } catch (err) {
    console.error(`[ETFCheck] Failed for ${itemcode}:`, err);
    return [];
  }
}

/** UTF-8 페이지 fetch */
async function fetchPageUtf8(url: string, referer = 'https://finance.naver.com/'): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': referer },
    }, res => {
      const chunks: Buffer[] = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    });
    req.on('error', reject);
    req.setTimeout(15000, () => req.destroy(new Error('timeout')));
  });
}

/** EUC-KR 페이지 fetch (Naver 시총 순위 페이지) */
async function fetchPageEucKr(url: string, referer = 'https://finance.naver.com/'): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': referer },
    }, res => {
      const chunks: Buffer[] = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve(iconv.decode(Buffer.concat(chunks), 'EUC-KR')));
    });
    req.on('error', reject);
    req.setTimeout(15000, () => req.destroy(new Error('timeout')));
  });
}

// ── 전체 종목 코드맵 (KOSPI + KOSDAQ 이름 → 코드) ─────────────────────────────
// Naver 시총 순위 페이지를 전체 스캔해서 name→code 맵 구축, 24h 캐시
let _stockCodeMap: Record<string, string> = {};   // 종목명 → 코드
let _stockCodeMapTs = 0;
const STOCK_MAP_TTL = 24 * 3600 * 1000;

async function getStockCodeMap(): Promise<Record<string, string>> {
  if (_stockCodeMapTs && Date.now() - _stockCodeMapTs < STOCK_MAP_TTL) return _stockCodeMap;

  console.log('[funds] 종목 코드맵 빌드 중...');
  const map: Record<string, string> = {};

  // KOSPI(sosok=0) / KOSDAQ(sosok=1) 각각 페이지 수 확인 후 전체 fetch
  async function fetchOnePage(sosok: number, page: number): Promise<void> {
    try {
      const html = await fetchPageEucKr(
        `https://finance.naver.com/sise/sise_market_sum.naver?sosok=${sosok}&page=${page}`,
        'https://finance.naver.com/sise/'
      );
      const re = /code=(\d{6})[^>]*>([^<]+)</g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(html)) !== null) {
        map[m[2].trim()] = m[1];
      }
    } catch { /* 페이지 에러 무시 */ }
  }

  // 첫 페이지 fetch 후 마지막 페이지 수 확인
  async function fetchAllPages(sosok: number): Promise<void> {
    const firstHtml = await fetchPageEucKr(
      `https://finance.naver.com/sise/sise_market_sum.naver?sosok=${sosok}&page=1`,
      'https://finance.naver.com/sise/'
    ).catch(() => '');
    if (!firstHtml) return;
    const re = /code=(\d{6})[^>]*>([^<]+)</g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(firstHtml)) !== null) map[m[2].trim()] = m[1];

    const pgMatch = firstHtml.match(/page=(\d+)[^"]*"[^>]*>[^<]*맨뒤/);
    const lastPage = pgMatch ? parseInt(pgMatch[1]) : 50;

    // 나머지 페이지 concurrency=10 병렬 fetch
    const pages = Array.from({ length: lastPage - 1 }, (_, i) => i + 2);
    await pLimit(pages.map(p => () => fetchOnePage(sosok, p)), 10);
  }

  await Promise.all([fetchAllPages(0), fetchAllPages(1)]);

  _stockCodeMap = map;
  _stockCodeMapTs = Date.now();
  console.log('[funds] 종목 코드맵 완료 -', Object.keys(map).length, '개');
  return map;
}

// ── PLUS ETF (한화자산운용) 공식 어댑터 ──────────────────────────────────────
// plusetf.co.kr 운용사 공식 PDF — 전체 구성종목 + 당일 데이터 + KR코드/ISIN 제공
const PLUS_MAP_TTL = 24 * 3600 * 1000;
let _plusNameToId: Record<string, string> | null = null;
let _plusMapTs = 0;

function _plusNorm(name: string): string {
  return name.replace(/&amp;/g, '&').replace(/\s+/g, '').toLowerCase();
}

/** /product/overview HTML에서 상품명 → 내부ID 매핑 추출 (24h 캐시) */
async function getPlusEtfMap(): Promise<Record<string, string>> {
  if (_plusNameToId && Date.now() - _plusMapTs < PLUS_MAP_TTL) return _plusNameToId;
  try {
    const html = await fetchPageUtf8('https://www.plusetf.co.kr/product/overview', 'https://www.plusetf.co.kr/');
    const re = /href="\/product\/detail\?n=(\d+)"[^>]*>([\s\S]{0,300}?)<\/a>/g;
    const map: Record<string, string> = {};
    let m: RegExpExecArray | null;
    while ((m = re.exec(html))) {
      const t = m[2].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
      if (t && /^PLUS/i.test(t)) map[_plusNorm(t)] = m[1];
    }
    if (Object.keys(map).length > 0) {
      _plusNameToId = map;
      _plusMapTs = Date.now();
      console.log(`[plus-etf] 상품 매핑 ${Object.keys(map).length}개 로드`);
    }
    return _plusNameToId || {};
  } catch (e) {
    console.warn('[plus-etf] overview 파싱 실패:', (e as Error).message);
    return _plusNameToId || {};
  }
}

/** PLUS ETF 보유종목 (운용사 공식, ETF명으로 조회) */
async function fetchPlusEtfHoldings(etfName: string): Promise<HoldingInfo[]> {
  const map = await getPlusEtfMap();
  const id = map[_plusNorm(etfName)];
  if (!id) return [];

  // 최근 7일 내 영업일 데이터 시도 (주말·공휴일 대비)
  for (let back = 0; back < 7; back++) {
    const d = new Date(Date.now() - back * 86400000);
    const ds = d.toISOString().slice(0, 10).replace(/-/g, '');
    try {
      const txt = await fetchPageUtf8(
        `https://www.plusetf.co.kr/api/v1/product/pdf/list?n=${id}&page=0&pageSize=500&d=${ds}`,
        `https://www.plusetf.co.kr/product/detail?n=${id}`
      );
      if (!txt || (txt[0] !== '{' && txt[0] !== '[')) continue;
      const rows = (JSON.parse(txt).content || []) as any[];
      if (!rows.length) continue;

      const out: HoldingInfo[] = [];
      for (const r of rows) {
        const name = String(r.jmNm || '').trim();
        const ratio = parseFloat(r.ratio) || 0;
        if (!name || ratio <= 0) continue;
        // 현금·선물·스왑 등 비주식 자산 제외
        if (name.includes('현금') || name.includes('예치금')
            || /\b(FUT|SWAP)\b|선물|스왑/i.test(name)) continue;

        // jmCd: KR 6자리 직접 or ISIN(KR7xxxxxx00x → 6자리 추출, 해외 ISIN → 빈 코드)
        let code = String(r.jmCd || '').trim();
        if (!/^\d{6}$/.test(code)) {
          const krIsin = code.match(/^KR7(\d{6})\d{3}$/);
          code = krIsin ? krIsin[1] : '';
        }
        const sharesNum = parseFloat(r.amount);
        out.push({
          code,
          name,
          weight: ratio,
          shares: isFinite(sharesNum) && sharesNum > 0 ? Math.round(sharesNum) : undefined,
          marketCapBillion: null,
        });
      }
      if (out.length) return out;
    } catch {}
  }
  return [];
}

/** WiseReport에서 ETF 전체 구성종목 추출 (이름+비중+주식수, 코드 없음 - 50~200개 전체 제공) */
async function fetchWiseReportHoldings(itemcode: string): Promise<HoldingInfo[]> {
  try {
    const url = `https://navercomp.wisereport.co.kr/v2/ETF/index.aspx?cmp_cd=${itemcode}&target=cu_more`;
    const referer = `https://finance.naver.com/item/coinfo.naver?code=${itemcode}&target=cu_more`;
    const html = await fetchPageUtf8(url, referer);

    const gridIdx = html.indexOf('"grid_data":[');
    if (gridIdx < 0) return [];

    const arrayBody = html.slice(gridIdx + '"grid_data":['.length);
    const itemMatches = arrayBody.match(/\{[^}]+\}/g) || [];
    const out: HoldingInfo[] = [];

    for (const item of itemMatches) {
      const nmM  = item.match(/"STK_NM_KOR"\s*:\s*"([^"]+)"/);
      const wtM  = item.match(/"ETF_WEIGHT"\s*:\s*([\d.]+)/);
      const shM  = item.match(/"AGMT_STK_CNT"\s*:\s*([\d.]+)/);
      if (!nmM) continue;
      const name = nmM[1].trim();
      if (name.includes('현금') || name.toLowerCase().includes('cash')) continue;
      out.push({
        code: '',
        name,
        weight: wtM ? parseFloat(wtM[1]) : 0,
        shares: shM ? Math.round(parseFloat(shM[1])) : undefined,
        marketCapBillion: null,
      });
    }
    return out;
  } catch {
    return [];
  }
}

/** Naver mobile ETF 분석 API에서 top10 보유종목 추출 (코드+이름+주식수+비중) */
async function fetchNaverEtfAnalysis(itemcode: string): Promise<HoldingInfo[]> {
  try {
    const txt = await fetchPageUtf8(
      `https://m.stock.naver.com/api/stock/${itemcode}/etfAnalysis`,
      `https://m.stock.naver.com/domestic/stock/${itemcode}/total`
    );
    if (!txt || txt[0] !== '{') return [];
    const json = JSON.parse(txt);
    const list = json.etfTop10MajorConstituentAssets || [];

    const out: HoldingInfo[] = [];
    for (const h of list) {
      const code = String(h.itemCode || '').trim();
      const name = String(h.itemName || '').trim();
      if (!name) continue;
      // 현금/예치금/선물(체결가 없는) 등은 보유종목에서 제외
      if (name.includes('현금') || name.includes('예치금') || name.includes('설정현금')
          || /\b(cash|deposit)\b/i.test(name)) continue;
      const weight = parseFloat(String(h.etfWeight || '0').replace(/[,%\s]/g, '')) || 0;
      if (weight <= 0) continue;
      const sharesNum = parseFloat(String(h.stockCount || '0').replace(/[,\s]/g, ''));
      out.push({
        code,
        name,
        weight,
        shares: isFinite(sharesNum) && sharesNum > 0 ? Math.round(sharesNum) : undefined,
        marketCapBillion: null,
      });
    }
    return out;
  } catch {
    return [];
  }
}

/** ETF 전체 구성종목 추출 (하이브리드)
 *  - opts.expand=false (기본): Naver top10만, 실패 시 WR 폴백 (빠름)
 *  - opts.expand=true: Naver top10 + WR 전체 머지 (느리지만 11위 이하까지 모두)
 */
async function fetchETFHoldingsFull(
  itemcode: string,
  opts?: { expand?: boolean }
): Promise<{ h: HoldingInfo[]; source: string }> {
  const expand = opts?.expand === true;
  const cacheKey = expand ? `${itemcode}__expand` : itemcode;

  const cached = _holdingsFullCache[cacheKey];
  if (cached && Date.now() - cached.ts < HOLDINGS_TTL) return { h: cached.h, source: cached.source || 'naver' };

  // 1차: TIME ETF 공식 xlsx (비중 포함, 해외종목도 커버 - Bloomberg 티커)
  if (TIME_ETF_MAP[itemcode]) {
    const tData = await fetchTimeEtfHoldings(itemcode);
    if (tData && tData.length) {
      const holdings: HoldingInfo[] = tData.map(h => ({
        code: h.code,
        name: h.name,
        weight: h.weight,
        shares: h.shares,
        marketCapBillion: null,
      }));
      _holdingsFullCache[cacheKey] = { h: holdings, ts: Date.now(), source: 'time-etf' };
      return { h: holdings, source: 'time-etf' };
    }
  }

  // 1.5차: PLUS ETF (한화자산운용) 공식 PDF — 당일 데이터 + 전체 종목 + 코드/ISIN
  try {
    const list = await fetchNaverETFList();
    const etfName = list.find(i => i.itemcode === itemcode)?.itemname || '';
    if (/^PLUS/i.test(etfName)) {
      const pData = await fetchPlusEtfHoldings(etfName);
      if (pData.length > 0) {
        _holdingsFullCache[cacheKey] = { h: pData, ts: Date.now(), source: 'plus-etf' };
        return { h: pData, source: 'plus-etf' };
      }
    }
  } catch {}

  // 2차: Naver mobile ETF analysis API (top10, 빠름, 코드 포함)
  const naverHoldings = await fetchNaverEtfAnalysis(itemcode);

  // 빠른 경로: expand=false이고 Naver가 충분히 데이터 줬으면 그대로 반환
  if (!expand && naverHoldings.length >= 5) {
    _holdingsFullCache[cacheKey] = { h: naverHoldings, ts: Date.now(), source: 'naver-etf' };
    return { h: naverHoldings, source: 'naver-etf' };
  }

  // 3차: WiseReport (전체 50~200개, 느림)
  const wrHoldings = await fetchWiseReportHoldings(itemcode);
  const wrHasWeights = wrHoldings.length > 0 && wrHoldings.slice(0, 5).some(h => h.weight > 0);

  if (wrHasWeights) {
    // Naver top10이 있으면 코드 매핑 활용 (WR은 코드 없음)
    const nameToCode: Record<string, string> = {};
    for (const n of naverHoldings) if (n.code && n.name) nameToCode[n.name] = n.code;

    const merged: HoldingInfo[] = wrHoldings.map(h => ({
      ...h,
      code: h.code || nameToCode[h.name] || '',
    }));

    // Naver top10에는 있는데 WR에 없는 종목 보강 (드물지만 가능)
    for (const n of naverHoldings) {
      if (!merged.find(m => m.name === n.name)) merged.push(n);
    }

    const source = expand ? 'naver+wr' : 'wisereport';
    _holdingsFullCache[cacheKey] = { h: merged, ts: Date.now(), source };
    return { h: merged, source };
  }

  // 4차: ETFCheck (해외주식형 — Naver/WR 모두 비중을 못 주는 경우 비중 보완)
  const ecHoldings = await fetchEtfCheckHoldings(itemcode);
  if (ecHoldings.length > 0 && ecHoldings.slice(0, 5).some(h => h.weight > 0)) {
    // 현금성 자산 제외
    const cleaned = ecHoldings.filter(h =>
      h.name && !h.name.includes('현금') && !h.name.includes('예치금')
      && !h.name.includes('설정현금') && !/\b(cash|deposit)\b/i.test(h.name));
    _holdingsFullCache[cacheKey] = { h: cleaned, ts: Date.now(), source: 'etfcheck' };
    return { h: cleaned, source: 'etfcheck' };
  }

  // 모든 소스 실패 → 비중 없는 WR이라도 (수량은 있음), 그것도 없으면 Naver 결과
  const fallback = wrHoldings.length > 0 ? wrHoldings : naverHoldings;
  const fallbackSource = wrHoldings.length > 0 ? 'wisereport' : 'naver-etf';
  _holdingsFullCache[cacheKey] = { h: fallback, ts: Date.now(), source: fallbackSource };
  return { h: fallback, source: fallbackSource };
}

/** 네이버 ETF 메인페이지에서 구성종목 상위 10개 추출 (종목코드 포함, avgcap용) */
async function fetchETFHoldingsTop10(itemcode: string): Promise<HoldingInfo[]> {
  const cached = _holdingsTop10Cache[itemcode];
  if (cached && Date.now() - cached.ts < HOLDINGS_TTL) return cached.h;

  const html = await fetchPageUtf8(`https://finance.naver.com/item/main.naver?code=${itemcode}`);

  const rowPattern = /href="\/item\/main\.naver\?code=(\d{6})"[^>]*>\s*([^<]+?)\s*<\/a>[\s\S]{0,400}?(\d{1,2}\.\d{2})\s*%/g;
  const holdings: HoldingInfo[] = [];
  const seen = new Set<string>();
  let m: RegExpExecArray | null;

  while ((m = rowPattern.exec(html)) !== null && holdings.length < 10) {
    const code = m[1];
    if (seen.has(code) || code === itemcode) continue;
    seen.add(code);
    holdings.push({ code, name: m[2].trim(), weight: parseFloat(m[3]), marketCapBillion: null });
  }

  _holdingsTop10Cache[itemcode] = { h: holdings, ts: Date.now() };
  return holdings;
}

/** 네이버 개별 종목 페이지에서 시가총액(억원) 추출 */
async function fetchStockMarketCap(code: string): Promise<number | null> {
  const cached = _capCache[code];
  if (cached && Date.now() - cached.ts < STOCK_CAP_TTL) return cached.cap;

  try {
    const html = await fetchPageUtf8(`https://finance.naver.com/item/main.naver?code=${code}`);

    // <em id="_market_sum"> 1,267조 1,809  또는  <em id="_market_sum"> 123,456
    const m = html.match(/<em id="_market_sum">\s*([^<]+)/);
    if (m) {
      const raw = m[1].trim();
      const joMatch = raw.match(/([\d,]+)조\s*([\d,]*)/);
      if (joMatch) {
        const jo = parseInt(joMatch[1].replace(/,/g, ''));
        const uk = parseInt((joMatch[2] || '0').replace(/,/g, '') || '0');
        const cap = jo * 10000 + uk;
        _capCache[code] = { cap, ts: Date.now() };
        return cap;
      }
      // 조 없이 억원만
      const plain = parseInt(raw.replace(/[^0-9]/g, ''));
      if (!isNaN(plain) && plain > 0) {
        _capCache[code] = { cap: plain, ts: Date.now() };
        return plain;
      }
    }
  } catch { /* ignore per-stock errors */ }

  _capCache[code] = { cap: null, ts: Date.now() };
  return null;
}

/** 시총(억원) → "X조 XXXX억" 형식 */
function formatMarketCap(bil: number): string {
  if (bil >= 10000) {
    const jo = Math.floor(bil / 10000);
    const uk = Math.round(bil % 10000);
    return jo.toLocaleString() + '조' + (uk ? ' ' + uk.toLocaleString() + '억' : '');
  }
  return Math.round(bil).toLocaleString() + '억';
}

/** 가중평균 시총 기준 규모 레이블 */
function sizeLabel(avgBil: number): { label: string; color: string } {
  if (avgBil >= 5000000) return { label: '초대형주', color: 'text-purple-400' };
  if (avgBil >= 500000)  return { label: '대형주',   color: 'text-blue-400'   };
  if (avgBil >= 50000)   return { label: '중형주',   color: 'text-green-400'  };
  return                        { label: '소형주',   color: 'text-yellow-400' };
}

// ── Morningstar 파싱 ─────────────────────────────────────────────────────────
function parseMorningstar(raw: string): FundSearchResult[] {
  const results: FundSearchResult[] = [];
  const lines = raw.split('\n').filter(l => l.trim());

  for (const line of lines) {
    const parts = line.split('|');
    if (parts.length < 6) continue;
    const typePart = parts[2]?.trim();
    if (typePart !== 'FUND' && typePart !== 'ETF') continue;

    try {
      const data = JSON.parse(parts[1]);
      const secId = data.i || '';
      results.push({
        id: secId,
        perfId: data.pi || '',
        name: data.n || parts[0] || '',
        type: typePart as 'FUND' | 'ETF',
        ticker: data.s || parts[3] || '',
        exchange: data.e || parts[4] || '',
        starRating: data.sr || '',
        category: parts[5] || '',
        source: 'morningstar',
        region: 'EU',
        detailUrl: typePart === 'ETF'
          ? `https://www.morningstar.co.uk/uk/etf/snapshot/snapshot.aspx?id=${secId}`
          : `https://www.morningstar.co.uk/uk/funds/snapshot/snapshot.aspx?id=${secId}`,
      });
    } catch {
      // skip
    }
  }
  return results;
}

function yahooRegion(symbol: string, exchange: string): string {
  if (symbol.endsWith('.KS') || symbol.endsWith('.KQ')) return 'KR';
  if (symbol.endsWith('.T')) return 'JP';
  if (symbol.endsWith('.HK')) return 'HK';
  if (symbol.endsWith('.SS') || symbol.endsWith('.SZ')) return 'CN';
  if (symbol.endsWith('.L')) return 'UK';
  if (/\.(DE|PA|AS|MI|MC|SW|BR|VI|ST|OL|CO|HE|LS|WA)$/i.test(symbol)) return 'EU';
  if (['NMS', 'NYQ', 'NGM', 'ASE', 'PCX', 'BATS'].includes(exchange)) return 'US';
  return 'US';
}

async function searchYahoo(q: string, limit: number): Promise<FundSearchResult[]> {
  const url = `${YF_SEARCH_URL}?q=${encodeURIComponent(q)}&quotesCount=${limit}&newsCount=0`;
  const resp = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
  });
  if (!resp.ok) throw new Error(`Yahoo search failed: ${resp.status}`);
  const data: any = await resp.json();

  return (data.quotes || [])
    .filter((q: any) => q.quoteType === 'ETF' || q.quoteType === 'MUTUALFUND')
    .map((q: any): FundSearchResult => {
      const symbol: string = q.symbol || '';
      const region = yahooRegion(symbol, q.exchange || '');
      return {
        id: symbol,
        perfId: '',
        name: q.longname || q.shortname || symbol,
        type: q.quoteType === 'ETF' ? 'ETF' : 'FUND',
        ticker: symbol,
        exchange: q.exchDisp || q.exchange || '',
        starRating: '',
        category: q.typeDisp || '',
        source: 'yahoo',
        region,
        detailUrl: `https://finance.yahoo.com/quote/${encodeURIComponent(symbol)}`,
      };
    });
}

async function searchMorningstar(q: string, limit: number): Promise<{ results: FundSearchResult[]; raw: string }> {
  const url = `${MS_SEARCH_URL}?q=${encodeURIComponent(q)}&limit=${limit}&preferedList=&source=nav`;
  const resp = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
  if (!resp.ok) throw new Error(`Morningstar search failed: ${resp.status}`);
  const raw = await resp.text();
  return { results: parseMorningstar(raw), raw };
}

// ── 한국어 쿼리 감지 ──────────────────────────────────────────────────────────
function isKoreanQuery(q: string): boolean {
  return /[\uAC00-\uD7A3]/.test(q);
}

// ── GET /api/funds/search?q=...&type=all|fund|etf&limit=25 ────────────────────
router.get('/search', async (req: Request, res: Response) => {
  try {
    const q = (req.query.q as string || '').trim();
    if (!q) return res.json({ results: [], total: 0 });

    const limit = Math.min(parseInt(req.query.limit as string) || 25, 50);
    const typeFilter = (req.query.type as string || 'all').toLowerCase();
    const korean = isKoreanQuery(q);

    // 세 소스 병렬 조회 (한글 쿼리면 Naver 결과를 우선 정렬)
    const [msSettled, yfSettled, naverSettled] = await Promise.allSettled([
      searchMorningstar(q, limit),
      searchYahoo(q, limit),
      searchNaver(q, limit),
    ]);

    const msData = msSettled.status === 'fulfilled' ? msSettled.value : { results: [], raw: '' };
    const yfResults = yfSettled.status === 'fulfilled' ? yfSettled.value : [];
    const naverResults = naverSettled.status === 'fulfilled' ? naverSettled.value : [];

    // 중복 제거 (ticker 기준)
    // 한국 ETF: Naver 우선 (한글명, 더 많은 정보)
    // 나머지: Morningstar 우선
    const seen = new Set<string>();
    const merged: FundSearchResult[] = [];

    // 1) 한국어 쿼리 → Naver 결과 먼저
    if (korean) {
      for (const r of naverResults) {
        const key = r.ticker.toUpperCase();
        if (!seen.has(key)) { seen.add(key); merged.push(r); }
      }
    } else {
      // 2) Morningstar 우선
      for (const r of msData.results) {
        const key = `${r.ticker}|${r.exchange}`.toUpperCase();
        if (r.ticker && seen.has(key)) continue;
        if (r.ticker) seen.add(key);
        merged.push(r);
      }
      // 3) Yahoo 추가 (Morningstar에 없는 것)
      for (const r of yfResults) {
        const key = r.ticker.toUpperCase();
        // KR 티커는 Naver로 대체할 것이므로 일단 포함
        if (!seen.has(key)) { seen.add(key); merged.push(r); }
      }
      // 4) Naver에만 있는 KR ETF 추가 (Yahoo/MS에서 못 찾은 것)
      for (const r of naverResults) {
        const key = r.ticker.toUpperCase();
        if (!seen.has(key)) { seen.add(key); merged.push(r); }
      }
    }

    // 타입 필터 (국내 ETF는 항상 ETF)
    let results = merged;
    if (typeFilter === 'fund') results = results.filter(r => r.type === 'FUND');
    else if (typeFilter === 'etf') results = results.filter(r => r.type === 'ETF');

    const fundMore = msData.raw.match(/(\d+) More Funds/);
    const etfMore = msData.raw.match(/(\d+) More ETFs/);
    const totalFunds = (fundMore ? parseInt(fundMore[1]) : 0) + merged.filter(r => r.type === 'FUND').length;
    const totalETFs = (etfMore ? parseInt(etfMore[1]) : 0) + merged.filter(r => r.type === 'ETF').length;

    res.json({
      results: results.slice(0, limit),
      total: results.length,
      totalFunds,
      totalETFs,
      query: q,
      isKorean: korean,
      sources: {
        morningstar: msSettled.status === 'fulfilled' ? msData.results.length : `error: ${(msSettled as any).reason?.message}`,
        yahoo: yfSettled.status === 'fulfilled' ? yfResults.length : `error: ${(yfSettled as any).reason?.message}`,
        naver: naverSettled.status === 'fulfilled' ? naverResults.length : `error: ${(naverSettled as any).reason?.message}`,
      },
    });
  } catch (err: any) {
    console.error('Fund search error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/funds/naver/list?categoryKey=us&limit=50&sort=marketSum ─────────
// 국내 ETF 전체 목록 (이름 기반 카테고리 필터)
// ── GET /api/funds/search/by-component ──────────────────────────────────────
// 종목명으로 해당 종목을 담고 있는 ETF 목록 찾기
router.get('/search/by-component', async (req: Request, res: Response) => {
  try {
    const q = (req.query.q as string || '').trim();
    if (!q) return res.json({ results: [] });

    // 1. 종목명으로 종목코드 찾기 (네이버 자동완성 API)
    const searchUrl = `https://ac.stock.naver.com/ac?q=${encodeURIComponent(q)}&target=stock`;
    const searchBuf = await new Promise<Buffer>((resolve, reject) => {
      https.get(searchUrl, res => {
        const chunks: Buffer[] = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => resolve(Buffer.concat(chunks)));
      }).on('error', reject);
    });
    const searchData = JSON.parse(searchBuf.toString('utf8'));
    const stockItem = searchData.items?.find((i: any) => i.category === 'stock' || i.category === 'stock_us');
    
    if (!stockItem || !stockItem.code) return res.json({ results: [] });
    
    const stockCode = stockItem.code;
    const stockName = stockItem.name;

    // 2. 해당 종목을 포함한 ETF 목록 가져오기 (네이버 모바일 API)
    // 모바일 API는 User-Agent와 Referer가 중요함
    const includedUrl = `https://m.stock.naver.com/api/stock/${stockCode}/includedEtf?pageSize=30&page=1`;
    const includedBuf = await new Promise<Buffer>((resolve, reject) => {
      https.get(includedUrl, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 13_2_3 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/13.0.3 Mobile/15E148 Safari/604.1',
          'Referer': 'https://m.stock.naver.com/'
        }
      }, res => {
        const chunks: Buffer[] = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => resolve(Buffer.concat(chunks)));
      }).on('error', reject);
    });
    
    const includedStr = includedBuf.toString('utf8');
    if (includedStr.startsWith('<!doctype')) {
      throw new Error('네이버 데이터 서버 응답 오류 (Mobile API 차단)');
    }
    const includedData = JSON.parse(includedStr);
    
    // 3. 전체 ETF 목록과 매칭하여 상세 데이터 보완
    const allEtfs = await fetchNaverETFList();
    const etfMap = new Map(allEtfs.map(i => [i.itemcode, i]));

    const results = (includedData || []).map((item: any) => {
      const etf = etfMap.get(item.itemCode);
      const cat = classifyETFByName(item.stockName);
      return {
        itemcode: item.itemCode,
        name: item.stockName,
        ticker: item.itemCode + '.KS',
        marketSum: etf?.marketSum || 0,
        changeRate: parseFloat(item.fluactuationRate || '0'),
        nowVal: parseFloat(item.closePrice?.replace(/,/g, '') || '0'),
        category: cat.emoji + ' ' + cat.label,
        categoryKey: cat.key,
        weight: item.weight,
        listDate: _listDateCache[item.itemCode] || null,
      };
    });

    res.json({ results, stockName, stockCode });
  } catch (err: any) {
    console.error('Stock-to-ETF Search Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

router.get('/naver/list', async (req: Request, res: Response) => {
  try {
    const categoryKey = (req.query.categoryKey as string || '').trim();
    const limit = Math.min(parseInt(req.query.limit as string || '50'), 2000);
    const sort = (req.query.sort as string) || 'marketSum';
    const q = (req.query.q as string || '').trim();

    const items = await fetchNaverETFList();

    // 1. 분류 데이터 캐싱 (매번 수천번 Regex 돌리는 것 방지)
    if (!_naverClassifiedCache) {
      _naverClassifiedCache = items.map(item => ({
        ...item,
        cat: classifyETFByName(item.itemname),
      }));
    }
    const classified = _naverClassifiedCache;

    // 2. 요약 데이터 캐싱 (시총 합계 등)
    if (!_naverSummaryCache) {
      const counts: Record<string, number> = {};
      const marketSums: Record<string, number> = {};
      let totalSum = 0;
      for (const item of classified) {
        const key = item.cat.key;
        counts[key] = (counts[key] || 0) + 1;
        marketSums[key] = (marketSums[key] || 0) + (item.marketSum || 0);
        totalSum += (item.marketSum || 0);
      }
      _naverSummaryCache = { counts, marketSums, totalMarketSum: totalSum };
    }

    const currentMonth = new Date().toISOString().slice(0, 7);

    // new_this_month: 상장일 미캐시 ETF를 즉시 fetch (신규 ETF는 ETFCheck에 없어 Naver fallback 필요)
    if (categoryKey === 'new_this_month') {
      const uncached = classified.filter(i => !_listDateCache[i.itemcode]);
      if (uncached.length > 0) {
        // AUM 오름차순(신규 ETF 우선) 최대 200개 즉시 fetch
        const toFetch = [...uncached]
          .sort((a, b) => a.marketSum - b.marketSum)
          .slice(0, 200);
        await pLimit(
          toFetch.map(it => () => fetchETFReturns(it.itemcode).catch(() => null)),
          10,
        );
      }
    }

    // 초기 전체 로드 시: 미캐시 저시총 ETF를 백그라운드에서 즉시 fetch (신규 ETF isNew 정확도)
    // → 다음 페이지 로드 시 정확한 isNew 값 반환 (이번 요청엔 영향 없음)
    if (!categoryKey && !q) {
      const uncachedLowAum = classified
        .filter(i => !_listDateCache[i.itemcode])
        .sort((a, b) => a.marketSum - b.marketSum)
        .slice(0, 100);
      if (uncachedLowAum.length > 0) {
        pLimit(
          uncachedLowAum.map(it => () => fetchETFReturns(it.itemcode).catch(() => null)),
          8,
        ).catch(() => {});
      }
    }

    let filtered = categoryKey === 'new_this_month'
      ? classified
      : categoryKey
        ? classified.filter(i => {
            if (categoryKey === 'leverage' || categoryKey === 'inverse') return i.cat.key === categoryKey;
            if (i.cat.key === 'leverage' || i.cat.key === 'inverse') return false;
            return i.cat.key === categoryKey;
          })
        : classified;

    if (q) {
      const qLower = q.toLowerCase().replace(/\s/g, '');
      filtered = filtered.filter(i =>
        i.itemname.toLowerCase().replace(/\s/g, '').includes(qLower) ||
        i.itemcode.startsWith(q)
      );
    }

    filtered.sort((a, b) => {
      if (categoryKey === 'new_this_month') return b.marketSum - a.marketSum;
      if (sort === 'threeMonthReturn') return b.threeMonthEarnRate - a.threeMonthEarnRate;
      if (sort === 'changeRate') return b.changeRate - a.changeRate;
      if (sort === 'nowVal') return b.nowVal - a.nowVal;
      return b.marketSum - a.marketSum;
    });

    const sliced = filtered.slice(0, limit);
    const results = sliced.map(item => {
      const listDate = _listDateCache[item.itemcode] || null;

      // Morningstar 캐시에서 평균시가총액 인라인 포함 (별도 API 호출 불필요)
      const msCapBil = getMorningstarAvgCapKrwBillion(item.itemcode);
      const avgCap = msCapBil
        ? { bil: msCapBil, formatted: formatMarketCap(msCapBil), ...sizeLabel(msCapBil), source: 'morningstar' }
        : null;

      return {
        itemcode: item.itemcode,
        name: item.itemname,
        ticker: item.itemcode + '.KS',
        nav: item.nav,
        nowVal: item.nowVal,
        changeRate: item.changeRate,
        marketSum: item.marketSum,
        threeMonthReturn: item.threeMonthEarnRate,
        category: item.cat.emoji + ' ' + item.cat.label,
        categoryKey: item.cat.key,
        etfTabCode: item.etfTabCode,
        region: 'KR',
        listDate,
        isNew: listDate ? listDate.startsWith(currentMonth) : false,
        avgCap,  // null이면 프론트에서 "-" 표시
      };
    });

    res.json({
      results,
      total: filtered.length,
      categoryCounts: _naverSummaryCache.counts,
      categoryMarketSums: _naverSummaryCache.marketSums,
      totalMarketSum: _naverSummaryCache.totalMarketSum,
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/funds/naver/detail/:itemcode ─────────────────────────────────────
router.get('/naver/detail/:itemcode', async (req: Request, res: Response) => {
  try {
    const { itemcode } = req.params;
    const detail = await fetchNaverETFDetail(itemcode);
    res.json(detail);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/funds/naver/holdings/:itemcode ───────────────────────────────────
// 전체 구성종목 (wisereport) + 상위 10개 시가총액 + 가중평균 시총
router.get('/naver/holdings/:itemcode', async (req: Request, res: Response) => {
  try {
    const { itemcode } = req.params;

    // 1) wisereport 전체 구성종목 (이름+비중, 코드 없음)
    // 2) Naver 상위 10개 (코드 있음, 시총 조회용)
    const expand = req.query.expand === '1' || req.query.expand === 'true' || req.query.full === '1';
    const [ { h: fullHoldings, source }, top10 ] = await Promise.all([
      fetchETFHoldingsFull(itemcode, { expand }),
      fetchETFHoldingsTop10(itemcode),
    ]);

    if (!fullHoldings.length && !top10.length) {
      return res.json({ etfCode: itemcode, holdings: [], weightedAvgMarketCap: null, error: 'holdings not found' });
    }

    // 이름 → 코드 맵: top10 우선
    const nameToCode: Record<string, string> = {};
    for (const h of top10) nameToCode[h.name] = h.code;

    // TIME ETF는 xlsx에 6자리 코드 직접 제공 → 100페이지 스크래핑 skip
    const isTimeETF = !!TIME_ETF_MAP[itemcode];
    // 글로벌 ETF 감지: top 5 fullHoldings 중 GLOBAL_TICKER_MAP에 매칭되는 게 있거나
    // weight가 모두 0이면 KR 종목코드맵 skip (대부분 100페이지 KOSPI+KOSDAQ 스크래핑)
    const top5 = fullHoldings.slice(0, 5);
    const isGlobalETF = fullHoldings.length > 0 && (
      fullHoldings.every(h => h.weight === 0) ||
      top5.some(h => lookupGlobalTicker(h.name))
    );

    if (!isGlobalETF && !isTimeETF) {
      // 국내 ETF만 KR 종목코드맵 보완
      const globalMap = await getStockCodeMap().catch(() => ({}));
      for (const [name, code] of Object.entries(globalMap)) {
        if (!nameToCode[name]) nameToCode[name] = code;
      }
    }

    // 전체 목록에 코드 병합 (전체 종목 표시)
    const holdings = fullHoldings.length ? fullHoldings.map(h => ({
      ...h,
      // nameToCode(Naver top10) 우선, 없으면 원본 code 유지 (TIME ETF Bloomberg 티커 등)
      code: nameToCode[h.name] || h.code || '',
    })) : top10;

    // ── KR 6자리 코드만 Naver Finance 시총 조회 ─────────────────────────────────
    const CAP_FETCH_LIMIT = 30;
    const krWithCode = holdings.filter(h => /^\d{6}$/.test(h.code));
    const cached30 = krWithCode.filter(h => _capCache[h.code] && Date.now() - _capCache[h.code].ts < STOCK_CAP_TTL);
    const uncached  = krWithCode.filter(h => !(_capCache[h.code] && Date.now() - _capCache[h.code].ts < STOCK_CAP_TTL));
    const toFetchAll = [...cached30, ...uncached.slice(0, CAP_FETCH_LIMIT)];

    const caps = await Promise.allSettled(toFetchAll.map(h => fetchStockMarketCap(h.code)));
    const codeToCapMap: Record<string, number | null> = {};
    toFetchAll.forEach((h, i) => {
      codeToCapMap[h.code] = caps[i].status === 'fulfilled'
        ? (caps[i] as PromiseFulfilledResult<number | null>).value
        : null;
    });

    // ── 전체 시총 조회 (KR: Naver, 해외 티커: STATIC, 이름만: GLOBAL_TICKER_MAP) ──
    const globalCapResults = await Promise.all(
      holdings.map(async h => {
        if (/^\d{6}$/.test(h.code)) {
          // KR 6자리 → Naver Finance 결과
          return codeToCapMap[h.code] ?? null;
        }
        if (h.code) {
          // Bloomberg 티커 prefix (TIME ETF: RKLB, PL, HON ...) → STATIC_CAP_KRW 직접
          return fetchYahooMarketCapKRW(h.code, 'USD').catch(() => null);
        }
        // code 없음 → 종목명으로 GLOBAL_TICKER_MAP 검색 (WiseReport/ETFCheck 출처)
        const globalEntry = lookupGlobalTicker(h.name);
        if (globalEntry) {
          return fetchYahooMarketCapKRW(globalEntry.ticker, globalEntry.currency).catch(() => null);
        }
        // 사전에 없는 종목 → 회사명으로 Naver 검색 자동 해결
        return fetchNaverWorldCapByName(h.name).catch(() => null);
      })
    );

    const enriched: HoldingInfo[] = holdings.map((h, i) => ({
      ...h,
      marketCapBillion: globalCapResults[i],
    }));

    // 종목기하평균시총: Morningstar 캐시 우선 → 자체 계산 폴백
    let weightedAvg: number | null = null;
    let avgCapSource: 'morningstar' | 'internal' | 'none' = 'none';

    // 1차: 종목별 시총 기반 가중산술평균 자체 계산 (기여 합과 일치)
    let totalStockWeight = 0;
    let weightedSum = 0;
    for (const h of enriched) {
      if (h.marketCapBillion !== null && h.marketCapBillion > 0 && h.weight > 0) {
        totalStockWeight += h.weight;
        weightedSum += h.marketCapBillion * h.weight;
      }
    }
    if (totalStockWeight > 0) {
      weightedAvg = Math.round(weightedSum / totalStockWeight);
      avgCapSource = 'internal';
    } else {
      // 폴백: Morningstar HS03W 캐시 (기하평균) — 시총 매칭이 전혀 없을 때만
      const msKrwBillion = getMorningstarAvgCapKrwBillion(itemcode);
      if (msKrwBillion !== null && msKrwBillion > 0) {
        weightedAvg = msKrwBillion;
        avgCapSource = 'morningstar';
      }
    }

    // 홀딩스 패널 계산값을 ETF 카드(calcAvgCap)와 공유 → 두 값 일치
    if (weightedAvg && avgCapSource === 'internal') {
      _internalAvgCapCache[itemcode] = { avg: weightedAvg, ts: Date.now() };
    }

    const totalWeight = enriched.reduce((s, h) => s + h.weight, 0);
    const size = weightedAvg ? sizeLabel(weightedAvg) : null;

    res.json({
      etfCode: itemcode,
      holdings: enriched,
      weightedAvgMarketCap: weightedAvg,
      weightedAvgFormatted: weightedAvg ? formatMarketCap(weightedAvg) : null,
      sizeLabel: size?.label ?? null,
      sizeColor: size?.color ?? null,
      coverage: avgCapSource === 'morningstar' ? 100 : 0,
      topN: enriched.length,
      totalHoldings: enriched.length,
      source,
      avgCapSource,
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/funds/naver/avgcaps?codes=069500,396500,... ──────────────────────
const _internalAvgCapCache: Record<string, { avg: number; ts: number }> = {};
const AVG_CAP_TTL = 12 * 3600 * 1000;

// 종목평균시총 계산: 자체 가중산술평균 우선 → Morningstar 폴백 (홀딩스 패널 기여합과 일치)
async function calcAvgCap(itemcode: string): Promise<{ avg: number; formatted: string; label: string; color: string } | null> {
  // 1차: 메모리 캐시 (자체 계산 결과)
  if (_internalAvgCapCache[itemcode] && Date.now() - _internalAvgCapCache[itemcode].ts < AVG_CAP_TTL) {
    const ms = _internalAvgCapCache[itemcode].avg;
    const size = sizeLabel(ms);
    return { avg: ms, formatted: formatMarketCap(ms), ...size };
  }

  const { h: fullHoldings } = await fetchETFHoldingsFull(itemcode);
  const top10 = fullHoldings.length === 0 ? await fetchETFHoldingsTop10(itemcode) : [];
  const holdings = fullHoldings.length > 0 ? fullHoldings : top10;
  if (!holdings.length) return null;

  const globalMap = await getStockCodeMap().catch(() => ({}));
  let totalStockWeight = 0;
  let weightedSum = 0;

  // 상위 비중 30개 종목 조회 — 상세 패널(CAP_FETCH_LIMIT=30)과 커버리지 통일
  const sortedHoldings = [...holdings].sort((a, b) => b.weight - a.weight).slice(0, 30);
  
  // 코드 매핑 및 시총 병렬 조회
  // 라우팅: KR 6자리 코드 → Naver Finance(live), 해외 ticker → STATIC_CAP_KRW(근사값)
  const fetchTasks = sortedHoldings.map(async h => {
    if (h.weight <= 0) return { weight: h.weight, cap: null };

    // 1) KR 6자리 코드 → Naver Finance (한글명맵 or 직접 코드)
    const krCode = (globalMap as Record<string, string>)[h.name]
      || (/^\d{6}$/.test((h as any).code || '') ? (h as any).code : '');
    if (krCode) {
      const cap = await fetchStockMarketCap(krCode).catch(() => null);
      return { weight: h.weight, cap };
    }

    // 2) Bloomberg 티커 (TIME ETF: RKLB, PL, HON 등) → STATIC_CAP_KRW 직접
    const rawCode = (h as any).code || '';
    if (rawCode && !/^\d{6}$/.test(rawCode)) {
      const cap = await fetchYahooMarketCapKRW(rawCode, 'USD').catch(() => null);
      if (cap !== null) return { weight: h.weight, cap };
    }

    // 3) 종목명 → GLOBAL_TICKER_MAP (WiseReport/ETFCheck 출처)
    const globalEntry = lookupGlobalTicker(h.name);
    if (globalEntry) {
      const cap = await fetchYahooMarketCapKRW(globalEntry.ticker, globalEntry.currency).catch(() => null);
      return { weight: h.weight, cap };
    }

    // 4) 사전 미등록 → 회사명으로 Naver 검색 자동 해결
    const byName = await fetchNaverWorldCapByName(h.name).catch(() => null);
    return { weight: h.weight, cap: byName };
  });

  const results = await Promise.all(fetchTasks);

  for (const r of results) {
    if (r.cap !== null && r.cap > 0) {
      totalStockWeight += r.weight;
      weightedSum += r.cap * r.weight;
    }
  }

  if (totalStockWeight > 0) {
    const avg = Math.round(weightedSum / totalStockWeight);
    _internalAvgCapCache[itemcode] = { avg, ts: Date.now() };
    const size = sizeLabel(avg);
    return { avg, formatted: formatMarketCap(avg), ...size };
  }

  return null;
}

router.get('/naver/avgcaps', async (req: Request, res: Response) => {
  try {
    const codes = (req.query.codes as string || '')
      .split(',')
      .map(c => c.trim())
      .filter(c => /^[0-9A-Z]{6}$/i.test(c))
      .slice(0, 30);

    if (!codes.length) return res.json({});

    const tasks = codes.map(code => () => calcAvgCap(code).then(r => [code, r] as const).catch(() => [code, null] as const));
    const pairs = await pLimit(tasks, 8);  // 5→8: 캐시 적중 ETF는 즉시 반환이라 부담 없음

    const out: Record<string, typeof pairs[0][1]> = {};
    for (const [code, val] of pairs) out[code] = val;

    res.json(out);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/funds/detail/:secId ─────────────────────────────────────────────
router.get('/detail/:secId', async (req: Request, res: Response) => {
  try {
    const { secId } = req.params;
    res.json({
      secId,
      morningstarUrl: `https://www.morningstar.co.uk/uk/funds/snapshot/snapshot.aspx?id=${secId}`,
      etfUrl: `https://www.morningstar.co.uk/uk/etf/snapshot/snapshot.aspx?id=${secId}`,
    });
  } catch (err: any) {
    console.error('Fund detail error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── ETF 수익률 & 정보 (ETFCheck 기반 — 분배금 포함 총수익률) ────────────────────
interface ReturnData {
  m1: number | null;
  m3: number | null;
  m6: number | null;
  y1: number | null;
  y3: number | null;
  y5: number | null;
  y10: number | null;
  ytd: number | null;
  listDate: string | null;  // "YYYY-MM-DD"
  asOf: string | null;      // 수익률 기준일 "YYYY-MM-DD" (직전 영업일)
  ter: number | null;       // 총보수율 (%) — F34763
  realCost: number | null;  // 실비용률 (%) — F19329 (총보수+거래비용 포함 실질비용)
}

const _returnsCache: Record<string, { data: ReturnData; ts: number }> = {};
const RETURNS_TTL = 3 * 60 * 60 * 1000; // 3h

// 상장일은 변하지 않으므로 만료 없이 영구 보관
const _listDateCache: Record<string, string> = {};

/** 직전 영업일 (월~금 기준, 공휴일 미보정) YYYYMMDD 문자열 반환 */
function prevTradingDate(): string {
  const d = new Date();
  // 한국 시간 기준 16:30 이후면 오늘 NAV 확정 → 오늘 날짜 사용
  const kstHour = (d.getUTCHours() + 9) % 24;
  const kstMin  = d.getUTCMinutes();
  const isAfterClose = kstHour > 16 || (kstHour === 16 && kstMin >= 30);

  if (!isAfterClose) {
    // 장중 또는 장 전 → 전날로 이동
    d.setDate(d.getDate() - 1);
  }
  // 토요일(6) → 금요일, 일요일(0) → 금요일
  const dow = d.getDay();
  if (dow === 6) d.setDate(d.getDate() - 1);
  if (dow === 0) d.setDate(d.getDate() - 2);

  return (
    String(d.getFullYear()) +
    String(d.getMonth() + 1).padStart(2, '0') +
    String(d.getDate()).padStart(2, '0')
  );
}

/** ETFCheck 요청 인증 토큰 (1분 단위 갱신) */
function getEtcCheckToken(): string {
  const KEY = '4lm@flEh68';
  const a = String(Math.floor(Date.now() / 60000));
  let r = '';
  for (let i = 0; i < a.length; i++) r += KEY[parseInt(a[i])];
  return crypto.createHash('sha256').update(r).digest('hex');
}

async function fetchETFReturns(itemcode: string): Promise<ReturnData | null> {
  const hit = _returnsCache[itemcode];
  if (hit && Date.now() - hit.ts < RETURNS_TTL) return hit.data;

  // 직전 영업일 기준 (장중에는 T-1, 장 마감 후 16:30~에는 T 사용)
  const befDate = prevTradingDate();

  try {
    const token = getEtcCheckToken();
    const url = `https://www.etfcheck.co.kr/user/etp/getEtpItemInfo?code=${itemcode}&befDate=${befDate}`;

    const resp = await new Promise<any>((resolve, reject) => {
      const req = https.get(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0',
          'Referer': 'https://www.etfcheck.co.kr/',
          'Checkclient': token,
          'Accept': 'application/json',
        },
      }, res => {
        let body = '';
        res.on('data', c => body += c);
        res.on('end', () => {
          try { resolve(JSON.parse(body)); }
          catch { reject(new Error('ETFCheck parse error')); }
        });
      });
      req.on('error', reject);
      req.setTimeout(10000, () => req.destroy(new Error('timeout')));
    });

    if (!resp.success || !resp.results?.[0]) {
      // ETFCheck 데이터 없음 → Naver 상세 페이지 fallback (총보수·상장일)
      return fetchNaverFallbackReturns(itemcode);
    }

    const r = resp.results[0];

    // 상장일 YYYYMMDD → "YYYY-MM-DD"
    const raw = r.F16017 as string | undefined;
    const listDate = raw && raw.length === 8
      ? `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}`
      : null;

    // 수익률 기준일: ETFCheck가 반환하는 실제 기준일 (YYYYMMDD → "YYYY-MM-DD")
    // F16018 = 수익률 산출 기준일, 없으면 befDate를 fallback으로 사용
    const asOfRaw = (r.F16018 as string | undefined) || befDate;
    const asOf = asOfRaw && asOfRaw.length === 8
      ? `${asOfRaw.slice(0, 4)}-${asOfRaw.slice(4, 6)}-${asOfRaw.slice(6, 8)}`
      : `${befDate.slice(0, 4)}-${befDate.slice(4, 6)}-${befDate.slice(6, 8)}`;

    const pf = (v: any): number | null => {
      const n = parseFloat(v);
      return isNaN(n) ? null : +n.toFixed(2);
    };

    const data: ReturnData = {
      // 분배금 포함 총수익률 (YLD* 필드)
      m1:  pf(r.YLD1MR),
      m3:  pf(r.YLD3MR),
      m6:  pf(r.YLD6MR),
      ytd: pf(r.YLDYTDR),
      y1:  pf(r.YLD1YR),
      y3:  pf(r.W01007),      // 3Y 누적 총수익률
      y5:  pf(r.W01008),      // 5Y 누적 총수익률
      y10: pf(r.W01009),      // 10Y 누적 총수익률
      listDate,
      asOf,
      ter:      pf(r.F34763), // 총보수 (운용+신탁+사무관리+지정참가회사)
      realCost: null,          // F19329 필드 매핑 불확실 — 미사용
    };

    _returnsCache[itemcode] = { data, ts: Date.now() };
    if (data.listDate) _listDateCache[itemcode] = data.listDate; // 영구 캐시
    return data;
  } catch {
    // ETFCheck 예외 → Naver fallback
    return fetchNaverFallbackReturns(itemcode);
  }
}

/** ETFCheck 실패 시 Naver 상세 페이지에서 총보수·상장일만 수집 */
async function fetchNaverFallbackReturns(itemcode: string): Promise<ReturnData | null> {
  try {
    const detail = await fetchNaverETFDetail(itemcode);

    const terMatch = detail.expRatio?.match(/([\d.]+)/);
    const ter = terMatch ? parseFloat(terMatch[1]) : null;

    // "YYYY.MM.DD" 또는 "YYYY-MM-DD" 형태 모두 처리
    const rawDate = detail.listedDate?.replace(/\./g, '-').trim() || null;
    const listDate = rawDate && /^\d{4}-\d{2}-\d{2}$/.test(rawDate) ? rawDate : null;

    if (ter === null && !listDate) return null;

    const data: ReturnData = {
      m1: null, m3: null, m6: null, ytd: null, y1: null, y3: null, y5: null, y10: null,
      listDate,
      asOf: null,
      ter,
      realCost: null,
    };
    // 수익률 데이터가 없는 fallback 결과는 5분 후 재시도 (ETFCheck 일시 실패 대비)
    const SHORT_TTL = 5 * 60 * 1000;
    _returnsCache[itemcode] = { data, ts: Date.now() - (RETURNS_TTL - SHORT_TTL) };
    if (listDate) _listDateCache[itemcode] = listDate;
    return data;
  } catch {
    return null;
  }
}

// ── GET /api/funds/naver/returns?codes=069500,360750,... ─────────────────────
router.get('/naver/returns', async (req: Request, res: Response) => {
  try {
    const codes = ((req.query.codes as string) || '')
      .split(',')
      .map(c => c.trim())
      .filter(c => /^[A-Z0-9]{5,6}$/i.test(c))   // 숫자 전용 → 영숫자 허용
      .slice(0, 200);

    if (!codes.length) return void res.json({});

    const tasks = codes.map(code => () =>
      fetchETFReturns(code)
        .then(data => [code, data] as const)
        .catch(() => [code, null] as const)
    );
    const pairs = await pLimit(tasks, 3);

    const out: Record<string, ReturnData | null> = {};
    for (const [code, data] of pairs) out[code] = data;

    res.json(out);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// 서버 시작 시 캐시 워밍업
setTimeout(async () => {
  let allItems: NaverETFItem[] = [];
  try {
    allItems = await fetchNaverETFList();
    console.log('[funds] Naver ETF 리스트 캐시 완료');
  } catch (e) {
    console.warn('[funds] Naver ETF 캐시 워밍업 실패:', e);
  }

  if (allItems.length) {
    // 시총 내림차순 정렬
    const sorted = [...allItems].sort((a, b) => b.marketSum - a.marketSum);

    // 상위 300개: 먼저 워밍업 (ETF Finder 첫 페이지 속도)
    const top300 = sorted.slice(0, 300);
    try {
      await pLimit(top300.map(it => () => fetchETFReturns(it.itemcode).catch(() => null)), 10);
      console.log(`[funds] 상위 300개 수익률/상장일 캐시 완료`);
    } catch (e) {
      console.warn('[funds] 상위 300 워밍업 실패:', e);
    }

    // 나머지: 백그라운드에서 조용히 (concurrency 3, 부하 최소화)
    // ※ AUM 오름차순으로 재정렬 → 신규 ETF(저시총)가 먼저 캐시돼 isNew 정확도 향상
    const rest = sorted.slice(300).sort((a, b) => a.marketSum - b.marketSum);
    (async () => {
      try {
        await pLimit(rest.map(it => () => fetchETFReturns(it.itemcode).catch(() => null)), 3);
        console.log(`[funds] 전체 ETF 수익률/상장일 캐시 완료 (${allItems.length}개)`);
      } catch { /* silent */ }
    })();
  }
  // 종목 코드맵은 약간 늦게 (ETF 리스트보다 오래 걸림)
  setTimeout(async () => {
    try {
      await getStockCodeMap();
    } catch (e) {
      console.warn('[funds] 종목 코드맵 빌드 실패:', e);
    }
  }, 5000);
}, 3000);

export default router;
