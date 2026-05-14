import { Router, Request, Response } from 'express';
import { getQuote, getChart } from '../yahooApi.js';
import { getYahooPE } from '../yahooPeScraper.js';

const router = Router();

// 후보 풀: 각 시장별 시총 상위 ~25-30종목
// Yahoo 심볼 기준, 상장주식수는 공개 정보
const CANDIDATES = [
  // === 🇨🇳 상해 (Shanghai Main Board, 600xxx/601xxx/603xxx) TOP 20 ===
  { symbol: '600519.SS', name: '귀주마오타이 (Moutai)', group: '🇨🇳 상해', shares: 1_256_197_800 },
  { symbol: '601398.SS', name: '공상은행 (ICBC)', group: '🇨🇳 상해', shares: 356_406_257_089 },
  { symbol: '601939.SS', name: '건설은행 (CCB)', group: '🇨🇳 상해', shares: 250_010_977_486 },
  { symbol: '601288.SS', name: '농업은행 (ABC)', group: '🇨🇳 상해', shares: 349_983_031_539 },
  { symbol: '601857.SS', name: '페트로차이나', group: '🇨🇳 상해', shares: 183_020_977_818 },
  { symbol: '601988.SS', name: '중국은행 (BOC)', group: '🇨🇳 상해', shares: 294_387_791_241 },
  { symbol: '601318.SS', name: '평안보험 (Ping An)', group: '🇨🇳 상해', shares: 18_210_234_607 },
  { symbol: '600938.SS', name: 'CNOOC (중국해양석유)', group: '🇨🇳 상해', shares: 47_558_200_000 },
  { symbol: '600941.SS', name: '중국이동 (China Mobile)', group: '🇨🇳 상해', shares: 21_395_526_596 },
  { symbol: '601328.SS', name: '교통은행 (BoComm)', group: '🇨🇳 상해', shares: 74_262_726_645 },
  { symbol: '600036.SS', name: '초상은행 (CMB)', group: '🇨🇳 상해', shares: 25_219_845_087 },
  { symbol: '601628.SS', name: '중국생명보험', group: '🇨🇳 상해', shares: 28_264_705_000 },
  { symbol: '600900.SS', name: '중국장강전력', group: '🇨🇳 상해', shares: 24_468_440_000 },
  { symbol: '601658.SS', name: '우정저축은행 (PSBC)', group: '🇨🇳 상해', shares: 99_161_086_038 },
  { symbol: '600028.SS', name: '시노펙 (Sinopec)', group: '🇨🇳 상해', shares: 121_071_209_646 },
  { symbol: '601166.SS', name: '흥업은행', group: '🇨🇳 상해', shares: 20_774_029_091 },
  { symbol: '600030.SS', name: 'CITIC 증권', group: '🇨🇳 상해', shares: 14_820_546_829 },
  { symbol: '600887.SS', name: '이리유업', group: '🇨🇳 상해', shares: 6_327_970_876 },
  { symbol: '600276.SS', name: '헝루이제약', group: '🇨🇳 상해', shares: 6_371_268_824 },
  { symbol: '601601.SS', name: '중국태평양보험', group: '🇨🇳 상해', shares: 9_620_000_000 },

  // === 🇨🇳 심천 (Shenzhen Main Board, 000xxx/002xxx) TOP 20 ===
  { symbol: '000858.SZ', name: '우량예 (Wuliangye)', group: '🇨🇳 심천', shares: 3_882_060_000 },
  { symbol: '002594.SZ', name: 'BYD (A주)', group: '🇨🇳 심천', shares: 2_175_921_074 },
  { symbol: '002415.SZ', name: '하이크비전 (Hikvision)', group: '🇨🇳 심천', shares: 9_281_000_000 },
  { symbol: '000333.SZ', name: '메이디그룹 (Midea)', group: '🇨🇳 심천', shares: 6_900_000_000 },
  { symbol: '000651.SZ', name: '거리전기 (Gree Electric)', group: '🇨🇳 심천', shares: 5_700_000_000 },
  { symbol: '000001.SZ', name: '평안은행 (Ping An Bank)', group: '🇨🇳 심천', shares: 19_400_000_000 },
  { symbol: '000725.SZ', name: 'BOE기술 (BOE Technology)', group: '🇨🇳 심천', shares: 35_000_000_000 },
  { symbol: '000100.SZ', name: 'TCL테크 (TCL Technology)', group: '🇨🇳 심천', shares: 17_000_000_000 },
  { symbol: '002311.SZ', name: '해천미업 (Haitian Flavouring)', group: '🇨🇳 심천', shares: 1_270_000_000 },
  { symbol: '002352.SZ', name: 'SF홀딩스 (SF Holding)', group: '🇨🇳 심천', shares: 1_550_000_000 },
  { symbol: '000568.SZ', name: '루저우라오자오 (Luzhou Laojiao)', group: '🇨🇳 심천', shares: 1_470_000_000 },
  { symbol: '000063.SZ', name: '중흥통신 (ZTE)', group: '🇨🇳 심천', shares: 4_600_000_000 },
  { symbol: '002027.SZ', name: '분중정보 (Focus Media)', group: '🇨🇳 심천', shares: 13_000_000_000 },
  { symbol: '002714.SZ', name: '목원식품 (Muyuan Foods)', group: '🇨🇳 심천', shares: 3_900_000_000 },
  { symbol: '000776.SZ', name: '광발증권 (GF Securities)', group: '🇨🇳 심천', shares: 6_100_000_000 },
  { symbol: '000895.SZ', name: '쌍후이발전 (Shuanghui Dev)', group: '🇨🇳 심천', shares: 1_700_000_000 },
  { symbol: '002475.SZ', name: '립신정밀 (Luxshare Precision)', group: '🇨🇳 심천', shares: 4_600_000_000 },
  { symbol: '000166.SZ', name: '신완홍위안 (Shenwan Hongyuan)', group: '🇨🇳 심천', shares: 11_000_000_000 },
  { symbol: '002142.SZ', name: '녕파은행 (Bank of Ningbo)', group: '🇨🇳 심천', shares: 7_600_000_000 },
  { symbol: '002236.SZ', name: '대화기술 (Dahua Technology)', group: '🇨🇳 심천', shares: 4_100_000_000 },

  // === 🇨🇳 과창판 (STAR Market, 688xxx) TOP 20 ===
  { symbol: '688981.SS', name: 'SMIC (중심국제반도체)', group: '🇨🇳 과창판', shares: 8_700_000_000 },
  { symbol: '688041.SS', name: '해광정보기술 (Hygon)', group: '🇨🇳 과창판', shares: 1_000_000_000 },
  { symbol: '688111.SS', name: 'WPS오피스 (Kingsoft Office)', group: '🇨🇳 과창판', shares: 200_000_000 },
  { symbol: '688271.SS', name: '연영의료 (United Imaging)', group: '🇨🇳 과창판', shares: 400_000_000 },
  { symbol: '688036.SS', name: '전음홀딩스 (Transsion)', group: '🇨🇳 과창판', shares: 400_000_000 },
  { symbol: '688256.SS', name: '한무기 (Cambricon AI칩)', group: '🇨🇳 과창판', shares: 400_000_000 },
  { symbol: '688187.SS', name: '시대전기 (CRRC Times Electric)', group: '🇨🇳 과창판', shares: 1_000_000_000 },
  { symbol: '688009.SS', name: '중국통호 (China Railway Signal)', group: '🇨🇳 과창판', shares: 6_400_000_000 },
  { symbol: '688126.SS', name: '호규산업 (Shanghai Silicon)', group: '🇨🇳 과창판', shares: 2_000_000_000 },
  { symbol: '688169.SS', name: '석두과기 (Roborock)', group: '🇨🇳 과창판', shares: 100_000_000 },
  { symbol: '688012.SS', name: '중미공사 (AMEC 반도체장비)', group: '🇨🇳 과창판', shares: 500_000_000 },
  { symbol: '688561.SS', name: '기안신 (QAX 사이버보안)', group: '🇨🇳 과창판', shares: 700_000_000 },
  { symbol: '688363.SS', name: '화희생물 (Bloomage Biotech)', group: '🇨🇳 과창판', shares: 280_000_000 },
  { symbol: '688223.SS', name: '정과에너지 (Jinko Solar A)', group: '🇨🇳 과창판', shares: 4_600_000_000 },
  { symbol: '688599.SS', name: '천합광능 (Trina Solar A)', group: '🇨🇳 과창판', shares: 3_000_000_000 },
  { symbol: '688303.SS', name: '대전에너지 (Daqo New Energy A)', group: '🇨🇳 과창판', shares: 500_000_000 },
  { symbol: '688055.SS', name: '기린과기 (Loongson Technology)', group: '🇨🇳 과창판', shares: 200_000_000 },
  { symbol: '688390.SS', name: '고더위 (GoodWe Power)', group: '🇨🇳 과창판', shares: 100_000_000 },
  { symbol: '688008.SS', name: '란기과기 (Montage Technology)', group: '🇨🇳 과창판', shares: 800_000_000 },
  { symbol: '688180.SS', name: '군실생물 (Junshi Biosciences)', group: '🇨🇳 과창판', shares: 1_600_000_000 },

  // === 🇨🇳 창업판 (ChiNext, 300xxx) TOP 20 ===
  { symbol: '300750.SZ', name: 'CATL (닝더스다이)', group: '🇨🇳 창업판', shares: 4_399_434_670 },
  { symbol: '300760.SZ', name: '마인드레이 의료 (Mindray)', group: '🇨🇳 창업판', shares: 1_213_000_000 },
  { symbol: '300059.SZ', name: '동방재부 (East Money)', group: '🇨🇳 창업판', shares: 14_000_000_000 },
  { symbol: '300274.SZ', name: '양광전원 (Sungrow Power)', group: '🇨🇳 창업판', shares: 2_400_000_000 },
  { symbol: '300015.SZ', name: '아이얼안과 (Aier Eye Hospital)', group: '🇨🇳 창업판', shares: 4_700_000_000 },
  { symbol: '300124.SZ', name: '회천기술 (Inovance Technology)', group: '🇨🇳 창업판', shares: 1_400_000_000 },
  { symbol: '300014.SZ', name: '억위리능 (EVE Energy)', group: '🇨🇳 창업판', shares: 1_500_000_000 },
  { symbol: '300999.SZ', name: '금룡어 (Yihai Kerry Arawana)', group: '🇨🇳 창업판', shares: 5_400_000_000 },
  { symbol: '300308.SZ', name: '중제욱창 (InnoLight Technology)', group: '🇨🇳 창업판', shares: 790_000_000 },
  { symbol: '300122.SZ', name: '지비생물 (Zhifei Biological)', group: '🇨🇳 창업판', shares: 840_000_000 },
  { symbol: '300033.SZ', name: '동화순 (Tonghuashun Finance)', group: '🇨🇳 창업판', shares: 330_000_000 },
  { symbol: '300498.SZ', name: '온씨주업 (Wens Foodstuff)', group: '🇨🇳 창업판', shares: 3_300_000_000 },
  { symbol: '300413.SZ', name: '망과초매 (Mango TV)', group: '🇨🇳 창업판', shares: 540_000_000 },
  { symbol: '300316.SZ', name: '정성기전 (Jingsheng Mechanical)', group: '🇨🇳 창업판', shares: 790_000_000 },
  { symbol: '300661.SZ', name: '성방고분 (Sgmicro)', group: '🇨🇳 창업판', shares: 190_000_000 },
  { symbol: '300450.SZ', name: '선도지능 (Lead Intelligent Equip)', group: '🇨🇳 창업판', shares: 980_000_000 },
  { symbol: '300628.SZ', name: '억련네트워크 (Yealink Network)', group: '🇨🇳 창업판', shares: 220_000_000 },
  { symbol: '300142.SZ', name: '왈생물 (Watson Biotech)', group: '🇨🇳 창업판', shares: 340_000_000 },
  { symbol: '300363.SZ', name: '박등고분 (Porton Pharma)', group: '🇨🇳 창업판', shares: 450_000_000 },
  { symbol: '300957.SZ', name: '패태니 (Beiersdorf/Proya 계열)', group: '🇨🇳 창업판', shares: 230_000_000 },

  // === 🇭🇰 홍콩 TOP 25 ===
  { symbol: '0700.HK', name: '텐센트 (Tencent)', group: '🇭🇰 홍콩', shares: 9_186_000_000 },
  { symbol: '9988.HK', name: '알리바바 (Alibaba)', group: '🇭🇰 홍콩', shares: 18_937_000_000 },
  { symbol: '0005.HK', name: 'HSBC 홀딩스', group: '🇭🇰 홍콩', shares: 17_823_000_000 },
  { symbol: '3690.HK', name: '메이투안 (Meituan)', group: '🇭🇰 홍콩', shares: 6_079_000_000 },
  { symbol: '1299.HK', name: 'AIA 그룹', group: '🇭🇰 홍콩', shares: 10_876_000_000 },
  { symbol: '0939.HK', name: '건설은행 H주', group: '🇭🇰 홍콩', shares: 240_417_319_880 },
  { symbol: '1398.HK', name: '공상은행 H주', group: '🇭🇰 홍콩', shares: 86_794_044_550 },
  { symbol: '0941.HK', name: '중국이동 H주', group: '🇭🇰 홍콩', shares: 20_475_482_897 },
  { symbol: '9618.HK', name: 'JD.com', group: '🇭🇰 홍콩', shares: 1_430_000_000 },
  { symbol: '1211.HK', name: 'BYD H주', group: '🇭🇰 홍콩', shares: 2_915_000_000 },
  { symbol: '0388.HK', name: 'HKEX (홍콩거래소)', group: '🇭🇰 홍콩', shares: 1_267_000_000 },
  { symbol: '2318.HK', name: '평안보험 H주', group: '🇭🇰 홍콩', shares: 7_448_000_000 },
  { symbol: '2020.HK', name: '안타 스포츠', group: '🇭🇰 홍콩', shares: 2_815_000_000 },
  { symbol: '1810.HK', name: '샤오미 (Xiaomi)', group: '🇭🇰 홍콩', shares: 24_940_000_000 },
  { symbol: '9999.HK', name: '넷이즈 (NetEase)', group: '🇭🇰 홍콩', shares: 3_164_000_000 },
  { symbol: '1113.HK', name: 'CK Hutchison', group: '🇭🇰 홍콩', shares: 3_854_000_000 },
  { symbol: '0175.HK', name: '지리자동차 (Geely)', group: '🇭🇰 홍콩', shares: 10_073_000_000 },
  { symbol: '0883.HK', name: 'CNOOC H주', group: '🇭🇰 홍콩', shares: 47_558_000_000 },
  { symbol: '2388.HK', name: 'BOC Hong Kong', group: '🇭🇰 홍콩', shares: 10_573_000_000 },
  { symbol: '0001.HK', name: 'CK Asset', group: '🇭🇰 홍콩', shares: 3_608_000_000 },
  { symbol: '3988.HK', name: '중국은행 H주', group: '🇭🇰 홍콩', shares: 294_387_791_241 },
  { symbol: '2628.HK', name: '중국생명 H주', group: '🇭🇰 홍콩', shares: 28_264_705_000 },
  { symbol: '6862.HK', name: '하이디라오 (Haidilao)', group: '🇭🇰 홍콩', shares: 5_570_000_000 },
  { symbol: '2382.HK', name: 'Sunny Optical', group: '🇭🇰 홍콩', shares: 1_096_000_000 },
  { symbol: '0992.HK', name: '레노버 (Lenovo)', group: '🇭🇰 홍콩', shares: 12_429_000_000 },

  // === 🇮🇳 인도 TOP 20 (NSE) ===
  { symbol: 'RELIANCE.NS', name: 'Reliance Industries', group: '🇮🇳 인도', shares: 6_766_000_000 },
  { symbol: 'TCS.NS', name: 'Tata Consultancy Services', group: '🇮🇳 인도', shares: 3_617_000_000 },
  { symbol: 'HDFCBANK.NS', name: 'HDFC Bank', group: '🇮🇳 인도', shares: 7_644_000_000 },
  { symbol: 'BHARTIARTL.NS', name: 'Bharti Airtel', group: '🇮🇳 인도', shares: 5_981_000_000 },
  { symbol: 'ICICIBANK.NS', name: 'ICICI Bank', group: '🇮🇳 인도', shares: 7_039_000_000 },
  { symbol: 'INFY.NS', name: 'Infosys', group: '🇮🇳 인도', shares: 4_147_000_000 },
  { symbol: 'SBIN.NS', name: 'State Bank of India', group: '🇮🇳 인도', shares: 8_924_000_000 },
  { symbol: 'HINDUNILVR.NS', name: 'Hindustan Unilever', group: '🇮🇳 인도', shares: 2_349_000_000 },
  { symbol: 'LT.NS', name: 'Larsen & Toubro', group: '🇮🇳 인도', shares: 1_373_000_000 },
  { symbol: 'ITC.NS', name: 'ITC Limited', group: '🇮🇳 인도', shares: 12_511_000_000 },
  { symbol: 'BAJFINANCE.NS', name: 'Bajaj Finance', group: '🇮🇳 인도', shares: 618_000_000 },
  { symbol: 'MARUTI.NS', name: 'Maruti Suzuki', group: '🇮🇳 인도', shares: 302_000_000 },
  { symbol: 'KOTAKBANK.NS', name: 'Kotak Mahindra Bank', group: '🇮🇳 인도', shares: 1_989_000_000 },
  { symbol: 'AXISBANK.NS', name: 'Axis Bank', group: '🇮🇳 인도', shares: 3_081_000_000 },
  { symbol: 'HCLTECH.NS', name: 'HCL Technologies', group: '🇮🇳 인도', shares: 2_714_000_000 },
  { symbol: 'ASIANPAINT.NS', name: 'Asian Paints', group: '🇮🇳 인도', shares: 959_000_000 },
  { symbol: 'SUNPHARMA.NS', name: 'Sun Pharma', group: '🇮🇳 인도', shares: 2_400_000_000 },
  { symbol: 'TITAN.NS', name: 'Titan Company', group: '🇮🇳 인도', shares: 887_000_000 },
  { symbol: 'NTPC.NS', name: 'NTPC', group: '🇮🇳 인도', shares: 9_697_000_000 },
  { symbol: 'ONGC.NS', name: 'ONGC', group: '🇮🇳 인도', shares: 12_580_000_000 },
  { symbol: 'TATAMOTORS.NS', name: 'Tata Motors', group: '🇮🇳 인도', shares: 3_683_000_000 },
  { symbol: 'POWERGRID.NS', name: 'Power Grid', group: '🇮🇳 인도', shares: 9_301_000_000 },
  { symbol: 'WIPRO.NS', name: 'Wipro', group: '🇮🇳 인도', shares: 5_227_000_000 },
  { symbol: 'ULTRACEMCO.NS', name: 'UltraTech Cement', group: '🇮🇳 인도', shares: 289_000_000 },
  { symbol: 'M&M.NS', name: 'Mahindra & Mahindra', group: '🇮🇳 인도', shares: 1_197_000_000 },

  // === 🇹🇼 대만 TOP 20 (TWSE) ===
  { symbol: '2330.TW', name: 'TSMC (타이완 반도체)', group: '🇹🇼 대만', shares: 25_930_000_000 },
  { symbol: '2317.TW', name: '홍하이정밀 (Foxconn)', group: '🇹🇼 대만', shares: 13_870_000_000 },
  { symbol: '2454.TW', name: 'MediaTek', group: '🇹🇼 대만', shares: 1_603_000_000 },
  { symbol: '2412.TW', name: '중화텔레콤', group: '🇹🇼 대만', shares: 7_757_000_000 },
  { symbol: '2882.TW', name: 'Cathay 금융', group: '🇹🇼 대만', shares: 14_628_000_000 },
  { symbol: '6505.TW', name: 'Formosa Petrochemical', group: '🇹🇼 대만', shares: 9_525_000_000 },
  { symbol: '2891.TW', name: 'CTBC 금융', group: '🇹🇼 대만', shares: 19_586_000_000 },
  { symbol: '3008.TW', name: 'Largan Precision', group: '🇹🇼 대만', shares: 134_000_000 },
  { symbol: '1301.TW', name: 'Formosa Plastics', group: '🇹🇼 대만', shares: 6_365_000_000 },
  { symbol: '2881.TW', name: 'Fubon 금융', group: '🇹🇼 대만', shares: 12_811_000_000 },
  { symbol: '1303.TW', name: 'Nan Ya Plastics', group: '🇹🇼 대만', shares: 7_936_000_000 },
  { symbol: '2308.TW', name: 'Delta Electronics', group: '🇹🇼 대만', shares: 2_598_000_000 },
  { symbol: '3711.TW', name: 'ASE Technology', group: '🇹🇼 대만', shares: 4_340_000_000 },
  { symbol: '2303.TW', name: 'UMC (United Microelectronics)', group: '🇹🇼 대만', shares: 12_478_000_000 },
  { symbol: '1216.TW', name: 'Uni-President', group: '🇹🇼 대만', shares: 5_685_000_000 },
  { symbol: '2886.TW', name: 'Mega 금융', group: '🇹🇼 대만', shares: 14_283_000_000 },
  { symbol: '2002.TW', name: 'China Steel', group: '🇹🇼 대만', shares: 15_758_000_000 },
  { symbol: '2207.TW', name: 'Hotai Motor', group: '🇹🇼 대만', shares: 545_000_000 },
  { symbol: '5880.TW', name: 'First 금융', group: '🇹🇼 대만', shares: 14_018_000_000 },
  { symbol: '2884.TW', name: 'E.SUN 금융', group: '🇹🇼 대만', shares: 15_628_000_000 },
  { symbol: '2357.TW', name: 'ASUS', group: '🇹🇼 대만', shares: 743_000_000 },
  { symbol: '2603.TW', name: 'Evergreen Marine', group: '🇹🇼 대만', shares: 2_120_000_000 },
  { symbol: '2801.TW', name: 'Chang Hwa Bank', group: '🇹🇼 대만', shares: 11_340_000_000 },
  { symbol: '3034.TW', name: 'Novatek', group: '🇹🇼 대만', shares: 608_000_000 },
  { symbol: '2885.TW', name: 'Yuanta 금융', group: '🇹🇼 대만', shares: 13_870_000_000 },

  // === 🇯🇵 일본 TOP 25 ===
  { symbol: '7203.T', name: '도요타 자동차 (Toyota)', group: '🇯🇵 일본', shares: 13_236_000_000 },
  { symbol: '6758.T', name: '소니 (Sony)', group: '🇯🇵 일본', shares: 1_248_000_000 },
  { symbol: '8306.T', name: 'Mitsubishi UFJ 금융', group: '🇯🇵 일본', shares: 12_311_000_000 },
  { symbol: '6861.T', name: '키엔스 (Keyence)', group: '🇯🇵 일본', shares: 243_000_000 },
  { symbol: '7974.T', name: '닌텐도 (Nintendo)', group: '🇯🇵 일본', shares: 116_000_000 },
  { symbol: '9984.T', name: '소프트뱅크 그룹', group: '🇯🇵 일본', shares: 1_446_000_000 },
  { symbol: '4063.T', name: '신에쓰화학 (Shin-Etsu)', group: '🇯🇵 일본', shares: 410_000_000 },
  { symbol: '6098.T', name: '리쿠르트 홀딩스', group: '🇯🇵 일본', shares: 1_655_000_000 },
  { symbol: '6981.T', name: '무라타제작소 (Murata)', group: '🇯🇵 일본', shares: 2_049_000_000 },
  { symbol: '8058.T', name: '미쓰비시상사', group: '🇯🇵 일본', shares: 1_427_000_000 },
  { symbol: '4502.T', name: '타케다 제약 (Takeda)', group: '🇯🇵 일본', shares: 1_579_000_000 },
  { symbol: '6501.T', name: '히타치 (Hitachi)', group: '🇯🇵 일본', shares: 4_528_000_000 },
  { symbol: '9432.T', name: 'NTT (일본전신전화)', group: '🇯🇵 일본', shares: 9_018_000_000 },
  { symbol: '8035.T', name: '도쿄일렉트론 (TEL)', group: '🇯🇵 일본', shares: 311_000_000 },
  { symbol: '8766.T', name: '도쿄해상홀딩스', group: '🇯🇵 일본', shares: 1_963_000_000 },
  { symbol: '9983.T', name: '패스트리테일링 (유니클로)', group: '🇯🇵 일본', shares: 101_000_000 },
  { symbol: '4519.T', name: '추가이 제약', group: '🇯🇵 일본', shares: 1_674_000_000 },
  { symbol: '6367.T', name: '다이킨공업 (Daikin)', group: '🇯🇵 일본', shares: 292_000_000 },
  { symbol: '4568.T', name: '다이이치산쿄', group: '🇯🇵 일본', shares: 1_949_000_000 },
  { symbol: '7267.T', name: '혼다자동차 (Honda)', group: '🇯🇵 일본', shares: 5_435_000_000 },
  { symbol: '8316.T', name: '미쓰이스미토모 금융', group: '🇯🇵 일본', shares: 1_303_000_000 },
  { symbol: '8411.T', name: '미즈호 금융그룹', group: '🇯🇵 일본', shares: 2_537_000_000 },
  { symbol: '9433.T', name: 'KDDI', group: '🇯🇵 일본', shares: 2_205_000_000 },
  { symbol: '6902.T', name: '덴소 (Denso)', group: '🇯🇵 일본', shares: 3_027_000_000 },
  { symbol: '8031.T', name: '미쓰이물산', group: '🇯🇵 일본', shares: 1_551_000_000 },

  // === 🇺🇸 미국 TOP 30 ===
  { symbol: 'AAPL', name: '애플 (Apple)', group: '🇺🇸 미국', shares: 15_000_000_000 },
  { symbol: 'MSFT', name: '마이크로소프트 (Microsoft)', group: '🇺🇸 미국', shares: 7_430_000_000 },
  { symbol: 'NVDA', name: '엔비디아 (NVIDIA)', group: '🇺🇸 미국', shares: 24_530_000_000 },
  { symbol: 'GOOGL', name: '알파벳 A (Alphabet)', group: '🇺🇸 미국', shares: 12_350_000_000 },
  { symbol: 'AMZN', name: '아마존 (Amazon)', group: '🇺🇸 미국', shares: 10_580_000_000 },
  { symbol: 'META', name: '메타 (Meta)', group: '🇺🇸 미국', shares: 2_530_000_000 },
  { symbol: 'TSLA', name: '테슬라 (Tesla)', group: '🇺🇸 미국', shares: 3_175_000_000 },
  { symbol: 'BRK-B', name: '버크셔 해서웨이 B', group: '🇺🇸 미국', shares: 2_165_000_000 },
  { symbol: 'LLY', name: '일라이 릴리 (Eli Lilly)', group: '🇺🇸 미국', shares: 950_000_000 },
  { symbol: 'V', name: '비자 (Visa)', group: '🇺🇸 미국', shares: 1_810_000_000 },
  { symbol: 'JPM', name: 'JP모건 체이스', group: '🇺🇸 미국', shares: 2_810_000_000 },
  { symbol: 'WMT', name: '월마트 (Walmart)', group: '🇺🇸 미국', shares: 8_036_000_000 },
  { symbol: 'XOM', name: '엑슨모빌 (Exxon Mobil)', group: '🇺🇸 미국', shares: 4_395_000_000 },
  { symbol: 'UNH', name: '유나이티드헬스 (UnitedHealth)', group: '🇺🇸 미국', shares: 920_000_000 },
  { symbol: 'MA', name: '마스터카드 (Mastercard)', group: '🇺🇸 미국', shares: 920_000_000 },
  { symbol: 'PG', name: '프록터&갬블 (P&G)', group: '🇺🇸 미국', shares: 2_353_000_000 },
  { symbol: 'ORCL', name: '오라클 (Oracle)', group: '🇺🇸 미국', shares: 2_778_000_000 },
  { symbol: 'JNJ', name: '존슨앤존슨 (J&J)', group: '🇺🇸 미국', shares: 2_405_000_000 },
  { symbol: 'HD', name: '홈디포 (Home Depot)', group: '🇺🇸 미국', shares: 993_000_000 },
  { symbol: 'COST', name: '코스트코 (Costco)', group: '🇺🇸 미국', shares: 443_000_000 },
  { symbol: 'ABBV', name: '애브비 (AbbVie)', group: '🇺🇸 미국', shares: 1_766_000_000 },
  { symbol: 'CVX', name: '셰브론 (Chevron)', group: '🇺🇸 미국', shares: 1_798_000_000 },
  { symbol: 'BAC', name: '뱅크오브아메리카 (BoA)', group: '🇺🇸 미국', shares: 7_630_000_000 },
  { symbol: 'KO', name: '코카콜라 (Coca-Cola)', group: '🇺🇸 미국', shares: 4_308_000_000 },
  { symbol: 'AVGO', name: '브로드컴 (Broadcom)', group: '🇺🇸 미국', shares: 4_680_000_000 },
  { symbol: 'NFLX', name: '넷플릭스 (Netflix)', group: '🇺🇸 미국', shares: 430_000_000 },
  { symbol: 'TMUS', name: 'T-모바일 US', group: '🇺🇸 미국', shares: 1_164_000_000 },
  { symbol: 'CRM', name: '세일즈포스 (Salesforce)', group: '🇺🇸 미국', shares: 960_000_000 },
  { symbol: 'AMD', name: 'AMD (어드밴스드 마이크로 디바이시스)', group: '🇺🇸 미국', shares: 1_620_000_000 },
  { symbol: 'PEP', name: '펩시코 (PepsiCo)', group: '🇺🇸 미국', shares: 1_369_000_000 },
];

