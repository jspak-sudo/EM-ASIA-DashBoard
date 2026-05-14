import type { MAType } from '../../types/stock';

interface Props {
  activeMAs: MAType[];
  onToggle: (ma: MAType) => void;
}

const MA_LIST: { type: MAType; color: string }[] = [
  { type: 'MA5', color: '#22d3ee' },
  { type: 'EMA21', color: '#a855f7' },
  { type: 'MA50', color: '#f97316' },
  { type: 'MA60', color: '#6b7280' },
  { type: 'MA120', color: '#ec4899' },
  { type: 'MA200', color: '#eab308' },
];

export default function MAToggle({ activeMAs, onToggle }: Props) {
  return (
    <div className="flex flex-wrap gap-2">
      {MA_LIST.map(({ type, color }) => {
        const active = activeMAs.includes(type);
        return (
          <button
            key={type}
            onClick={() => onToggle(type)}
            className={`flex items-center gap-1.5 px-3 py-1 text-xs rounded-full border transition-colors ${
              active
                ? 'border-current font-semibold'
                : 'border-gray-200 text-gray-400'
            }`}
            style={active ? { color, borderColor: color } : {}}
          >
            <span
              className="w-2 h-2 rounded-full"
              style={{ backgroundColor: active ? color : '#d1d5db' }}
            />
            {type}
          </button>
        );
      })}
    </div>
  );
}
