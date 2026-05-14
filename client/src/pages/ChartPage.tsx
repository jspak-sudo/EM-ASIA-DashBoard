import { useState } from 'react';
import { TrendingUp, TrendingDown } from 'lucide-react';
import CandlestickChart from '../components/chart/CandlestickChart';
import PeriodSelector from '../components/chart/PeriodSelector';
import MAToggle from '../components/chart/MAToggle';
import KeyFundamentals from '../components/fundamentals/KeyFundamentals';
import FinancialTable from '../components/fundamentals/FinancialTable';
import Loader from '../components/common/Loader';
import { useQuote, useChart, useFinancials } from '../hooks/useStockData';
import { formatPrice, formatPercent } from '../utils/format';
import type { Period, MAType } from '../types/stock';

interface Props {
  symbol: string;
}

export default function ChartPage({ symbol }: Props) {
  const [period, setPeriod] = useState<Period>('1Y');
  const [activeMAs, setActiveMAs] = useState<MAType[]>(['MA5', 'EMA21', 'MA50', 'MA200']);

  const { data: quote, isLoading: quoteLoading } = useQuote(symbol);
  const { data: chartData, isLoading: chartLoading } = useChart(symbol, period);
  const { data: financials } = useFinancials(symbol);

  function toggleMA(ma: MAType) {
    setActiveMAs((prev) =>
      prev.includes(ma) ? prev.filter((m) => m !== ma) : [...prev, ma]
    );
  }

  if (quoteLoading) return <Loader />;
  if (!quote) return <div className="text-center py-20 text-gray-400">종목을 검색해주세요</div>;

  const isUp = quote.regularMarketChange >= 0;

  return (
    <div className="px-4 pb-6">
      {/* Stock Info Header */}
      <div className="py-4">
        <div className="flex items-center gap-2">
          <h2 className="text-xl font-bold text-gray-900">{quote.longName || quote.shortName}</h2>
          <span className="px-2 py-0.5 bg-gray-100 rounded text-xs text-gray-500 font-medium">
            {quote.symbol}
          </span>
        </div>
        <div className="flex items-baseline gap-3 mt-1">
          <span className="text-3xl font-bold text-gray-900">
            ${formatPrice(quote.regularMarketPrice)}
          </span>
          <span className={`flex items-center gap-1 text-sm font-medium ${isUp ? 'text-emerald-500' : 'text-red-500'}`}>
            {isUp ? <TrendingUp className="w-4 h-4" /> : <TrendingDown className="w-4 h-4" />}
            {isUp ? '+' : ''}{quote.regularMarketChange.toFixed(2)} ({formatPercent(quote.regularMarketChangePercent)})
          </span>
        </div>
      </div>

      {/* Period & MA Controls */}
      <div className="flex flex-wrap items-center justify-between gap-3 mb-2">
        <PeriodSelector selected={period} onChange={setPeriod} />
        <MAToggle activeMAs={activeMAs} onToggle={toggleMA} />
      </div>

      {/* Chart */}
      <div className="bg-white border border-gray-200 rounded-lg overflow-hidden">
        {chartLoading ? (
          <Loader />
        ) : chartData && chartData.length > 0 ? (
          <CandlestickChart data={chartData} activeMAs={activeMAs} />
        ) : (
          <div className="h-[450px] flex items-center justify-center text-gray-400">
            차트 데이터를 불러올 수 없습니다
          </div>
        )}
      </div>

      {/* Key Fundamentals */}
      <KeyFundamentals quote={quote} chartData={chartData} />

      {/* Financial Table */}
      {financials && <FinancialTable data={financials} />}
    </div>
  );
}
