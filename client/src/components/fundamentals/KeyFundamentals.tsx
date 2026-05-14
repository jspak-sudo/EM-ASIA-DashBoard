import Card from '../common/Card';
import type { Quote, ChartDataPoint } from '../../types/stock';
import { formatPrice } from '../../utils/format';

interface Props {
  quote: Quote;
  chartData?: ChartDataPoint[];
}

export default function KeyFundamentals({ quote, chartData }: Props) {
  // Calculate performance from chart data
  const perfData = chartData && chartData.length > 0 ? calcPerformance(chartData) : null;

  return (
    <div className="mt-6">
      <h2 className="text-sm font-bold text-gray-900 mb-3">
        핵심 지표 <span className="text-gray-400 font-normal text-xs ml-1">{quote.currency}</span>
      </h2>
      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        {/* 52주 범위 */}
        <Card>
          <p className="text-xs text-gray-500 mb-2">52주 범위</p>
          <div className="space-y-2">
            <div className="flex justify-between text-sm">
              <span className="text-gray-500">최저</span>
              <span className="font-bold text-red-500">
                ${quote.fiftyTwoWeekLow ? formatPrice(quote.fiftyTwoWeekLow) : 'N/A'}
              </span>
            </div>
            <div className="w-full bg-gray-100 rounded-full h-2">
              {quote.fiftyTwoWeekLow && quote.fiftyTwoWeekHigh && (
                <div
                  className="bg-blue-500 h-2 rounded-full relative"
                  style={{
                    width: `${((quote.regularMarketPrice - quote.fiftyTwoWeekLow) / (quote.fiftyTwoWeekHigh - quote.fiftyTwoWeekLow)) * 100}%`
                  }}
                >
                  <div className="absolute right-0 top-1/2 -translate-y-1/2 w-3 h-3 bg-blue-600 rounded-full border-2 border-white" />
                </div>
              )}
            </div>
            <div className="flex justify-between text-sm">
              <span className="text-gray-500">최고</span>
              <span className="font-bold text-emerald-500">
                ${quote.fiftyTwoWeekHigh ? formatPrice(quote.fiftyTwoWeekHigh) : 'N/A'}
              </span>
            </div>
          </div>
        </Card>

        {/* 기간별 수익률 */}
        <Card>
          <p className="text-xs text-gray-500 mb-3">기간별 수익률</p>
          <div className="grid grid-cols-2 gap-2">
            {perfData ? (
              <>
                <PerfBadge label="1개월" value={perfData.m1} />
                <PerfBadge label="3개월" value={perfData.m3} />
                <PerfBadge label="6개월" value={perfData.m6} />
                <PerfBadge label="1년" value={perfData.y1} />
              </>
            ) : (
              [1,2,3,4].map((i) => (
                <div key={i} className="rounded-lg py-2 px-3 text-center bg-gray-50">
                  <p className="text-xs text-gray-400">-</p>
                </div>
              ))
            )}
          </div>
        </Card>

        {/* 가격 정보 */}
        <Card>
          <p className="text-xs text-gray-500 mb-3">가격 정보</p>
          <div className="space-y-2.5">
            <div className="flex justify-between items-center">
              <span className="text-sm text-gray-600">현재가</span>
              <span className="text-sm font-bold text-gray-900">
                ${formatPrice(quote.regularMarketPrice)}
              </span>
            </div>
            <div className="flex justify-between items-center">
              <span className="text-sm text-gray-600">일일 변동</span>
              <span className={`text-sm font-bold ${quote.regularMarketChange >= 0 ? 'text-emerald-500' : 'text-red-500'}`}>
                {quote.regularMarketChange >= 0 ? '+' : ''}{quote.regularMarketChange.toFixed(2)}
                ({quote.regularMarketChangePercent >= 0 ? '+' : ''}{quote.regularMarketChangePercent.toFixed(2)}%)
              </span>
            </div>
            <div className="flex justify-between items-center">
              <span className="text-sm text-gray-600">통화</span>
              <span className="text-sm font-bold text-gray-900">{quote.currency}</span>
            </div>
          </div>
        </Card>
      </div>
    </div>
  );
}

function PerfBadge({ label, value }: { label: string; value: number | null }) {
  if (value === null) {
    return (
      <div className="rounded-lg py-2 px-3 text-center bg-gray-50">
        <p className="text-xs text-gray-400 mb-0.5">{label}</p>
        <p className="text-sm font-semibold text-gray-500">-</p>
      </div>
    );
  }
  const isUp = value >= 0;
  return (
    <div className={`rounded-lg py-2 px-3 text-center ${isUp ? 'bg-emerald-50' : 'bg-red-50'}`}>
      <p className="text-xs text-gray-400 mb-0.5">{label}</p>
      <p className={`text-sm font-semibold ${isUp ? 'text-emerald-600' : 'text-red-600'}`}>
        {isUp ? '+' : ''}{value.toFixed(2)}%
      </p>
    </div>
  );
}

function calcPerformance(data: ChartDataPoint[]) {
  if (data.length === 0) return null;

  const latest = data[data.length - 1].close;

  function getReturn(daysAgo: number): number | null {
    const targetIdx = Math.max(0, data.length - daysAgo);
    if (targetIdx >= data.length) return null;
    const base = data[targetIdx].close;
    return base ? ((latest - base) / base) * 100 : null;
  }

  return {
    m1: getReturn(21),
    m3: getReturn(63),
    m6: getReturn(126),
    y1: getReturn(252),
  };
}
