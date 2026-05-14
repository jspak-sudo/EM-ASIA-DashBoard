import type { Period } from '../../types/stock';

interface Props {
  selected: Period;
  onChange: (period: Period) => void;
}

const PERIODS: Period[] = ['1W', 'YTD', '1M', '3M', '1Y', '3Y', '5Y', 'ALL'];

export default function PeriodSelector({ selected, onChange }: Props) {
  return (
    <div className="flex gap-1">
      {PERIODS.map((p) => (
        <button
          key={p}
          onClick={() => onChange(p)}
          className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors ${
            selected === p
              ? 'bg-blue-500 text-white'
              : 'text-gray-500 hover:bg-gray-100'
          }`}
        >
          {p}
        </button>
      ))}
    </div>
  );
}
