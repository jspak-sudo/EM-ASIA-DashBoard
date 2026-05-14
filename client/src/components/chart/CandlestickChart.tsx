import { useEffect, useRef } from 'react';
import {
  createChart,
  CandlestickSeries,
  HistogramSeries,
  LineSeries,
  ColorType,
  type IChartApi,
  type ISeriesApi,
} from 'lightweight-charts';
import type { ChartDataPoint, MAType } from '../../types/stock';

interface Props {
  data: ChartDataPoint[];
  activeMAs: MAType[];
}

const MA_CONFIG: Record<MAType, { period: number; color: string; isEMA?: boolean }> = {
  MA5: { period: 5, color: '#22d3ee' },
  EMA21: { period: 21, color: '#a855f7', isEMA: true },
  MA50: { period: 50, color: '#f97316' },
  MA60: { period: 60, color: '#6b7280' },
  MA120: { period: 120, color: '#ec4899' },
  MA200: { period: 200, color: '#eab308' },
};

function calcSMA(data: number[], period: number): (number | null)[] {
  const result: (number | null)[] = [];
  for (let i = 0; i < data.length; i++) {
    if (i < period - 1) {
      result.push(null);
    } else {
      const sum = data.slice(i - period + 1, i + 1).reduce((a, b) => a + b, 0);
      result.push(sum / period);
    }
  }
  return result;
}

function calcEMA(data: number[], period: number): (number | null)[] {
  const result: (number | null)[] = [];
  const k = 2 / (period + 1);
  for (let i = 0; i < data.length; i++) {
    if (i < period - 1) {
      result.push(null);
    } else if (i === period - 1) {
      const sum = data.slice(0, period).reduce((a, b) => a + b, 0);
      result.push(sum / period);
    } else {
      const prev = result[i - 1];
      if (prev !== null) {
        result.push(data[i] * k + prev * (1 - k));
      } else {
        result.push(null);
      }
    }
  }
  return result;
}

function parseTime(t: string): string | number {
  // If it's a pure number string (Unix timestamp), convert to number
  if (/^\d+$/.test(t)) return Number(t);
  return t;
}

export default function CandlestickChart({ data, activeMAs }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);

  useEffect(() => {
    if (!containerRef.current || data.length === 0) return;

    if (chartRef.current) {
      chartRef.current.remove();
    }

    const isIntraday = /^\d+$/.test(data[0].time);

    const chart = createChart(containerRef.current, {
      layout: {
        background: { type: ColorType.Solid, color: '#ffffff' },
        textColor: '#6B7280',
      },
      grid: {
        vertLines: { color: '#f3f4f6' },
        horzLines: { color: '#f3f4f6' },
      },
      width: containerRef.current.clientWidth,
      height: 450,
      crosshair: {
        mode: 0,
      },
      rightPriceScale: {
        borderColor: '#e5e7eb',
      },
      timeScale: {
        borderColor: '#e5e7eb',
        timeVisible: isIntraday,
      },
    });
    chartRef.current = chart;

    // Candlestick series
    const candleSeries = chart.addSeries(CandlestickSeries, {
      upColor: '#10B981',
      downColor: '#EF4444',
      borderUpColor: '#10B981',
      borderDownColor: '#EF4444',
      wickUpColor: '#10B981',
      wickDownColor: '#EF4444',
    });
    candleSeries.setData(
      data.map((d) => ({
        time: parseTime(d.time) as any,
        open: d.open,
        high: d.high,
        low: d.low,
        close: d.close,
      }))
    );

    // Volume series
    const volumeSeries = chart.addSeries(HistogramSeries, {
      priceFormat: { type: 'volume' },
      priceScaleId: 'volume',
    });
    chart.priceScale('volume').applyOptions({
      scaleMargins: { top: 0.85, bottom: 0 },
    });
    volumeSeries.setData(
      data.map((d) => ({
        time: parseTime(d.time) as any,
        value: d.volume,
        color: d.close >= d.open ? 'rgba(16, 185, 129, 0.4)' : 'rgba(239, 68, 68, 0.4)',
      }))
    );

    // MA lines
    const closePrices = data.map((d) => d.close);

    for (const maType of activeMAs) {
      const config = MA_CONFIG[maType];
      const values = config.isEMA
        ? calcEMA(closePrices, config.period)
        : calcSMA(closePrices, config.period);

      const lineSeries = chart.addSeries(LineSeries, {
        color: config.color,
        lineWidth: 1,
        priceLineVisible: false,
        lastValueVisible: false,
        crosshairMarkerVisible: false,
      });

      const lineData = data
        .map((d, i) => ({ time: parseTime(d.time) as any, value: values[i] }))
        .filter((d): d is { time: any; value: number } => d.value !== null);

      lineSeries.setData(lineData);
    }

    chart.timeScale().fitContent();

    const resizeObserver = new ResizeObserver((entries) => {
      for (const entry of entries) {
        chart.applyOptions({ width: entry.contentRect.width });
      }
    });
    resizeObserver.observe(containerRef.current);

    return () => {
      resizeObserver.disconnect();
      chart.remove();
      chartRef.current = null;
    };
  }, [data, activeMAs]);

  return <div ref={containerRef} className="w-full" />;
}
