import { useEffect, useRef } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  createChart,
  LineSeries,
  ColorType,
  type IChartApi,
} from 'lightweight-charts';
import { TrendingUp, TrendingDown, RefreshCw } from 'lucide-react';
import axios from 'axios';
import Loader from '../components/common/Loader';
import { formatPrice } from '../utils/format';

interface IntradayIndex {
  symbol: string;
  name: string;
  price: number;
  change: number;
  changePercent: number;
  prevClose: number;
  currency: string;
  intradayData: { time: string; value: number }[];
}

function useIntraday() {
  return useQuery({
    queryKey: ['intraday'],
    queryFn: async (): Promise<IntradayIndex[]> => {
      const { data } = await axios.get('/api/intraday');
      return data;
    },
    refetchInterval: 30000,
  });
}

function parseTime(t: string): number {
  return Number(t);
}

function MiniChart({ data, color, prevClose }: { data: { time: string; value: number }[]; color: string; prevClose: number }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);

  useEffect(() => {
    if (!containerRef.current || data.length === 0) return;

    if (chartRef.current) {
      chartRef.current.remove();
    }

    const chart = createChart(containerRef.current, {
      layout: {
        background: { type: ColorType.Solid, color: '#ffffff' },
        textColor: '#9ca3af',
        fontSize: 10,
      },
      grid: {
        vertLines: { visible: false },
        horzLines: { color: '#f3f4f6', style: 2 },
      },
      width: containerRef.current.clientWidth,
      height: 200,
      rightPriceScale: { borderVisible: false, scaleMargins: { top: 0.05, bottom: 0.05 } },
      timeScale: { borderVisible: false, timeVisible: true, secondsVisible: false },
      crosshair: { mode: 0 },
    });
    chartRef.current = chart;

    const lineSeries = chart.addSeries(LineSeries, {
      color,
      lineWidth: 2,
      priceLineVisible: false,
      lastValueVisible: false,
      crosshairMarkerVisible: true,
    });
    lineSeries.setData(data.map((d) => ({ time: parseTime(d.time) as any, value: d.value })));

    if (prevClose > 0) {
      lineSeries.createPriceLine({
        price: prevClose,
        color: '#9ca3af',
        lineWidth: 1,
        lineStyle: 2,
        axisLabelVisible: true,
        title: '전일종가',
      });
    }

    chart.timeScale().fitContent();

    const ro = new ResizeObserver((entries) => {
      for (const e of entries) chart.applyOptions({ width: e.contentRect.width });
    });
    ro.observe(containerRef.current);

    return () => {
      ro.disconnect();
      chart.remove();
      chartRef.current = null;
    };
  }, [data, color, prevClose]);

  return <div ref={containerRef} className="w-full h-[200px]" />;
}

const COLORS = [
  '#3B82F6', '#8B5CF6', '#F59E0B', '#10B981',
  '#EF4444', '#EC4899', '#6366F1', '#F97316',
  '#14B8A6', '#8B5CF6',
];

