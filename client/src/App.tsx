import { useState } from 'react';
import { BrowserRouter, Routes, Route } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import Header from './components/layout/Header';
import BottomNav from './components/layout/BottomNav';
import ChartPage from './pages/ChartPage';
import CorrelationPage from './pages/CorrelationPage';
import MacroPage from './pages/MacroPage';
import OverviewPage from './pages/OverviewPage';
import IntradayPage from './pages/IntradayPage';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30000,
      retry: 1,
    },
  },
});

export default function App() {
  const [symbol, setSymbol] = useState('AAPL');

  return (
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <div className="min-h-screen bg-white pb-16">
          <Header symbol={symbol} onSymbolChange={setSymbol} />
          <main className="max-w-7xl mx-auto">
            <Routes>
              <Route path="/" element={<OverviewPage />} />
              <Route path="/intraday" element={<IntradayPage />} />
              <Route path="/chart" element={<ChartPage symbol={symbol} />} />
              <Route path="/correlation" element={<CorrelationPage />} />
              <Route path="/macro" element={<MacroPage />} />
            </Routes>
          </main>
          <BottomNav />
        </div>
      </BrowserRouter>
    </QueryClientProvider>
  );
}
