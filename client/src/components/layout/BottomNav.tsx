import { NavLink } from 'react-router-dom';
import { BarChart3, GitCompareArrows, Globe, LayoutDashboard, Activity } from 'lucide-react';

const tabs = [
  { to: '/', icon: LayoutDashboard, label: '현황' },
  { to: '/intraday', icon: Activity, label: '실시간' },
  { to: '/chart', icon: BarChart3, label: '차트' },
  { to: '/correlation', icon: GitCompareArrows, label: '상관관계' },
  { to: '/macro', icon: Globe, label: '매크로' },
];

export default function BottomNav() {
  return (
    <nav className="fixed bottom-0 left-0 right-0 bg-white border-t border-gray-200 z-40">
      <div className="max-w-7xl mx-auto flex justify-around">
        {tabs.map(({ to, icon: Icon, label }) => (
          <NavLink
            key={to}
            to={to}
            className={({ isActive }) =>
              `flex flex-col items-center py-2 px-4 text-xs transition-colors ${
                isActive ? 'text-blue-600' : 'text-gray-400 hover:text-gray-600'
              }`
            }
          >
            {({ isActive }) => (
              <>
                <Icon className="w-5 h-5 mb-1" strokeWidth={isActive ? 2.5 : 1.5} />
                <span className={isActive ? 'font-semibold' : ''}>{label}</span>
                {isActive && <div className="w-6 h-0.5 bg-blue-600 mt-1 rounded-full" />}
              </>
            )}
          </NavLink>
        ))}
      </div>
    </nav>
  );
}
