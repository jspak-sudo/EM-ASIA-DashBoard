import axios from 'axios';
import type { Quote, ChartDataPoint, FinancialData, CorrelationResult, MacroIndicator, Period } from '../types/stock';

const api = axios.create({
  baseURL: '/api',
  timeout: 15000,
});

export async function fetchQuote(symbol: string): Promise<Quote> {
  const { data } = await api.get(`/quote/${symbol}`);
  return data;
}

export async function fetchChart(symbol: string, period: Period): Promise<ChartDataPoint[]> {
  const { data } = await api.get(`/chart/${symbol}`, { params: { period } });
  return data;
}

export async function fetchFinancials(symbol: string): Promise<FinancialData[]> {
  const { data } = await api.get(`/financials/${symbol}`);
  return data;
}

export async function fetchCorrelation(symbol1: string, symbol2: string, period: Period): Promise<CorrelationResult> {
  const { data } = await api.get('/correlation', { params: { symbol1, symbol2, period } });
  return data;
}

export async function fetchMacro(): Promise<MacroIndicator[]> {
  const { data } = await api.get('/macro');
  return data;
}

export async function searchSymbols(query: string): Promise<{ symbol: string; name: string }[]> {
  const { data } = await api.get('/search', { params: { q: query } });
  return data;
}
