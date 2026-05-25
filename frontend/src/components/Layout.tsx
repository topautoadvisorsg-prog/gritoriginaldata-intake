import React from 'react';
import { LayoutDashboard, Users, Calendar, Newspaper, Activity, TrendingUp, Image, ClipboardCheck, Upload } from 'lucide-react';
import { Link, useLocation } from 'react-router-dom';

const NAV = [
  { name: 'Dashboard',  icon: LayoutDashboard, path: '/' },
  { name: 'Ingest',     icon: Upload,          path: '/ingest', highlight: true },
  { name: 'Review',     icon: ClipboardCheck,  path: '/review', highlight: true },
  { name: 'Fighters',   icon: Users,            path: '/fighters' },
  { name: 'Events',     icon: Calendar,         path: '/events' },
  { name: 'News',       icon: Newspaper,        path: '/news' },
  { name: 'Odds',       icon: TrendingUp,       path: '/odds' },
  { name: 'Images',     icon: Image,            path: '/images' },
  { name: 'Monitor',    icon: Activity,         path: '/monitor' },
];

const Sidebar = () => {
  const { pathname } = useLocation();
  const isLanding = pathname === '/';

  return (
    <div className="w-60 h-full bg-surface border-r border-border flex flex-col pt-6 shrink-0">
      <div className="px-5 mb-10 flex items-center gap-3">
        <div className={`w-8 h-8 rounded-lg flex items-center justify-center font-black text-black text-sm transition-colors duration-500 ${isLanding ? 'bg-accent-red' : 'bg-accent'}`}>
          M
        </div>
        <span className="text-lg font-black tracking-tight uppercase">Data Engine</span>
      </div>

      <nav className="flex-1 px-3 space-y-1">
        {NAV.map(({ name, icon: Icon, path, highlight }) => {
          const active = pathname === path || (path !== '/' && pathname.startsWith(path));
          
          // Dashboard is RED (Landing), others are GOLD (Interior)
          const accentClass = isLanding ? 'text-accent-red bg-accent-red/10' : 'text-accent bg-accent/10';

          return (
            <Link
              key={name}
              to={path}
              className={`flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-semibold transition-all duration-200 ${
                active
                  ? accentClass
                  : highlight
                  ? 'text-accent hover:bg-accent/5'
                  : 'text-muted hover:bg-white/5 hover:text-text'
              }`}
            >
              <Icon size={17} strokeWidth={active ? 2.5 : 2} />
              {name}
            </Link>
          );
        })}
      </nav>

      <div className="px-5 pb-6">
        <div className="flex items-center gap-2 mb-1">
          <div className="w-1.5 h-1.5 rounded-full bg-green-500 animate-pulse" />
          <span className="text-[10px] text-muted/60 uppercase tracking-widest font-bold">System Online</span>
        </div>
        <p className="text-[9px] text-muted/30 font-medium">v1.2.0 • Premium Build</p>
      </div>
    </div>
  );
};

export const Layout = ({ children }: { children: React.ReactNode }) => (
  <div className="flex h-screen bg-bg text-text overflow-hidden">
    <Sidebar />
    <main className="flex-1 overflow-auto p-10">
      {children}
    </main>
  </div>
);
