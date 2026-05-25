import { useState, useEffect, useCallback, useRef } from 'react';
import {
  Zap, RefreshCw, Filter, ExternalLink, CheckCircle,
  XCircle, Trash2, ChevronDown, AlertTriangle, Shield,
  Activity, Clock, Radio, Calendar, User, Info,
} from 'lucide-react';
import api from '../api';

// ── Types ─────────────────────────────────────────────────────────────────────

interface Signal {
  id: string;
  headline: string;
  summary: string;
  importance: number;            // 1-5 integer
  source_reliability: string;    // high | medium | low
  source_name: string;
  signal_type: string;
  source_url: string;
  published_at: string | null;
  admin_status: 'pending' | 'approved' | 'rejected';
  fighter_names: string[];
  fighter_id: string | null;
  created_at: string;
}

interface FighterTrackState {
  fighter_id: string;
  fighter_name: string;
  last_full_scan_at: string | null;
  last_incremental_scan_at: string | null;
  scan_type: 'full' | 'incremental';
}

interface EventStatus {
  event: { id: string; name: string; date: string } | null;
  fighters: FighterTrackState[];
  message: string | null;
}

// ── Constants ──────────────────────────────────────────────────────────────────

const SIGNAL_TYPES = [
  { value: '',               label: 'All Types' },
  { value: 'injury',         label: 'Injury' },
  { value: 'camp_change',    label: 'Camp Change' },
  { value: 'weight_issues',  label: 'Weight Issues' },
  { value: 'withdrawal',     label: 'Withdrawal' },
  { value: 'layoff',         label: 'Layoff Return' },
  { value: 'performance',    label: 'Performance Intel' },
  { value: 'general_news',   label: 'General News' },
];

const STATUS_OPTIONS = [
  { value: '',         label: 'All Status' },
  { value: 'pending',  label: 'Pending' },
  { value: 'approved', label: 'Approved' },
  { value: 'rejected', label: 'Rejected' },
];

const signalTypeLabel: Record<string, string> = {
  injury:         'Injury',
  camp_change:    'Camp Change',
  weight_issues:  'Weight Issues',
  withdrawal:     'Withdrawal',
  layoff:         'Layoff Return',
  performance:    'Performance Intel',
  general_news:   'General News',
};

// ── Importance helpers ─────────────────────────────────────────────────────────

function importanceCfg(n: number) {
  if (n >= 5) return {
    border: 'border-red-500/60',
    bg:     'bg-red-500/8',
    badge:  'bg-red-500/25 text-red-300 border-red-500/40',
    label:  '5 · CRITICAL',
    icon:   <AlertTriangle size={11} />,
  };
  if (n === 4) return {
    border: 'border-orange-400/50',
    bg:     'bg-orange-500/6',
    badge:  'bg-orange-500/20 text-orange-300 border-orange-400/35',
    label:  '4 · HIGH',
    icon:   <AlertTriangle size={11} />,
  };
  if (n === 3) return {
    border: 'border-yellow-400/40',
    bg:     'bg-yellow-400/4',
    badge:  'bg-yellow-400/20 text-yellow-300 border-yellow-400/30',
    label:  '3 · NOTABLE',
    icon:   <Shield size={11} />,
  };
  return {
    border: 'border-border',
    bg:     '',
    badge:  'bg-zinc-700/40 text-zinc-400 border-zinc-600/30',
    label:  `${n} · LOW`,
    icon:   <Activity size={11} />,
  };
}

const statusCfg: Record<string, string> = {
  pending:  'bg-zinc-700/40 text-zinc-300 border-zinc-600/30',
  approved: 'bg-green-500/20 text-green-400 border-green-500/30',
  rejected: 'bg-red-500/15 text-red-400 border-red-500/25',
};

