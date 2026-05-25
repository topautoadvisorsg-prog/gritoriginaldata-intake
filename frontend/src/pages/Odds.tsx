import { useState, useEffect } from 'react';
import { TrendingUp, RefreshCcw, CheckCircle, XCircle, Trash2, ChevronDown } from 'lucide-react';
import { getOdds, triggerOddsPull, approveOdds, rejectOdds, deleteOdds } from '../api';
import { ApiKeyPanel, type KeyDef } from '../components/ApiKeyPanel';

const ODDS_KEYS: KeyDef[] = [
  {
    name: 'BRAVE_API_KEY',
    label: 'Brave Search API Key',
    required: false,
    description: 'Used by Agent 6 as a fallback odds source when primary scrapers fail. Get it at search.brave.com/search/api.',
    placeholder: 'BSA...',
  },
];

const STATUS_FILTERS = ['all', 'staging', 'approved', 'rejected'];

const statusStyle: Record<string, string> = {
  staging:  'bg-gold/10 text-gold border-gold/30',
  approved: 'bg-green/10 text-green border-green/30',
  rejected: 'bg-accent/10 text-accent border-accent/30',
};

const Odds = () => {
  const [odds, setOdds] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [pulling, setPulling] = useState(false);
  const [filter, setFilter] = useState('staging');

  const fetchOdds = async () => {
    setLoading(true);
    try {
      const res = await getOdds(filter === 'all' ? undefined : filter);
      setOdds(res.data);
    } catch {
      setOdds([]);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { fetchOdds(); }, [filter]);

  const handlePull = async () => {
    setPulling(true);
    try {
      await triggerOddsPull();
      setTimeout(fetchOdds, 1500);
    } finally {
      setPulling(false);
    }
  };

  const handleApprove = async (id: string) => {
    await approveOdds(id);
    fetchOdds();
  };

  const handleReject = async (id: string) => {
    await rejectOdds(id);
    fetchOdds();
  };

  const handleDelete = async (id: string) => {
    if (!confirm('Delete this odds record?')) return;
    await deleteOdds(id);
    fetchOdds();
  };

  const getFighterNames = (row: any) => {
    const fights = row.event_fights;
    if (!fights) return { a: '—', b: '—' };
    const a = fights['fighters!event_fights_fighter_a_id_fkey']?.name ?? '—';
    const b = fights['fighters!event_fights_fighter_b_id_fkey']?.name ?? '—';
    return { a, b };
  };

  return (
    <div className="space-y-8">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-3xl font-bold flex items-center gap-3">
            <TrendingUp className="text-accent" size={28} />
            Betting Odds
          </h2>
          <p className="text-muted text-sm mt-1">Agent 6 — scraped from BestFightOdds &amp; Covers.com</p>
        </div>
        <div className="flex gap-3">
          <button
            onClick={fetchOdds}
            className="bg-surface border border-border p-2.5 rounded-lg hover:bg-white/5 transition-colors"
            title="Refresh"
          >
            <RefreshCcw size={18} className={loading ? 'animate-spin text-muted' : 'text-muted'} />
          </button>
          <button
            onClick={handlePull}
            disabled={pulling}
            className="flex items-center gap-2 bg-accent hover:bg-accent/90 text-white px-5 py-2.5 rounded-lg font-bold text-sm transition-colors disabled:opacity-50"
          >
            <TrendingUp size={16} />
            {pulling ? 'Pulling...' : 'Pull Odds Now'}
          </button>
        </div>
      </div>

      {/* Filter tabs */}
      <div className="flex gap-2">
        {STATUS_FILTERS.map(f => (
          <button
            key={f}
            onClick={() => setFilter(f)}
            className={`px-4 py-2 rounded-lg text-sm font-bold uppercase tracking-wide border transition-colors ${
              filter === f
                ? 'bg-accent/10 border-accent/40 text-accent'
                : 'bg-surface border-border text-muted hover:text-text'
            }`}
          >
            {f}
          </button>
        ))}
      </div>

      {/* Table */}
      <div className="bg-surface border border-border rounded-xl overflow-hidden">
        {loading ? (
          <div className="p-12 text-center text-muted">
            <RefreshCcw size={24} className="animate-spin mx-auto mb-3 text-accent" />
            Loading odds...
          </div>
        ) : odds.length === 0 ? (
          <div className="p-16 text-center">
            <TrendingUp size={40} className="mx-auto mb-4 text-muted/30" />
            <p className="text-muted">No odds found for this filter.</p>
            <p className="text-muted/60 text-sm mt-1">Click "Pull Odds Now" to trigger Agent 6.</p>
          </div>
        ) : (
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="border-b border-border bg-bg text-muted text-[10px] uppercase tracking-[0.15em]">
                <th className="px-5 py-4">Matchup</th>
                <th className="px-5 py-4">Fighter A</th>
                <th className="px-5 py-4">Fighter B</th>
                <th className="px-5 py-4">KO/TKO</th>
                <th className="px-5 py-4">Sub</th>
                <th className="px-5 py-4">Dec</th>
                <th className="px-5 py-4">Source</th>
                <th className="px-5 py-4">Status</th>
                <th className="px-5 py-4">Pulled</th>
                <th className="px-5 py-4 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {odds.map((row: any) => {
                const { a, b } = getFighterNames(row);
                return (
                  <tr key={row.id} className="hover:bg-white/[0.03] transition-colors">
                    <td className="px-5 py-4 font-bold text-xs text-muted">
                      {row.event_fights?.weight_class ?? '—'}
                    </td>
                    <td className="px-5 py-4">
                      <div className="font-bold">{a}</div>
                      <div className="text-gold font-mono text-xs mt-0.5">{row.fighter_a_line}</div>
                    </td>
                    <td className="px-5 py-4">
                      <div className="font-bold">{b}</div>
                      <div className="text-gold font-mono text-xs mt-0.5">{row.fighter_b_line}</div>
                    </td>
                    <td className="px-5 py-4 font-mono text-xs text-muted">{row.method_ko_tko ?? '—'}</td>
                    <td className="px-5 py-4 font-mono text-xs text-muted">{row.method_submission ?? '—'}</td>
                    <td className="px-5 py-4 font-mono text-xs text-muted">{row.method_decision ?? '—'}</td>
                    <td className="px-5 py-4 text-xs text-muted">{row.source ?? '—'}</td>
                    <td className="px-5 py-4">
                      <span className={`px-2 py-1 rounded border text-[10px] uppercase font-black tracking-widest ${statusStyle[row.status] ?? 'bg-border text-muted border-border'}`}>
                        {row.status}
                      </span>
                    </td>
                    <td className="px-5 py-4 text-xs text-muted font-mono">
                      {new Date(row.pulled_at).toLocaleDateString()}
                    </td>
                    <td className="px-5 py-4">
                      <div className="flex items-center gap-2 justify-end">
                        {row.status === 'staging' && (
                          <>
                            <button
                              onClick={() => handleApprove(row.id)}
                              title="Approve"
                              className="p-1.5 rounded hover:bg-green/20 text-muted hover:text-green transition-colors"
                            >
                              <CheckCircle size={16} />
                            </button>
                            <button
                              onClick={() => handleReject(row.id)}
                              title="Reject"
                              className="p-1.5 rounded hover:bg-accent/20 text-muted hover:text-accent transition-colors"
                            >
                              <XCircle size={16} />
                            </button>
                          </>
                        )}
                        <button
                          onClick={() => handleDelete(row.id)}
                          title="Delete"
                          className="p-1.5 rounded hover:bg-accent/10 text-muted hover:text-accent transition-colors"
                        >
                          <Trash2 size={16} />
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
      {/* API Key Config */}
      <ApiKeyPanel keys={ODDS_KEYS} agentLabel="Agent 6 — Betting Odds" />
    </div>
  );
};

export default Odds;
