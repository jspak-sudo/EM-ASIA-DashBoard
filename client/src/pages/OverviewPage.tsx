import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  createChart,
  LineSeries,
  HistogramSeries,
  ColorType,
  type IChartApi,
} from 'lightweight-charts';
import axios from 'axios';
import Loader from '../components/common/Loader';
import PeriodSelector from '../components/chart/PeriodSelector';
import { formatPrice } from '../utils/format';
import type { Period } from '../types/stock';

interface OverviewIndex {
  symbol: string;
  name: string;
  price: number;
  change: number;
  changePercent: number;
  returns: Record<string, number | null>;
}

const RETURN_COLUMNS = ['1D', '1W', 'YTD', '1M', '3M', '6M', '1Y', '3Y', '5Y'];

function useOverview() {
  return useQuery({
    queryKey: ['overview'],
    queryFn: async (): Promise<OverviewIndex[]> => {
      const { data } = await axios.get('/api/overview');
      return data;
    },
    refetchInterval: 60000,
  });
}

function useIndexChart(symbol: string, period: Period) {
  return useQuery({
    queryKey: ['indexChart', symbol, period],
    queryFn: async () => {
      const { data } = await axios.get(`/api/chart/${encodeURIComponent(symbol)}`, { params: { period } });
      return data as { time: string; close: number; volume: number }[];
    },
    enabled: !!symbol,
  });
}

function ReturnCell({ value }: { value: number | null | undefined }) {
  if (value === null || value === undefined) return <td className="px-3 py-2.5 text-center text-gray-300 text-sm">-</td>;
  const isUp = value >= 0;
  return (
    <td className={`px-3 py-2.5 text-center text-sm font-semibold ${isUp ? 'text-emerald-500' : 'text-red-500'}`}>
      {isUp ? '+' : ''}{value.toFixed(2)}%
    </td>
  );
}

function parseTime(t: string): string | number {
  if (/^\d+$/.test(t)) return Number(t);
  return t;
}

const INDEX_COLORS = [
  '#3B82F6', '#8B5CF6', '#F59E0B', '#10B981',
  '#EF4444', '#EC4899', '#6366F1', '#F97316',
  '#14B8A6', '#8B5CF6',
];

function IndexChart({ symbol, period, color }: { symbol: string; period: Period; color: string }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const { data } = useIndexChart(symbol, period);

  useEffect(() => {
    if (!containerRef.current || !data || data.length === 0) return;

    if (chartRef.current) {
      chartRef.current.remove();
    }

    const isIntraday = /^\d+$/.test(data[0].time);

    const chart = createChart(containerRef.current, {
      layout: {
        background: { type: ColorType.Solid, color: '#ffffff' },
        textColor: '#9ca3af',
      },
      grid: {
        vertLines: { color: '#f9fafb' },
        horzLines: { color: '#f3f4f6' },
      },
      width: containerRef.current.clientWidth,
      height: 280,
      rightPriceScale: { borderColor: '#e5e7eb' },
      timeScale: { borderColor: '#e5e7eb', timeVisible: isIntraday },
      crosshair: { mode: 0 },
    });
    chartRef.current = chart;

    const lineSeries = chart.addSeries(LineSeries, {
      color,
      lineWidth: 2,
      priceLineVisible: false,
      lastValueVisible: true,
      crosshairMarkerVisible: true,
    });
    lineSeries.setData(data.map((d: any) => ({ time: parseTime(d.time) as any, value: d.close })));

    const volumeSeries = chart.addSeries(HistogramSeries, {
      priceFormat: { type: 'volume' },
      priceScaleId: 'volume',
    });
    chart.priceScale('volume').applyOptions({
      scaleMargins: { top: 0.85, bottom: 0 },
    });
    volumeSeries.setData(
      data.map((d: any, i: number) => ({
        time: parseTime(d.time) as any,
        value: d.volume,
        color: i > 0 && d.close >= data[i - 1].close
          ? 'rgba(16, 185, 129, 0.3)'
          : 'rgba(239, 68, 68, 0.3)',
      }))
    );

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
  }, [data, color]);

  return <div ref={containerRef} className="w-full" />;
}