function Badge({ children, className }: { children: React.ReactNode; className: string }) {
  return (
    <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded border text-[10px] font-bold uppercase tracking-wide ${className}`}>
      {children}
    </span>
  );
}

function timeAgo(ts: string | null): string {
  if (!ts) return '';
  const diff = Date.now() - new Date(ts).getTime();
  const h = Math.floor(diff / 3_600_000);
  if (h < 1) return `${Math.floor(diff / 60_000)}m ago`;
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

// ── Event Tracking Panel ──────────────────────────────────────────────────────

function EventTrackingPanel({ status }: { status: EventStatus | null }) {
  if (!status) return null;

  if (!status.event) {
    return (
      <div className="bg-surface border border-border rounded-xl px-4 py-3 flex items-center gap-3">
        <Info size={15} className="text-muted/50 shrink-0" />
        <p className="text-xs text-muted">
          {status.message ?? 'No upcoming events. Create your next event, then ingest the card.'}
        </p>
      </div>
    );
  }

  const scannedCount = status.fighters.filter(f => f.last_full_scan_at).length;

  return (
    <div className="bg-surface border border-border rounded-xl p-4 space-y-3">
      {/* Event header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Calendar size={14} className="text-accent/70" />
          <span className="text-xs font-semibold text-text">{status.event.name}</span>
          <span className="text-xs text-muted">{status.event.date}</span>
        </div>
        <div className="text-xs text-muted/60">
          {scannedCount}/{status.fighters.length} fighters scanned
        </div>
      </div>

      {/* Fighter tracking state */}
      {status.fighters.length > 0 ? (
        <div className="flex flex-wrap gap-1.5">
          {status.fighters.map(f => {
            const hasFullScan = !!f.last_full_scan_at;
            const lastScan = f.last_incremental_scan_at || f.last_full_scan_at;
            return (
              <div
                key={f.fighter_id}
                title={lastScan ? `Last scanned: ${new Date(lastScan).toLocaleString()}` : 'Not yet scanned'}
                className={`flex items-center gap-1.5 px-2 py-1 rounded-lg border text-xs ${
                  hasFullScan
                    ? 'bg-green-500/8 border-green-500/20 text-green-400'
                    : 'bg-zinc-800/60 border-zinc-700/40 text-zinc-400'
                }`}
              >
                <User size={10} />
                <span>{f.fighter_name}</span>
                {hasFullScan ? (
                  <span className="text-green-500/60 text-[9px]">
                    {f.scan_type === 'incremental' ? '↑' : '✓'}
                  </span>
                ) : (
                  <span className="text-zinc-600 text-[9px]">○</span>
                )}
              </div>
            );
          })}
        </div>
      ) : (
        <p className="text-xs text-muted/60">
          No fighters linked yet. Ingest the card first.
        </p>
      )}
    </div>
  );
}

// ── Signal Card ───────────────────────────────────────────────────────────────

function SignalCard({
  signal,
  onApprove,
  onReject,
  onDelete,
  onPush,
}: {
  signal: Signal;
  onApprove: (id: string) => void;
  onReject:  (id: string) => void;
  onDelete:  (id: string) => void;
  onPush:    (id: string) => void;
}) {
  const [acting, setActing] = useState(false);
  const cfg = importanceCfg(signal.importance);

  const act = async (fn: () => Promise<any>) => {
    setActing(true);
    try { await fn(); } finally { setActing(false); }
  };

  return (
    <div className={`rounded-xl border ${cfg.border} ${cfg.bg} p-4 transition-all`}>
      {/* Header */}
      <div className="flex items-start gap-3 mb-3">
        <div className="flex-1 min-w-0">
          <div className="flex flex-wrap items-center gap-1.5 mb-2">
            <Badge className={cfg.badge}>
              {cfg.icon}
              {cfg.label}
            </Badge>
            <Badge className="bg-accent/10 text-accent border-accent/20">
              {signalTypeLabel[signal.signal_type] ?? signal.signal_type}
            </Badge>
            <Badge className={statusCfg[signal.admin_status]}>
              {signal.admin_status}
            </Badge>
            <Badge className="bg-zinc-800 text-zinc-400 border-zinc-700">
              {signal.source_reliability} reliability
            </Badge>
          </div>
          <h3 className="font-semibold text-sm leading-snug">{signal.headline}</h3>
        </div>
      </div>

      {/* Summary */}
      {signal.summary && (
        <p className="text-xs text-muted leading-relaxed mb-3">{signal.summary}</p>
      )}

      {/* Tags (fighters + event) */}
      {signal.fighter_names?.length > 0 && (
        <div className="flex flex-wrap gap-1 mb-3">
          {signal.fighter_names.map((name, i) => (
            <span key={i} className="px-2 py-0.5 bg-black/30 border border-white/10 rounded text-xs text-muted/80">
              {name}
            </span>
          ))}
        </div>
      )}

      {/* Footer */}
      <div className="flex items-center justify-between pt-3 border-t border-white/5">
        <div className="flex items-center gap-3 text-xs text-muted/60">
          {signal.source_name && (
            <span className="font-medium text-muted/80">{signal.source_name}</span>
          )}
          <span className="flex items-center gap-1">
            <Clock size={10} />
            {timeAgo(signal.published_at || signal.created_at)}
          </span>
        </div>

        <div className="flex items-center gap-2">
          {signal.source_url && (
            <a
              href={signal.source_url}
              target="_blank"
              rel="noreferrer"
              className="p-1.5 text-muted/50 hover:text-accent transition-colors"
              title="Open source"
            >
              <ExternalLink size={13} />
            </a>
          )}

          {signal.admin_status === 'approved' && (
            <button
              onClick={() => act(() => onPush(signal.id))}
              disabled={acting}
              className="flex items-center gap-1 px-2 py-1 bg-green-500/20 border border-green-500/30 rounded text-xs font-semibold text-green-400 hover:bg-green-500/30 transition-colors disabled:opacity-40"
            >
              <Radio size={11} />
              Push
            </button>
          )}

          {signal.admin_status === 'pending' && (
            <>
              <button
                onClick={() => act(() => onReject(signal.id))}
                disabled={acting}
                className="p-1.5 text-red-400/60 hover:text-red-400 transition-colors disabled:opacity-40"
                title="Reject"
              >
                <XCircle size={16} />
              </button>
              <button
                onClick={() => act(() => onApprove(signal.id))}
                disabled={acting}
                className="flex items-center gap-1 px-2 py-1 bg-accent/20 border border-accent/30 rounded text-xs font-semibold text-accent hover:bg-accent/30 transition-colors disabled:opacity-40"
              >
                <CheckCircle size={12} />
                Approve
              </button>
            </>
          )}

          <button
            onClick={() => act(() => onDelete(signal.id))}
            disabled={acting}
            className="p-1.5 text-muted/30 hover:text-red-400/70 transition-colors disabled:opacity-40"
            title="Delete"
          >
            <Trash2 size={13} />
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Main Page ─────────────────────────────────────────────────────────────────

const NewsPage = () => {
  const [signals, setSignals]           = useState<Signal[]>([]);
  const [eventStatus, setEventStatus]   = useState<EventStatus | null>(null);
  const [loading, setLoading]           = useState(true);
  const [fetching, setFetching]         = useState(false);
  const [fetchMsg, setFetchMsg]         = useState<string | null>(null);
  const [fetchError, setFetchError]     = useState<string | null>(null);
  const [scanActive, setScanActive]     = useState(false);
  const [scanCount, setScanCount]       = useState(0);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Filters — default shows importance >= 3
  const [minImportance, setMinImportance] = useState(3);
  const [filterType,    setFilterType]    = useState('');
  const [filterStatus,  setFilterStatus]  = useState('pending');

  // Load event status
  const loadEventStatus = async () => {
    try {
      const res = await api.get('/news/event-status');
      setEventStatus(res.data);
    } catch { /* non-fatal */ }
  };

  // Load signals
  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params: Record<string, string | number> = {
        min_importance: minImportance,
      };
      if (filterType)   params.signal_type = filterType;
      if (filterStatus) params.status      = filterStatus;
      const res = await api.get('/news/signals', { params });
      setSignals(res.data);
    } catch (e) {
      console.error('Failed to load signals', e);
    } finally {
      setLoading(false);
    }
  }, [minImportance, filterType, filterStatus]);

  useEffect(() => { load(); loadEventStatus(); }, [load]);

  const stopPolling = () => {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  };

  const triggerFetch = async () => {
    if (fetching || scanActive) return;
    setFetching(true);
    setFetchMsg(null);
    setFetchError(null);

    try {
      const res = await api.post('/news/fetch');
      const data = res.data;

      if (data.status === 'no_event' || data.status === 'no_fighters') {
        setFetchError(data.message);
        setFetching(false);
        return;
      }

      // Scan started
      setScanActive(true);
      setScanCount(0);
      setFetchMsg(`Scanning ${data.fighter_count} fighters for ${data.event}…`);
      setFetching(false);

      // Poll every 4s for up to 3 minutes
      let elapsed = 0;
      const MAX_POLL_MS = 180_000;
      let prevCount = signals.length;

      pollRef.current = setInterval(async () => {
        elapsed += 4000;

        try {
          const params: Record<string, string | number> = { min_importance: minImportance };
          if (filterType)   params.signal_type = filterType;
          if (filterStatus) params.status      = filterStatus;
          const r = await api.get('/news/signals', { params });
          const newSignals: Signal[] = r.data;
          setSignals(newSignals);
          const added = newSignals.length - prevCount;
          if (added > 0) {
            setScanCount(c => c + added);
            prevCount = newSignals.length;
          }
          // Also refresh event status to show updated scan timestamps
          loadEventStatus();
        } catch { /* ignore */ }

        if (elapsed >= MAX_POLL_MS) {
          stopPolling();
          setScanActive(false);
          setFetchMsg(null);
        }
      }, 4000);

    } catch (e: any) {
      setFetchError('Fetch failed: ' + (e?.response?.data?.detail || e.message));
      setFetching(false);
      setScanActive(false);
    }
  };

  useEffect(() => () => stopPolling(), []);

  const handleApprove = async (id: string) => {
    await api.patch(`/news/${id}/approve`);
    setSignals(prev => prev.map(s => s.id === id ? { ...s, admin_status: 'approved' } : s));
  };

  const handleReject = async (id: string) => {
    await api.patch(`/news/${id}/reject`);
    setSignals(prev => prev.map(s => s.id === id ? { ...s, admin_status: 'rejected' } : s));
  };

  const handleDelete = async (id: string) => {
    await api.delete(`/news/${id}`);
    setSignals(prev => prev.filter(s => s.id !== id));
  };

  const handlePush = async (id: string) => {
    try {
      await api.post(`/pipeline/push/news/${id}`);
      alert('Signal pushed to main app ✓');
    } catch (e: any) {
      alert('Push failed: ' + (e?.response?.data?.detail || e.message));
    }
  };

  // Stats
  const critical = signals.filter(s => s.importance >= 5).length;
  const high      = signals.filter(s => s.importance === 4).length;
  const pending   = signals.filter(s => s.admin_status === 'pending').length;

  return (
    <div className="flex flex-col h-full gap-5 max-w-4xl mx-auto">

      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-bold flex items-center gap-2">
            <Zap className="text-accent" size={22} />
            Signal Intelligence
          </h2>
          <p className="text-xs text-muted mt-0.5">
            Event-driven · Per-fighter · Claude-classified · Importance 1–5
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => { load(); loadEventStatus(); }}
            disabled={loading}
            className="p-2 text-muted hover:text-text transition-colors disabled:opacity-40"
            title="Refresh"
          >
            <RefreshCw size={15} className={loading ? 'animate-spin' : ''} />
          </button>
          <button
            onClick={triggerFetch}
            disabled={fetching || scanActive}
            className="flex items-center gap-2 px-4 py-2 bg-accent/10 border border-accent/30 rounded-lg text-sm font-semibold text-accent hover:bg-accent/20 transition-colors disabled:opacity-50"
          >
            {(fetching || scanActive)
              ? <RefreshCw size={14} className="animate-spin" />
              : <Zap size={14} />}
            {fetching ? 'Connecting…' : scanActive ? 'Scanning…' : 'Scan Event'}
          </button>
        </div>
      </div>

      {/* Event tracking panel */}
      <EventTrackingPanel status={eventStatus} />

      {/* Scan-in-progress banner */}
      {scanActive && (
        <div className="bg-accent/8 border border-accent/20 rounded-xl px-4 py-3 flex items-center gap-3">
          <div className="w-3 h-3 rounded-full bg-accent animate-pulse shrink-0" />
          <div className="flex-1 min-w-0">
            <p className="text-xs font-semibold text-accent">Scanning fighters…</p>
            {fetchMsg && <p className="text-xs text-muted/70 mt-0.5 truncate">{fetchMsg}</p>}
          </div>
          {scanCount > 0 && (
            <span className="shrink-0 text-xs font-bold text-accent bg-accent/20 px-2 py-0.5 rounded-full">
              +{scanCount} signals found
            </span>
          )}
          <button
            onClick={() => { stopPolling(); setScanActive(false); setFetchMsg(null); }}
            className="text-muted/40 hover:text-muted text-xs shrink-0"
          >
            Stop
          </button>
        </div>
      )}

      {/* Error banner */}
      {fetchError && (
        <div className="bg-yellow-500/8 border border-yellow-500/20 rounded-lg px-4 py-3 flex items-center gap-2 text-xs text-yellow-300">
          <Info size={13} className="shrink-0" />
          {fetchError}
          <button onClick={() => setFetchError(null)} className="ml-auto text-yellow-400/50 hover:text-yellow-400">✕</button>
        </div>
      )}

      {/* Stats strip */}
      <div className="grid grid-cols-4 gap-3">
        {[
          { label: 'Critical (5)',    value: critical, color: 'text-red-400' },
          { label: 'High (4)',        value: high,     color: 'text-orange-400' },
          { label: 'Pending review', value: pending,  color: 'text-yellow-400' },
          { label: 'Total signals',  value: signals.length, color: 'text-text' },
        ].map(({ label, value, color }) => (
          <div key={label} className="bg-surface border border-border rounded-lg px-4 py-3">
            <div className={`text-2xl font-bold ${color}`}>{value}</div>
            <div className="text-xs text-muted mt-0.5">{label}</div>
          </div>
        ))}
      </div>

      {/* Filters */}
      <div className="flex items-center gap-2 flex-wrap">
        <Filter size={13} className="text-muted" />

        {/* Min importance */}
        <div className="relative">
          <select
            value={minImportance}
            onChange={e => setMinImportance(Number(e.target.value))}
            className="appearance-none bg-surface border border-border rounded-lg pl-3 pr-7 py-1.5 text-xs focus:outline-none focus:border-accent cursor-pointer"
          >
            <option value={1}>All (1+)</option>
            <option value={2}>2+ Low</option>
            <option value={3}>3+ Notable</option>
            <option value={4}>4+ High</option>
            <option value={5}>5 Critical only</option>
          </select>
          <ChevronDown size={11} className="absolute right-2 top-1/2 -translate-y-1/2 text-muted pointer-events-none" />
        </div>

        {/* Signal type */}
        <div className="relative">
          <select
            value={filterType}
            onChange={e => setFilterType(e.target.value)}
            className="appearance-none bg-surface border border-border rounded-lg pl-3 pr-7 py-1.5 text-xs focus:outline-none focus:border-accent cursor-pointer"
          >
            {SIGNAL_TYPES.map(o => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
          <ChevronDown size={11} className="absolute right-2 top-1/2 -translate-y-1/2 text-muted pointer-events-none" />
        </div>

        {/* Status */}
        <div className="relative">
          <select
            value={filterStatus}
            onChange={e => setFilterStatus(e.target.value)}
            className="appearance-none bg-surface border border-border rounded-lg pl-3 pr-7 py-1.5 text-xs focus:outline-none focus:border-accent cursor-pointer"
          >
            {STATUS_OPTIONS.map(o => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
          <ChevronDown size={11} className="absolute right-2 top-1/2 -translate-y-1/2 text-muted pointer-events-none" />
        </div>

        <span className="text-xs text-muted ml-auto">
          {signals.length} signal{signals.length !== 1 ? 's' : ''}
        </span>
      </div>

      {/* Signal list */}
      {loading ? (
        <div className="space-y-3">
          {[1, 2, 3].map(i => (
            <div key={i} className="h-32 bg-surface border border-border rounded-xl animate-pulse" />
          ))}
        </div>
      ) : signals.length === 0 ? (
        <div className="flex-1 flex flex-col items-center justify-center py-20 text-center">
          <Zap size={36} className="text-muted/20 mb-4" />
          <p className="text-muted font-semibold">No signals yet</p>
          <p className="text-xs text-muted/50 mt-1 max-w-xs">
            Create an event, ingest your fighters, then click "Scan Event" to run intelligence on the card.
          </p>
        </div>
      ) : (
        <div className="space-y-3 pb-6">
          {signals.map(signal => (
            <SignalCard
              key={signal.id}
              signal={signal}
              onApprove={handleApprove}
              onReject={handleReject}
              onDelete={handleDelete}
              onPush={handlePush}
            />
          ))}
        </div>
      )}
    </div>
  );
};

export default NewsPage;