const GROUP_META: Record<string, string> = {
  '🇨🇳 상해':   '09:30~15:00 CST (KST 10:30~16:00) · 상하이증권거래소',
  '🇨🇳 심천':   '09:30~15:00 CST (KST 10:30~16:00) · 심천증권거래소',
  '🇨🇳 과창판': '09:30~15:00 CST (KST 10:30~16:00) · STAR Market (커촹반)',
  '🇨🇳 창업판': '09:30~15:00 CST (KST 10:30~16:00) · ChiNext (창업판)',
  '🇭🇰 홍콩': '09:30~16:00 HKT (KST 10:30~17:00)',
  '🇮🇳 인도': '09:15~15:30 IST (KST 12:45~19:00)',
  '🇹🇼 대만': '09:00~13:30 TWT (KST 10:00~14:30)',
  '🇯🇵 일본': '09:00~11:30, 12:30~15:00 JST (KST 동일)',
  '🇺🇸 미국': '09:30~16:00 ET (KST 22:30~05:00, 서머타임)',
};

const CURRENCY_BY_GROUP: Record<string, string> = {
  '🇨🇳 상해':   'CNY',
  '🇨🇳 심천':   'CNY',
  '🇨🇳 과창판': 'CNY',
  '🇨🇳 창업판': 'CNY',
  '🇭🇰 홍콩': 'HKD',
  '🇮🇳 인도': 'INR',
  '🇹🇼 대만': 'TWD',
  '🇯🇵 일본': 'JPY',
  '🇺🇸 미국': 'USD',
};

