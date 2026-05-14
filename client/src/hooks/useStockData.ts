import { useQuery } from '@tanstack/react-query';
import { fetchQuote, fetchChart, fetchFinancials, fetchCorrelation, fetchMacro, searchSymbols } from '../services/api';
import type { Period } from '../types/stock';

export function useQuote(symbol: string) {
  return useQuery({
    queryKey: ['quote', symbol],
    queryFn: () => fetchQuote(symbol),
    enabled: !!symbol,
    refetchInterval: 30000,
  });
}

export function useChart(symbol: string, period: Period) {
  return useQuery({
    queryKey: ['chart', symbol, period],
    queryFn: () => fetchChart(symbol, period),
    enabled: !!symbol,
  });
}

export function useFinancials(symbol: string) {
  return useQuery({
    queryKey: ['financials', symbol],
    queryFn: () => fetchFinancials(symbol),
    enabled: !!symbol,
  });
}

export function useCorrelation(symbol1: string, symbol2: string, period: Period) {
  return useQuery({
    queryKey: ['correlation', symbol1, symbol2, period],
    queryFn: () => fetchCorrelation(symbol1, symbol2, period),
    enabled: !!symbol1 && !!symbol2,
  });
}

export function useMacro() {
  return useQuery({
    queryKey: ['macro'],
    queryFn: fetchMacro,
    refetchInterval: 60000,
  });
}

export function useSearch(query: string) {
  return useQuery({
    queryKey: ['search', query],
    queryFn: () => searchSymbols(query),
    enabled: query.length >= 1,
  });
}