export default function IntradayPage() {
  const { data: indices, isLoading, dataUpdatedAt } = useIntraday();

  if (isLoading) return <Loader />;
  if (!indices) return null;

  const lastUpdate = new Date(dataUpdatedAt);
  const timeStr = lastUpdate.toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });

  const openMarkets = indices.filter((idx: any) => idx.marketState === 'OPEN' || idx.marketState === 'PRE' || idx.marketState === 'POST');
  const closedMarkets = indices.filter((idx: any) => idx.marketState === 'CLOSED' || (!idx.marketState));

  return (
    <div className="px-4 pb-6">
      {/* Header */}
      <div className="flex items-center justify-between py-4">
        <h2 className="text-lg font-bold text-gray-900">실시간 현황</h2>
        <div className="flex items-center gap-1.5 text-xs text-gray-400">
          <RefreshCw className="w-3 h-3 animate-spin" style={{ animationDuration: '3s' }} />
          <span>30초 갱신 | {timeStr}</span>
        </div>
      </div>

      {/* Open Markets */}
      {openMarkets.length > 0 ? (
        <>
          <div className="flex items-center gap-2 mb-3">
            <span className="w-2 h-2 bg-green-500 rounded-full animate-pulse" />
            <h3 className="text-sm font-bold text-gray-900">개장 중</h3>
            <span className="text-xs text-gray-400">{openMarkets.length}개 시장</span>
          </div>

          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-2 mb-4">
            {openMarkets.map((idx: any, i: number) => {
              const isUp = idx.change >= 0;
              const ci = indices.indexOf(idx);
              return (
                <div key={idx.symbol}
                  className={`rounded-lg p-3 border ${isUp ? 'bg-emerald-50/50 border-emerald-100' : 'bg-red-50/50 border-red-100'}`}
                >
                  <div className="flex items-center gap-1.5 mb-1">
                    <span className="w-2 h-2 rounded-full" style={{ backgroundColor: COLORS[ci % COLORS.length] }} />
                    <p className="text-xs font-medium text-gray-600 truncate">{idx.name}</p>
                  </div>
                  <p className="text-base font-bold text-gray-900">{formatPrice(idx.price)}</p>
                  <div className={`flex items-center gap-1 text-xs font-semibold mt-0.5 ${isUp ? 'text-emerald-600' : 'text-red-600'}`}>
                    {isUp ? <TrendingUp className="w-3 h-3" /> : <TrendingDown className="w-3 h-3" />}
                    <span>{isUp ? '+' : ''}{idx.changePercent.toFixed(2)}%</span>
                  </div>
                  <p className="text-[10px] text-gray-400 mt-1">{idx.exchangeName}</p>
                </div>
              );
            })}
          </div>

          <div className="space-y-4 mb-6">
            {openMarkets.map((idx: any) => {
              const isUp = idx.change >= 0;
              const ci = indices.indexOf(idx);
              const color = COLORS[ci % COLORS.length];
              return (
                <div key={idx.symbol} className="bg-white border border-gray-200 rounded-lg p-3">
                  <div className="flex items-center justify-between mb-1">
                    <div className="flex items-center gap-2">
                      <span className="w-2 h-2 bg-green-500 rounded-full animate-pulse" />
                      <span className="text-sm font-bold text-gray-900">{idx.name}</span>
                      <span className="text-[10px] text-gray-400">{idx.exchangeName}</span>
                    </div>
                    <div className="text-right">
                      <span className="text-sm font-bold text-gray-900">{formatPrice(idx.price)}</span>
                      <span className={`ml-2 text-xs font-semibold ${isUp ? 'text-emerald-500' : 'text-red-500'}`}>
                        {isUp ? '+' : ''}{idx.changePercent.toFixed(2)}%
                      </span>
                    </div>
                  </div>
                  {idx.intradayData.length > 0 ? (
                    <MiniChart data={idx.intradayData} color={color} prevClose={idx.prevClose} />
                  ) : (
                    <div className="h-[200px] flex items-center justify-center text-xs text-gray-400">
                      데이터 로딩 중...
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </>
      ) : (
        <div className="bg-gray-50 rounded-lg p-8 text-center mb-6">
          <p className="text-gray-400 text-sm">현재 개장 중인 시장이 없습니다</p>
          <p className="text-gray-300 text-xs mt-1">장 시작 시 자동으로 표시됩니다</p>
        </div>
      )}

      {/* Closed Markets Summary */}
      {closedMarkets.length > 0 && (
        <>
          <div className="flex items-center gap-2 mb-3">
            <span className="w-2 h-2 bg-gray-300 rounded-full" />
            <h3 className="text-sm font-bold text-gray-500">장 마감</h3>
            <span className="text-xs text-gray-400">{closedMarkets.length}개 시장</span>
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-5 gap-2">
            {closedMarkets.map((idx: any) => {
              const isUp = idx.change >= 0;
              const ci = indices.indexOf(idx);
              return (
                <div key={idx.symbol} className="rounded-lg p-3 border border-gray-100 bg-gray-50/50">
                  <div className="flex items-center gap-1.5 mb-1">
                    <span className="w-2 h-2 rounded-full bg-gray-300" />
                    <p className="text-xs font-medium text-gray-500 truncate">{idx.name}</p>
                  </div>
                  <p className="text-sm font-bold text-gray-700">{formatPrice(idx.price)}</p>
                  <div className={`text-xs font-semibold mt-0.5 ${isUp ? 'text-emerald-400' : 'text-red-400'}`}>
                    {isUp ? '+' : ''}{idx.changePercent.toFixed(2)}%
                  </div>
                  <p className="text-[10px] text-gray-400 mt-0.5">{(idx as any).baseDate} 종가</p>
                </div>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}