// 시장 필터: URL 파라미터 → 그룹 매핑
const MARKET_TO_GROUP: Record<string, string> = {
  'cn_sh':     '🇨🇳 상해',
  'cn_sz':     '🇨🇳 심천',
  'cn_star':   '🇨🇳 과창판',
  'cn_chinext':'🇨🇳 창업판',
  'hk': '🇭🇰 홍콩',
  'in': '🇮🇳 인도',
  'tw': '🇹🇼 대만',
  'jp': '🇯🇵 일본',
  'us': '🇺🇸 미국',
};

// 5분 캐시 (시장별)
const _cache: Record<string, { data: any; at: number }> = {};
const CACHE_TTL_MS = 5 * 60 * 1000;

// FX rates 조회 (XXX/KRW)
let _fxCache: { rates: Record<string, number>; at: number } | null = null;
async function getFxRates(): Promise<Record<string, number>> {
  if (_fxCache && Date.now() - _fxCache.at < CACHE_TTL_MS) return _fxCache.rates;

  const rates: Record<string, number> = { CNY: 0, HKD: 0, INR: 0, TWD: 0, JPY: 0, USD: 0 };
  try {
    const [cny, hkd, inr, twd, jpy, usdKrw] = await Promise.all([
      getQuote('CNYKRW=X').catch(() => null),
      getQuote('HKDKRW=X').catch(() => null),
      getQuote('INRKRW=X').catch(() => null),
      getQuote('TWDKRW=X').catch(() => null),
      getQuote('JPYKRW=X').catch(() => null),
      getQuote('USDKRW=X').catch(() => null),
    ]);
    if (cny?.regularMarketPrice) rates.CNY = cny.regularMarketPrice;
    if (hkd?.regularMarketPrice) rates.HKD = hkd.regularMarketPrice;
    if (inr?.regularMarketPrice) rates.INR = inr.regularMarketPrice;
    if (twd?.regularMarketPrice) rates.TWD = twd.regularMarketPrice;
    if (jpy?.regularMarketPrice) rates.JPY = jpy.regularMarketPrice;
    if (usdKrw?.regularMarketPrice) rates.USD = usdKrw.regularMarketPrice;

    // Fallback: USD/KRW 크로스
    if (usdKrw?.regularMarketPrice) {
      const usdKrwRate = usdKrw.regularMarketPrice;
      const crosses = await Promise.all([
        !rates.CNY ? getQuote('USDCNY=X').catch(() => null) : null,
        !rates.HKD ? getQuote('USDHKD=X').catch(() => null) : null,
        !rates.INR ? getQuote('USDINR=X').catch(() => null) : null,
        !rates.TWD ? getQuote('USDTWD=X').catch(() => null) : null,
        !rates.JPY ? getQuote('USDJPY=X').catch(() => null) : null,
      ]);
      if (!rates.CNY && crosses[0]?.regularMarketPrice) rates.CNY = usdKrwRate / crosses[0].regularMarketPrice;
      if (!rates.HKD && crosses[1]?.regularMarketPrice) rates.HKD = usdKrwRate / crosses[1].regularMarketPrice;
      if (!rates.INR && crosses[2]?.regularMarketPrice) rates.INR = usdKrwRate / crosses[2].regularMarketPrice;
      if (!rates.TWD && crosses[3]?.regularMarketPrice) rates.TWD = usdKrwRate / crosses[3].regularMarketPrice;
      if (!rates.JPY && crosses[4]?.regularMarketPrice) rates.JPY = usdKrwRate / crosses[4].regularMarketPrice;
    }
    _fxCache = { rates, at: Date.now() };
  } catch (e: any) {
    console.error('FX rates error:', e.message);
  }
  return rates;
}

