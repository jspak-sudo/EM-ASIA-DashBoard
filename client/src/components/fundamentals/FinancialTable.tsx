import { formatPrice } from '../../utils/format';

interface AnnualData {
  year: string;
  annualReturn: number | null;
  startPrice: number;
  endPrice: number;
}

interface Props {
  data: AnnualData[];
}

export default function FinancialTable({ data }: Props) {
  if (data.length === 0) return null;

  return (
    <div className="mt-6">
      <h2 className="text-sm font-bold text-gray-900 mb-3">연도별 수익률</h2>
      <div className="bg-white border border-gray-200 rounded-lg overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-gray-100">
              <th className="text-left py-3 px-4 text-gray-500 font-medium">연도</th>
              <th className="text-right py-3 px-4 text-gray-500 font-medium">시작가</th>
              <th className="text-right py-3 px-4 text-gray-500 font-medium">종료가</th>
              <th className="text-right py-3 px-4 text-gray-500 font-medium">연간 수익률</th>
            </tr>
          </thead>
          <tbody>
            {data.map((row) => (
              <tr key={row.year} className="border-b border-gray-50 last:border-0">
                <td className="py-3 px-4 font-bold text-gray-900">{row.year}</td>
                <td className="text-right py-3 px-4 text-gray-700">
                  ${formatPrice(row.startPrice)}
                </td>
                <td className="text-right py-3 px-4 text-gray-700">
                  ${formatPrice(row.endPrice)}
                </td>
                <td className="text-right py-3 px-4">
                  <ReturnBadge value={row.annualReturn} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function ReturnBadge({ value }: { value: number | null }) {
  if (value === null) return <span className="text-gray-400">-</span>;
  const isUp = value >= 0;
  return (
    <span className={`text-sm font-medium ${isUp ? 'text-emerald-500' : 'text-red-500'}`}>
      {isUp ? '▲' : '▼'} {Math.abs(value).toFixed(1)}%
    </span>
  );
}
