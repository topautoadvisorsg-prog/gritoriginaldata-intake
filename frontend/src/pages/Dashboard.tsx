import { useState, useEffect } from 'react';
import { Search, Zap, CheckCircle, AlertCircle, TrendingUp, Users, Activity, Image, WifiOff } from 'lucide-react';
import { scanEvent, getStats, getPipelineJobs, getRecentFighters } from '../api';

// Maps pipeline job status values to the agent step label shown in the feed.
const STATUS_TO_AGENT: Record<string, string> = {
  profiling:    'Agent 2',
  history:      'Agent 3',
  intelligence: 'Agent 4',
  imaging:      'Agent 7',
};

const Dashboard = () => {
  const [eventName, setEventName] = useState('');
  const [isScanning, setIsScanning] = useState(false);
  const [scanMsg, setScanMsg] = useState('');
  const [statsLoading, setStatsLoading] = useState(true);
  const [statsError, setStatsError] = useState(false);
  // Set of agent step labels that currently have at least one job in progress.
  const [activeAgents, setActiveAgents] = useState<Set<string>>(new Set());
  const [recentFighters, setRecentFighters] = useState<any[]>([]);

  const [stats, setStats] = useState({
    total_fighters: 0,
    verified_fighters: 0,
    unverified_fighters: 0,
    news_today: 0,
    odds_staging: 0,
    images_pending: 0,
  });

  const fetchStats = async () => {
    try {
      const res = await getStats();
      setStats(res.data);
      setStatsError(false);
    } catch {
      setStatsError(true);
    } finally {
      setStatsLoading(false);
    }
  };

  const fetchActiveAgents = async () => {
    try {
      const res = await getPipelineJobs();
      const jobs: Array<{ status: string }> = res.data || [];
      const active = new Set<string>();
      for (const j of jobs) {
        const agent = STATUS_TO_AGENT[j.status];
        if (agent) active.add(agent);
      }
      setActiveAgents(active);
    } catch {
      // silently ignore — dots just stay grey
    }
  };

  const fetchRecent = async () => {
    try {
      const res = await getRecentFighters();
      setRecentFighters(res.data);
    } catch {
      // silently ignore
    }
  };

  useEffect(() => {
    fetchStats();
    fetchActiveAgents();
    fetchRecent();
    const statsInterval = setInterval(fetchStats, 30000);
    const agentInterval = setInterval(fetchActiveAgents, 10000);
    const recentInterval = setInterval(fetchRecent, 20000);
    return () => {
      clearInterval(statsInterval);
      clearInterval(agentInterval);
      clearInterval(recentInterval);
    };
  }, []);

  const handleScan = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!eventName) return;
    setIsScanning(true);
    setScanMsg('');
    try {
      await scanEvent(eventName);
      setScanMsg(`✓ Scan queued for "${eventName}"`);
      setEventName('');
    } catch {
      setScanMsg('✗ Failed to queue scan. Check backend connection.');
    } finally {
      setIsScanning(false);
    }
  };

  const statCards = [
    { label: 'Total Fighters',  value: stats.total_fighters,    icon: Users,        color: 'text-text' },
    { label: 'Verified',        value: stats.verified_fighters,  icon: CheckCircle,  color: 'text-green' },
    { label: 'Unverified',      value: stats.unverified_fighters,icon: AlertCircle,  color: 'text-gold' },
    { label: 'News Today',      value: stats.news_today,         icon: TrendingUp,   color: 'text-accent' },
    { label: 'Odds Staging',    value: stats.odds_staging,       icon: TrendingUp,   color: 'text-gold' },
    { label: 'Images Pending',  value: stats.images_pending,     icon: Image,        color: 'text-muted' },
  ];

    return (
    <div className="space-y-10 theme-red animate-in fade-in duration-700">
      {/* Stat cards */}
      {statsError ? (
        <div className="flex items-center gap-3 bg-surface border border-border rounded-xl p-5 text-muted">
          <WifiOff size={18} className="text-accent shrink-0" />
          <span className="text-sm">Backend unreachable — stat cards will reload automatically.</span>
        </div>
      ) : (
        <div className="grid grid-cols-2 lg:grid-cols-6 gap-4">
          {statCards.map((s, i) => (
            <div key={i} className="bg-surface/40 backdrop-blur-sm p-5 rounded-xl border border-border/50 hover:border-accent/30 transition-all group">
              <div className="flex items-center justify-between mb-3">
                <span className="text-muted text-[10px] uppercase font-black tracking-widest group-hover:text-accent transition-colors">{s.label}</span>
                <s.icon size={15} className={`${s.color} opacity-50 group-hover:opacity-100 transition-opacity`} />
              </div>
              {statsLoading ? (
                <div className="h-8 w-12 bg-border/40 rounded animate-pulse" />
              ) : (
                <div className="text-2xl font-black">{s.value.toLocaleString()}</div>
              )}
            </div>
          ))}
        </div>
      )}

      {/* Event scan — The "Energy" Entry Point */}
      <div className="bg-surface p-10 rounded-2xl border border-border/40 relative overflow-hidden group">
        <div className="absolute top-0 right-0 w-96 h-96 bg-accent/5 rounded-full -mr-48 -mt-48 blur-[100px] pointer-events-none group-hover:bg-accent/10 transition-colors duration-1000" />
        <div className="relative z-10">
          <h2 className="text-3xl font-black mb-1 tracking-tight">Streamline Ingestion</h2>
          <p className="text-muted text-sm mb-8 max-w-xl">Enter an event name to trigger Agent 1. It will audit the card, identify new fighters, and seed the profiling queue.</p>
          
          <form onSubmit={handleScan} className="flex gap-3 max-w-2xl">
            <div className="relative flex-1 group/input">
              <Search className="absolute left-4 top-1/2 -translate-y-1/2 text-muted group-focus-within/input:text-accent transition-colors" size={18} />
              <input
                type="text"
                placeholder="e.g. UFC 306: O'Malley vs. Dvalishvili"
                className="w-full bg-bg/50 border border-border/60 rounded-xl py-4 pl-12 pr-4 text-sm focus:outline-none focus:border-accent focus:bg-bg transition-all"
                value={eventName}
                onChange={e => setEventName(e.target.value)}
              />
            </div>
            <button
              type="submit"
              disabled={isScanning || !eventName}
              className="bg-accent hover:bg-accent/90 px-8 py-4 rounded-xl font-black text-xs uppercase tracking-widest transition-all hover:scale-[1.02] active:scale-95 disabled:opacity-30 flex items-center gap-2 text-black shadow-lg shadow-accent/10"
            >
              <Zap size={16} fill="currentColor" />
              {isScanning ? 'Scanning...' : 'Launch Scan'}
            </button>
          </form>
        </div>
        {scanMsg && (
          <p className={`mt-3 text-sm font-medium ${scanMsg.startsWith('✓') ? 'text-green' : 'text-accent'}`}>
            {scanMsg}
          </p>
        )}
      </div>

      {/* Pipeline & Activity grid */}
      <div className="grid grid-cols-1 xl:grid-cols-3 gap-10">
        {/* Pipeline feed */}
        <div className="xl:col-span-1 space-y-4">
          <h2 className="text-lg font-bold flex items-center gap-2 px-1">
            <Activity size={18} className="text-accent" />
            Live Pipeline Feed
          </h2>
          <div className="space-y-3">
            {[
              { label: 'Event Scanner',    step: 'Agent 1', desc: 'Parses upcoming fight cards' },
              { label: 'Fighter Profiler', step: 'Agent 2', desc: 'Builds fighter profiles' },
              { label: 'History Builder',  step: 'Agent 3', desc: 'Fetches fight history' },
              { label: 'Intelligence',     step: 'Agent 4', desc: 'News & signal detection' },
              { label: 'Odds Scraper',     step: 'Agent 6', desc: 'BestFightOdds + OddsShark fallback' },
              { label: 'Image Processor',  step: 'Agent 7', desc: 'Sherdog headshot + DALL-E body shot' },
            ].map((item, i) => {
              const isActive = activeAgents.has(item.step);
              return (
                <div key={i} className="bg-surface p-4 rounded-xl border border-border flex items-center gap-4 hover:border-border/80 transition-colors">
                  <div className="w-10 h-10 bg-bg rounded-lg flex items-center justify-center font-black text-xs text-muted border border-border shrink-0">
                    {item.step.replace('Agent ', 'A')}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="font-bold text-sm">{item.label}</div>
                    <div className="text-[11px] text-muted mt-0.5">{item.desc}</div>
                  </div>
                  <div
                    title={isActive ? `${item.step} is running` : `${item.step} is idle`}
                    className={`w-2 h-2 rounded-full shrink-0 ${
                      isActive
                        ? 'bg-green animate-pulse shadow-[0_0_8px_rgba(34,197,94,0.5)]'
                        : 'bg-border'
                    }`}
                  />
                </div>
              );
            })}
          </div>
        </div>

        {/* Recent Activity */}
        <div className="xl:col-span-2 space-y-4">
          <h2 className="text-lg font-bold flex items-center justify-between gap-2 px-1">
            <div className="flex items-center gap-2">
              <Activity size={18} className="text-green" />
              Recent Ingestion Activity
            </div>
            <button 
              onClick={fetchRecent} 
              className="text-[10px] uppercase tracking-widest font-black text-muted hover:text-accent transition-colors"
            >
              Refresh
            </button>
          </h2>
          <div className="bg-surface border border-border rounded-2xl overflow-hidden">
            {recentFighters.length === 0 ? (
              <div className="p-10 text-center text-muted text-sm italic">
                No recent activity found.
              </div>
            ) : (
              <div className="divide-y divide-border/50">
                {recentFighters.map((f: any) => (
                  <div key={f.id} className="flex items-center justify-between p-4 hover:bg-white/5 transition-colors group">
                    <div className="flex items-center gap-4">
                      <div className="w-10 h-10 rounded-full bg-bg border border-border flex items-center justify-center overflow-hidden shrink-0">
                        {f.image_url ? (
                          <img src={f.image_url} alt="" className="w-full h-full object-cover" />
                        ) : (
                          <Users size={16} className="text-muted/40" />
                        )}
                      </div>
                      <div>
                        <div className="font-bold text-sm group-hover:text-accent transition-colors">
                          {f.first_name} {f.last_name}
                        </div>
                        <div className="text-[10px] text-muted/60 uppercase tracking-tight flex items-center gap-2 mt-0.5">
                          <span>{f.admin_status || 'Pending'}</span>
                          <span className="opacity-20">•</span>
                          <span className={f.is_verified ? 'text-green' : 'text-gold'}>
                            {f.is_verified ? 'Verified' : 'Unverified'}
                          </span>
                        </div>
                      </div>
                    </div>
                    <a 
                      href={`/fighters/${f.id}`}
                      className="text-[10px] bg-bg border border-border px-3 py-1.5 rounded-lg font-black uppercase tracking-widest hover:border-accent hover:text-accent transition-all"
                    >
                      Audit
                    </a>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};

export default Dashboard;
