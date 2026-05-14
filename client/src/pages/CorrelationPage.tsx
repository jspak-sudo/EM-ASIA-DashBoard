import { useState } from 'react';
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend } from 'recharts';
import { useCorrelation } from '../hooks/useStockData';
import PeriodSelector from '../components/chart/PeriodSelector';
import Card from '../components/common/Card';
import Loader from '../components/common/Loader';
import type { Period } from '../types/stock';

export default function CorrelationPage() {
  const [symbol1, setSymbol1] = useState('AAPL');
  const [symbol2, setSymbol2] = useState('MSFT');
  const [period, setPeriod] = useState<Period>('1Y');
  const [input1, setInput1] = useState('AAPL');
  const [input2, setInput2] = useState('MSFT');

  const { data, isLoading } = useCorrelation(symbol1, symbol2, period);

  function handleCompare() {
    setSymbol1(input1.toUpperCase());
    setSymbol2(input2.toUpperCase());
  }

  return (
    <div className="px-4 pb-6">
      <h2 className="text-lg font-bold text-gray-900 py-4">상관관계 분석</h2>

      {/* Input Section */}
      <Card className="mb-4">
        <div className="flex flex-wrap items-end gap-3">
          <div>
            <label className="block text-xs text-gray-500 mb-1">종목 1</label>
            <input
              type="text"
              value={input1}
              onChange={(e) => setInput1(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleCompare()}
              className="border border-gray-200 rounded-lg px-3 py-2 text-sm w-32 outline-none focus:border-blue-400"
            />
          </div>
          <div>
            <label className="block text-xs text-gray-500 mb-1">종목 2</label>
            <input
              type="text"
              value={input2}
              onChange={(e) => setInput2(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleCompare()}
              className="border border-gray-200 rounded-lg px-3 py-2 text-sm w-32 outline-none focus:border-blue-400"
            />
          </div>
          <button
            onClick={handleCompare}
            className="px-4 py-2 bg-blue-500 text-white text-sm rounded-lg hover:bg-blue-600"
          >
            비교
          </button>
        </div>
        <div className="mt-3">
          <PeriodSelector selected={period} onChange={setPeriod} />
        </div>
      </Card>

      {isLoading ? (
        <Loader />
      ) : data ? (
        <>
          {/* Correlation Coefficient */}
          <Card className="mb-4">
            <div className="text-center">
              <p className="text-xs text-gray-500 mb-1">상관계수</p>
              <p className={`text-4xl font-bold ${
                data.correlation >= 0.7 ? 'text-emerald-500' :
                data.correlation >= 0.3 ? 'text-yellow-500' :
                data.correlation >= -0.3 ? 'text-gray-500' :
                'text-red-500'
              }`}>
                {data.correlation.toFixed(4)}
              </p>
              <p className="text-xs text-gray-400 mt-1">
                {data.correlation >= 0.7 ? '강한 양의 상관관계' :
                 data.correlation >= 0.3 ? '약한 양의 상관관계' :
                 data.correlation >= -0.3 ? '상관관계 없음' :
                 data.correlation >= -0.7 ? '약한 음의 상관관계' :
                 '강한 음의 상관관계'}
              </p>
            </div>
          </Card>

          {/* Normalized Price Chart */}
          <Card>
            <p className="text-xs text-gray-500 mb-3">정규화 가격 비교</p>
            <ResponsiveContainer width="100%" height={350}>
              <LineChart>
                <CartesianGrid strokeDasharray="3 3" stroke="#f3f4f6" />
                <XAxis
                  dataKey="time"
                  data={data.data1}
                  tick={{ fontSize: 11, fill: '#9ca3af' }}
                  tickFormatter={(t) => t.slice(5)}
                />
                <YAxis tick={{ fontSize: 11, fill: '#9ca3af' }} />
                <Tooltip />
                <Legend />
                <Line
                  data={data.data1}
                  type="monotone"
                  dataKey="value"
                  name={symbol1}
                  stroke="#3B82F6"
                  dot={false}
                  strokeWidth={2}
                />
                <Line
                  data={data.data2}
                  type="monotone"
                  dataKey="value"
                  name={symbol2}
                  stroke="#F97316"
                  dot={false}
                  strokeWidth={2}
                />
              </LineChart>
            </ResponsiveContainer>
          </Card>
        </>
      ) : (
        <div className="text-center py-20 text-gray-400">두 종목을 입력하고 비교를 클릭하세요</div>
      )}
    </div>
  );
}
