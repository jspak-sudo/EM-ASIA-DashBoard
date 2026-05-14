import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts';
import { useMacro } from '../hooks/useStockData';
import Card from '../components/common/Card';
import Loader from '../components/common/Loader';
import { TrendingUp, TrendingDown } from 'lucide-react';

const INDICATOR_COLORS = ['#3B82F6', '#10B981', '#F97316', '#EF4444', '#8B5CF6', '#EC4899'];

export default function MacroPage() {
  const { data: indicators, isLoading } = useMacro();

  if (isLoading) return <Loader />;
  if (!indicators || indicators.length === 0) {
    return <div className="text-center py-20 text-gray-400">매크로 데이터를 불러올 수 없습니다</div>;
  }

  return (
    <div className="px-4 pb-6">
      <h2 className="text-lg font-bold text-gray-900 py-4">매크로 경제 지표</h2>

      {/* Summary Cards */}
      <div className="grid grid-cols-2 md:grid-cols-3 gap-3 mb-6">
        {indicators.map((ind) => {
          const isUp = ind.change >= 0;
          return (
            <Card key={ind.symbol}>
              <p className="text-xs text-gray-500 mb-1">{ind.name}</p>
              <p className="text-lg font-bold text-gray-900">
                {ind.value.toLocaleString('en-US', { maximumFractionDigits: 2 })}
              </p>
              <span className={`flex items-center gap-0.5 text-xs font-medium ${isUp ? 'text-emerald-500' : 'text-red-500'}`}>
                {isUp ? <TrendingUp className="w-3 h-3" /> : <TrendingDown className="w-3 h-3" />}
                {isUp ? '+' : ''}{ind.changePercent.toFixed(2)}%
              </span>
            </Card>
          );
        })}
      </div>

      {/* Individual Charts */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {indicators.map((ind, i) => (
          <Card key={ind.symbol}>
            <div className="flex justify-between items-center mb-3">
              <p className="text-sm font-bold text-gray-900">{ind.name}</p>
              <span className="text-xs text-gray-400">{ind.symbol}</span>
            </div>
            <ResponsiveContainer width="100%" height={200}>
              <LineChart data={ind.data}>
                <CartesianGrid strokeDasharray="3 3" stroke="#f3f4f6" />
                <XAxis
                  dataKey="time"
                  tick={{ fontSize: 10, fill: '#9ca3af' }}
                  tickFormatter={(t) => t.slice(5)}
                />
                <YAxis tick={{ fontSize: 10, fill: '#9ca3af' }} domain={['auto', 'auto']} />
                <Tooltip />
                <Line
                  type="monotone"
                  dataKey="value"
                  stroke={INDICATOR_COLORS[i % INDICATOR_COLORS.length]}
                  dot={false}
                  strokeWidth={2}
                />
              </LineChart>
            </ResponsiveContainer>
          </Card>
        ))}
      </div>
    </div>
  );
}
