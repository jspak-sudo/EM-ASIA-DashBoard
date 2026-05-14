export interface Quote {
  symbol: string;
  shortName: string;
  longName: string;
  regularMarketPrice: number;
  regularMarketChange: number;
  regularMarketChangePercent: number;
  currency: string;
  fiftyTwoWeekHigh: number | null;
  fiftyTwoWeekLow: number | null;
}

export interface ChartDataPoint {
  time: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface FinancialData {
  year: string;
  revenue: number | null;
  revenueYoY: number | null;
  netIncome: number | null;
  netIncomeYoY: number | null;
  eps: number | null;
  epsYoY: number | null;
  isEstimate?: boolean;
}

export interface MacroIndicator {
  name: string;
  symbol: string;
  value: number;
  change: number;
  changePercent: number;
  data: { time: string; value: number }[];
}

export interface CorrelationResult {
  symbol1: string;
  symbol2: string;
  correlation: number;
  data1: { time: string; value: number }[];
  data2: { time: string; value: number }[];
}

export type Period = '1W' | 'YTD' | '1M' | '3M' | '1Y' | '3Y' | '5Y' | 'ALL';

export type MAType = 'MA5' | 'EMA21' | 'MA50' | 'MA60' | 'MA120' | 'MA200';