router.get('/', async (req: Request, res: Response) => {
  try {
    const market = (req.query.market as string || 'cn').toLowerCase();
    const targetGroup = MARKET_TO_GROUP[market];
    if (!targetGroup) return res.status(400).json({ error: 'Invalid market. Use: cn_sh, cn_sz, cn_star, cn_chinext, hk, in, tw, jp, us' });

    const cacheKey = market;
    if (_cache[cacheKey] && Date.now() - _cache[cacheKey].at < CACHE_TTL_MS) {
      return res.json(_cache[cacheKey].data);
    }

    // 해당 시장 후보만 필터
    const marketCandidates = CANDIDATES.filter(c => c.group === targetGroup);

    const fx = await getFxRates();

    // === Pass 1: 현재가만 빠르게 조회 ===
    console.log(`[stocks] ${market}: Pass 1 quoting ${marketCandidates.length} candidates`);
    const quotes = await Promise.all(
      marketCandidates.map(c => getQuote(c.symbol).catch((): any => null))
    );

    // 시총 계산 + 내림차순 정렬 → TOP 10
    const ranked = marketCandidates.map((c, i) => ({
      ...c,
      price: quotes[i]?.regularMarketPrice || 0,
      marketCapLocal: (quotes[i]?.regularMarketPrice || 0) * c.shares,
      _quoteIdx: i,
    })).filter(c => c.price > 0);

    ranked.sort((a, b) => b.marketCapLocal - a.marketCapLocal);
    const top10 = ranked.slice(0, 10);
    console.log(`[stocks] ${market}: Pass 1 done, ${top10.length} top stocks`);

    // === Pass 2: TOP 10만 전체 차트 + PE 조회 ===
    const results = await Promise.all(
      top10.map(async (c) => {
        try {
          const [chart10d, chartYtd, chart1mo, chart3mo, chart6mo, chart1y, chart3y, chart5y, pe] = await Promise.all([
            getChart(c.symbol, '10d', '1d'),
            getChart(c.symbol, 'ytd', '1d'),
            getChart(c.symbol, '1mo', '1d'),
            getChart(c.symbol, '3mo', '1d'),
            getChart(c.symbol, '6mo', '1d'),
            getChart(c.symbol, '1y', '1d'),
            getChart(c.symbol, '3y', '1wk'),
            getChart(c.symbol, '5y', '1wk'),
            getYahooPE(c.symbol),
          ]);

          const quote = quotes[c._quoteIdx];
          if (!quote) return null;

          const isOpen = quote.marketState === 'REGULAR';
          const closePrice = quote.regularMarketPrice;
          const quotePrevClose = (quote as any).prevClose ?? (quote as any).regularMarketPreviousClose;

          const filterChart = (d: any[]) => d.filter(e => e && e.close && !isNaN(e.close));
          const closedChart = filterChart(chart10d);
          const closes = closedChart.map(d => d.close);

          let ret1D: number | null = null;
          if (closePrice && quotePrevClose && Math.abs(quotePrevClose) > 0.0001) {
            ret1D = ((closePrice - quotePrevClose) / quotePrevClose) * 100;
          }

          const close5dAgo = closes.length >= 5 ? closes[closes.length - 5] : (closes.length >= 2 ? closes[0] : null);
          const ret1W = (closePrice && close5dAgo) ? ((closePrice - close5dAgo) / close5dAgo) * 100 : null;

          function calcReturn(chartData: any[], useOpen?: boolean): number | null {
            const f = filterChart(chartData);
            if (f.length < 1) return null;
            const first = useOpen ? (f[0].open || f[0].close) : f[0].close;
            if (!first) return null;
            return ((closePrice - first) / first) * 100;
          }
          function annualized(chartData: any[], years: number): number | null {
            const t = calcReturn(chartData);
            if (t === null) return null;
            return t / years;
          }

          const returns: Record<string, number | null> = {
            '1D': ret1D,
            '1W': ret1W,
            'YTD': calcReturn(chartYtd, true),
            '1M': calcReturn(chart1mo),
            '3M': calcReturn(chart3mo),
            '6M': calcReturn(chart6mo),
            '1Y': calcReturn(chart1y),
            '3Y/A': annualized(chart3y, 3),
            '5Y/A': annualized(chart5y, 5),
            '10Y/A': null,
          };

          let lastCloseDate: string | null = null;
          if (!isOpen && quote.regularMarketTime) {
            const rmt = new Date(quote.regularMarketTime * 1000);
            const localTz = quote.timezone || 'UTC';
            lastCloseDate = rmt.toLocaleDateString('en-CA', { timeZone: localTz });
          } else if (isOpen && closedChart.length >= 1) {
            lastCloseDate = closedChart[closedChart.length - 1].time;
          }

          const currency = CURRENCY_BY_GROUP[c.group] || 'USD';
          const fxRate = fx[currency] || 0;
          const marketCapKrw = fxRate > 0 ? c.marketCapLocal * fxRate : 0;

          return {
            symbol: c.symbol,
            name: c.name,
            group: c.group,
            type: 'stock',
            marketCapLocal: c.marketCapLocal,
            marketCapKrw,
            marketCapCurrency: currency,
            trailingPE: pe.trailingPE,
            forwardPE: pe.forwardPE,
            eps: pe.eps,
            epsForward: pe.epsForward,
            livePrice: isOpen ? closePrice : null,
            closePrice,
            realtime: null,
            realtimePrevClose: null,
            realtimeKST: null,
            realtimeLocal: null,
            tzShort: quote.tzShort || '',
            closeBase: lastCloseDate,
            closeBaseAdj: lastCloseDate,
            closeLocalTime: null,
            closeKST: lastCloseDate ? lastCloseDate.slice(5) : null,
            closeTzShort: quote.tzShort || '',
            prevBase: closedChart.length >= 2 ? closedChart[closedChart.length - 2].time : null,
            weekBase: closedChart.length >= 5 ? closedChart[closedChart.length - 5].time : null,
            marketState: quote.marketState,
            returns,
          };
        } catch (e: any) {
          console.error(`[stocks] ${c.symbol} error:`, e.message);
          return null;
        }
      })
    );

    const items = results.filter(r => r !== null);
    const data = { items, groupMeta: GROUP_META, market };
    _cache[cacheKey] = { data, at: Date.now() };
    res.json(data);
  } catch (err: any) {
    console.error('Stocks error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

export default router;
