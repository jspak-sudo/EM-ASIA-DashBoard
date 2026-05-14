import { useState, useRef, useEffect } from 'react';
import { Search } from 'lucide-react';
import { useSearch } from '../../hooks/useStockData';

interface HeaderProps {
  symbol: string;
  onSymbolChange: (symbol: string) => void;
}

const QUICK_SYMBOLS = ['AAPL', 'NVDA', 'TSLA', '005930.KS', 'BTC-USD'];

export default function Header({ symbol, onSymbolChange }: HeaderProps) {
  const [query, setQuery] = useState('');
  const [showResults, setShowResults] = useState(false);
  const { data: results } = useSearch(query);
  const wrapperRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target as Node)) {
        setShowResults(false);
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  function handleSearch() {
    if (query.trim()) {
      onSymbolChange(query.trim().toUpperCase());
      setQuery('');
      setShowResults(false);
    }
  }

  return (
    <header className="bg-gradient-to-b from-orange-50 to-white px-4 py-3">
      <div className="max-w-7xl mx-auto flex items-center justify-between gap-4">
        <div className="flex items-center gap-2">
          <div className="w-9 h-9 bg-blue-100 rounded-lg flex items-center justify-center">
            <span className="text-blue-600 font-bold text-sm">PRO</span>
          </div>
          <div>
            <h1 className="text-lg font-bold text-gray-900 leading-tight">주식 차트</h1>
            <p className="text-xs text-gray-400">PRO TERMINAL</p>
          </div>
        </div>

        <div ref={wrapperRef} className="relative flex-1 max-w-md">
          <div className="flex items-center bg-white border border-gray-200 rounded-lg overflow-hidden">
            <Search className="w-4 h-4 text-gray-400 ml-3" />
            <input
              type="text"
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setShowResults(true);
              }}
              onKeyDown={(e) => e.key === 'Enter' && handleSearch()}
              placeholder="종목 검색 (예: AAPL)"
              className="flex-1 px-3 py-2 text-sm outline-none"
            />
            <button
              onClick={handleSearch}
              className="px-4 py-2 bg-blue-500 text-white text-sm font-medium hover:bg-blue-600"
            >
              조회
            </button>
          </div>

          {showResults && results && results.length > 0 && (
            <div className="absolute top-full left-0 right-0 mt-1 bg-white border border-gray-200 rounded-lg shadow-lg z-50 max-h-60 overflow-y-auto">
              {results.map((r) => (
                <button
                  key={r.symbol}
                  onClick={() => {
                    onSymbolChange(r.symbol);
                    setQuery('');
                    setShowResults(false);
                  }}
                  className="w-full text-left px-4 py-2 hover:bg-gray-50 text-sm flex justify-between"
                >
                  <span className="font-medium">{r.symbol}</span>
                  <span className="text-gray-500 truncate ml-2">{r.name}</span>
                </button>
              ))}
            </div>
          )}

          <div className="flex gap-2 mt-2">
            {QUICK_SYMBOLS.map((s) => (
              <button
                key={s}
                onClick={() => onSymbolChange(s)}
                className={`px-3 py-1 text-xs rounded-full border transition-colors ${
                  symbol === s
                    ? 'bg-blue-500 text-white border-blue-500'
                    : 'bg-white text-gray-600 border-gray-200 hover:border-blue-300'
                }`}
              >
                {s}
              </button>
            ))}
          </div>
        </div>
      </div>
    </header>
  );
}