export default function OverviewPage() {
  const [chartPeriod, setChartPeriod] = useState<Period>('1Y');
  const [selectedCharts, setSelectedCharts] = useState<Set<string>>(new Set(['^GSPC', '^IXIC', '^SOX']));
  const { data: indices, isLoading } = useOverview();

  if (isLoading) return <Loader />;
  if (!indices) return null;

  function toggleChart(symbol: string) {
    setSelectedCharts((prev) => {
      const next = new Set(prev);
      if (next.has(symbol)) next.delete(symbol);
      else next.add(symbol);
      return next;
    });
  }

  // Build color map by index position
  const colorMap = new Map(indices.map((idx, i) => [idx.symbol, INDEX_COLORS[i % INDEX_COLORS.length]]));

  return (
    <div className="px-4 pb-6">
      <h2 className="text-lg font-bold text-gray-900 py-4">주요 증시 현황</h2>

      {/* Returns Table */}
      <div className="bg-white border border-gray-200 rounded-lg overflow-x-auto mb-6">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-gray-100 bg-gray-50">
              <th className="text-left py-3 px-4 text-gray-500 font-medium sticky left-0 bg-gray-50 z-10">지수</th>
              <th className="px-2 py-3 text-center text-gray-400 font-medium text-xs">기준일</th>
              <th className="text-right py-3 px-4 text-gray-500 font-medium">현재가</th>
              {RETURN_COLUMNS.map((col) => (
                <th key={col} className="px-3 py-3 text-center text-gray-500 font-medium">{col}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {indices.map((idx) => (
              <tr key={idx.symbol} className="border-b border-gray-50 last:border-0 hover:bg-gray-50/50">
                <td className="py-2.5 px-4 sticky left-0 bg-white z-10">
                  <div className="flex items-center gap-2">
                    <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ backgroundColor: colorMap.get(idx.symbol) }} />
                    <div>
                      <p className="font-bold text-gray-900 whitespace-nowrap">{idx.name}</p>
                      <p className="text-xs text-gray-400">{idx.symbol}</p>
                    </div>
                  </div>
                </td>
                <td className="text-center py-2.5 px-2">
                  <p className="text-[10px] text-gray-400 leading-tight">{(idx as any).baseDate || '-'} 종가</p>
                  {(idx as any).marketState === 'OPEN' && (
                    <span className="inline-block w-1.5 h-1.5 bg-green-500 rounded-full animate-pulse" title="개장 중" />
                  )}
                </td>
                <td className="text-right py-2.5 px-4 font-bold text-gray-900 whitespace-nowrap">
                  {formatPrice(idx.price)}
                </td>
                {RETURN_COLUMNS.map((col) => (
                  <ReturnCell key={col} value={idx.returns[col]} />
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Chart Section */}
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-bold text-gray-900">차트</h3>
        <PeriodSelector selected={chartPeriod} onChange={setChartPeriod} />
      </div>

      {/* Chart Toggle Buttons */}
      <div className="flex flex-wrap gap-2 mb-4">
        {indices.map((idx) => {
          const active = selectedCharts.has(idx.symbol);
          const color = colorMap.get(idx.symbol)!;
          return (
            <button
              key={idx.symbol}
              onClick={() => toggleChart(idx.symbol)}
              className={`flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-full border transition-colors ${
                active ? 'font-semibold' : 'border-gray-200 text-gray-400'
              }`}
              style={active ? { color, borderColor: color, backgroundColor: color + '10' } : {}}
            >
              <span className="w-2 h-2 rounded-full" style={{ backgroundColor: active ? color : '#d1d5db' }} />
              {idx.name}
            </button>
          );
        })}
      </div>

      {/* Selected Charts */}
      {indices.filter((idx) => selectedCharts.has(idx.symbol)).map((idx) => {
        const color = colorMap.get(idx.symbol)!;
        return (
          <div key={idx.symbol} className="mb-5">
            <div className="flex items-center justify-between mb-2">
              <div className="flex items-center gap-2">
                <span className="w-3 h-3 rounded-full" style={{ backgroundColor: color }} />
                <span className="text-sm font-bold text-gray-900">{idx.name}</span>
              </div>
              <span className={`text-sm font-semibold ${idx.changePercent >= 0 ? 'text-emerald-500' : 'text-red-500'}`}>
                {idx.changePercent >= 0 ? '+' : ''}{idx.changePercent.toFixed(2)}%
              </span>
            </div>
            <div className="border border-gray-200 rounded-lg overflow-hidden">
              <IndexChart symbol={idx.symbol} period={chartPeriod} color={color} />
            </div>
          </div>
        );
      })}
    </div>
  );
}
