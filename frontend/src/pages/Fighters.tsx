import { useState, useEffect, useCallback } from 'react';
import { Link } from 'react-router-dom';
import { Search, ShieldCheck, ShieldAlert, Trash2, CheckCircle, XCircle, AlertTriangle } from 'lucide-react';
import api, { getFighters } from '../api';

type Filter = 'all' | 'verified' | 'unverified';

interface Fighter {
  id: string;
  first_name: string;
  last_name: string;
  nickname: string | null;
  weight_class: string;
  wins: number;
  losses: number;
  draws: number | null;
  image_url: string | null;
  admin_status: string | null;
  is_verified: boolean;
  verified_at?: string | null;
  stance: string | null;
  nationality: string | null;
  gym: string | null;
}

// ── Bulk Delete Confirmation Modal ─────────────────────────────────────────────
const BulkDeleteModal = ({
  count,
  onConfirm,
  onCancel,
  loading,
}: {
  count: number;
  onConfirm: () => void;
  onCancel: () => void;
  loading: boolean;
}) => (
  <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4">
    <div className="bg-surface border border-red-500/30 rounded-2xl p-8 max-w-md w-full shadow-2xl">
      <div className="flex items-center gap-3 mb-4">
        <div className="w-10 h-10 bg-red-500/10 rounded-full flex items-center justify-center">
          <Trash2 className="text-red-400" size={20} />
        </div>
        <div>
          <h2 className="font-black text-lg">Bulk Delete Unverified</h2>
          <p className="text-xs text-muted">This cannot be undone</p>
        </div>
      </div>

      <div className="bg-red-500/5 border border-red-500/20 rounded-xl p-4 mb-6">
        <p className="text-sm text-red-300 font-semibold mb-2">
          You are about to delete <span className="text-red-400 font-black">{count} unverified fighter{count !== 1 ? 's' : ''}</span>
        </p>
        <p className="text-xs text-muted">
          This will also permanently delete all associated fight history records.
        </p>
      </div>

      <div className="flex gap-3">
        <button
          onClick={onCancel}
          className="flex-1 py-2.5 border border-border rounded-lg text-sm font-semibold text-muted hover:text-text hover:border-text/30 transition-colors"
        >
          Cancel
        </button>
        <button
          onClick={onConfirm}
          disabled={loading}
          className="flex-1 py-2.5 bg-red-600 rounded-lg text-sm font-bold text-white hover:bg-red-500 disabled:opacity-50 disabled:cursor-not-allowed transition-colors flex items-center justify-center gap-2"
        >
          {loading ? (
            <>
              <div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
              Deleting...
            </>
          ) : (
            <>
              <Trash2 size={15} />
              Delete {count} Fighter{count !== 1 ? 's' : ''}
            </>
          )}
        </button>
      </div>
    </div>
  </div>
);

// ── Fighter Card ───────────────────────────────────────────────────────────────
const FighterCard = ({
  fighter,
  onVerify,
  onPush,
  verifying,
}: {
  fighter: Fighter;
  onVerify: (id: string, val: boolean) => void;
  onPush: (id: string) => void;
  verifying: string | null;
}) => {
  const isVerifying = verifying === fighter.id;
  const canPush = fighter.is_verified && fighter.admin_status === 'approved';

  return (
    <div className={`bg-surface/30 backdrop-blur-sm rounded-xl border transition-all duration-300 group hover:scale-[1.01] hover:shadow-2xl hover:shadow-accent/5 ${
      fighter.is_verified ? 'border-accent/20 hover:border-accent/40' : 'border-border hover:border-accent/20'
    }`}>
      {/* Clickable image + info → detail page */}
      <Link to={`/fighters/${fighter.id}`} className="block relative">
        {/* Image Slot */}
        <div className="h-48 bg-bg/50 relative overflow-hidden">
          {fighter.image_url ? (
            <img
              src={fighter.image_url}
              alt={`${fighter.first_name} ${fighter.last_name}`}
              className="w-full h-full object-cover object-top opacity-80 group-hover:opacity-100 group-hover:scale-105 transition-all duration-500"
            />
          ) : (
            <div className="w-full h-full flex items-center justify-center text-6xl font-black text-muted/5 bg-gradient-to-b from-surface to-bg">
              {fighter.first_name?.charAt(0) ?? '?'}
            </div>
          )}
          
          {/* Overlay Gradient */}
          <div className="absolute inset-0 bg-gradient-to-t from-bg via-transparent to-transparent opacity-60" />

          {/* Verification badge — Floating Left */}
          <div className="absolute top-4 left-4">
            {fighter.is_verified ? (
              <div className="flex items-center gap-1.5 px-2.5 py-1 bg-accent/90 backdrop-blur-md rounded-md text-[9px] font-black uppercase tracking-tighter text-black shadow-lg">
                <ShieldCheck size={11} fill="currentColor" />
                Verified
              </div>
            ) : (
              <div className="flex items-center gap-1.5 px-2.5 py-1 bg-surface/80 backdrop-blur-md border border-white/5 rounded-md text-[9px] font-black uppercase tracking-tighter text-muted/80">
                <ShieldAlert size={11} />
                Audit Required
              </div>
            )}
          </div>

          {/* Admin Status — Floating Right */}
          {fighter.admin_status === 'approved' && (
            <div className="absolute top-4 right-4 flex items-center gap-1 px-2.5 py-1 bg-green-500/80 backdrop-blur-md rounded-md text-[9px] font-black uppercase tracking-tighter text-white shadow-lg">
              <CheckCircle size={10} fill="currentColor" />
              Approved
            </div>
          )}
        </div>

        {/* Info */}
        <div className="px-5 py-4">
          <div className="text-[10px] uppercase tracking-[0.2em] text-accent/60 font-black mb-1">{fighter.weight_class}</div>
          <div className="font-extrabold text-lg leading-tight group-hover:text-accent transition-colors tracking-tight">
            {fighter.first_name} <span className="text-white/90">{fighter.last_name}</span>
          </div>
          <div className="flex items-end justify-between mt-3">
            <div className="text-sm font-black tabular-nums tracking-widest flex items-center gap-2">
              <span className="text-accent">{fighter.wins}</span>
              <span className="text-white/10 font-thin italic">/</span>
              <span className="text-white/40">{fighter.losses}</span>
              <span className="text-white/10 font-thin italic">/</span>
              <span className="text-white/20">{fighter.draws ?? 0}</span>
            </div>
            {fighter.nickname && (
              <div className="text-[10px] text-muted/40 uppercase font-bold italic truncate max-w-[80px]">“{fighter.nickname}”</div>
            )}
          </div>
        </div>
      </Link>

      {/* Actions */}
      <div className="px-5 pb-5 flex gap-2">
        <button
          onClick={() => onVerify(fighter.id, !fighter.is_verified)}
          disabled={isVerifying}
          className={`flex-1 py-2.5 rounded-lg text-[10px] font-black uppercase tracking-widest border transition-all active:scale-95 flex items-center justify-center gap-2 ${
            fighter.is_verified
              ? 'border-red-500/20 text-red-400/70 hover:bg-red-500/10 hover:text-red-400 hover:border-red-500/40'
              : 'border-accent/20 text-accent/70 hover:bg-accent/10 hover:text-accent hover:border-accent/40'
          } disabled:opacity-20`}
        >
          {isVerifying ? (
            <div className="w-3 h-3 border-2 border-white/20 border-t-accent rounded-full animate-spin" />
          ) : fighter.is_verified ? (
            <><XCircle size={12} /> Unverify</>
          ) : (
            <><CheckCircle size={12} /> Verify</>
          )}
        </button>

        <button
          onClick={() => onPush(fighter.id)}
          disabled={!canPush}
          className="flex-none px-4 py-2.5 rounded-lg text-[10px] font-black uppercase tracking-widest border border-white/5 bg-white/5 text-muted hover:bg-white/10 hover:text-white disabled:opacity-10 transition-all active:scale-95"
        >
          Push
        </button>
      </div>
    </div>
  );
};

// ── Main Component ─────────────────────────────────────────────────────────────
const Fighters = () => {
  const [fighters, setFighters] = useState<Fighter[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<Filter>('all');
  const [search, setSearch] = useState('');
  const [verifying, setVerifying] = useState<string | null>(null);
  const [showDeleteModal, setShowDeleteModal] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [toast, setToast] = useState<{ msg: string; type: 'success' | 'error' } | null>(null);

  const showToast = useCallback((msg: string, type: 'success' | 'error' = 'success') => {
    setToast({ msg, type });
    setTimeout(() => setToast(null), 3500);
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params: any = {};
      if (filter !== 'all') params.verified = filter === 'verified' ? 'true' : 'false';
      const res = await api.get('/fighters', { params });
      setFighters(res.data);
    } catch {
      showToast('Failed to load fighters', 'error');
    } finally {
      setLoading(false);
    }
  }, [filter, showToast]);

  useEffect(() => { load(); }, [load]);

  const handleVerify = async (id: string, val: boolean) => {
    setVerifying(id);
    try {
      await api.patch(`/fighters/${id}/verify`, { is_verified: val });
      setFighters(prev =>
        prev.map(f => f.id === id ? { ...f, is_verified: val } : f)
      );
      showToast(val ? 'Fighter verified ✅' : 'Verification removed');
    } catch {
      showToast('Failed to update verification', 'error');
    } finally {
      setVerifying(null);
    }
  };

  const handlePush = async (id: string) => {
    try {
      await api.post(`/pipeline/push/fighter/${id}`);
      showToast('Fighter pushed to GRIT ✅');
    } catch (e: any) {
      showToast('Push failed: ' + (e?.response?.data?.detail || e.message), 'error');
    }
  };

  const handleBulkDelete = async () => {
    setDeleting(true);
    try {
      const res = await api.delete('/fighters/unverified', {
        data: { confirm: 'DELETE_UNVERIFIED' },
      });
      setShowDeleteModal(false);
      showToast(res.data.message || 'Deleted unverified fighters');
      load();
    } catch (e: any) {
      showToast('Delete failed: ' + (e?.response?.data?.detail || e.message), 'error');
    } finally {
      setDeleting(false);
    }
  };

  // Client-side search filter
  const visible = fighters.filter(f => {
    if (!search.trim()) return true;
    const q = search.toLowerCase();
    return (
      `${f.first_name} ${f.last_name}`.toLowerCase().includes(q) ||
      (f.nickname || '').toLowerCase().includes(q) ||
      (f.weight_class || '').toLowerCase().includes(q)
    );
  });

  const verifiedCount   = fighters.filter(f => f.is_verified).length;
  const unverifiedCount = fighters.filter(f => !f.is_verified).length;

  const FILTERS: { key: Filter; label: string; count: number }[] = [
    { key: 'all',        label: 'All',        count: fighters.length },
    { key: 'verified',   label: 'Verified',   count: verifiedCount },
    { key: 'unverified', label: 'Unverified', count: unverifiedCount },
  ];

  return (
    <div className="space-y-6">
      {/* Toast */}
      {toast && (
        <div className={`fixed top-6 right-6 z-50 flex items-center gap-3 px-4 py-3 rounded-xl shadow-xl text-sm font-semibold border ${
          toast.type === 'success'
            ? 'bg-green-500/10 border-green-500/30 text-green-300'
            : 'bg-red-500/10 border-red-500/30 text-red-300'
        }`}>
          {toast.type === 'success' ? <CheckCircle size={16} /> : <AlertTriangle size={16} />}
          {toast.msg}
        </div>
      )}

      {/* Delete modal */}
      {showDeleteModal && (
        <BulkDeleteModal
          count={unverifiedCount}
          onConfirm={handleBulkDelete}
          onCancel={() => setShowDeleteModal(false)}
          loading={deleting}
        />
      )}

      {/* Header */}
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-black tracking-tight">Fighters</h1>
          <p className="text-muted text-sm mt-1">
            <span className="text-green-400 font-bold">{verifiedCount} verified</span>
            <span className="text-muted mx-2">·</span>
            <span className="text-muted/60">{unverifiedCount} unverified</span>
          </p>
        </div>
        {unverifiedCount > 0 && (
          <button
            onClick={() => setShowDeleteModal(true)}
            className="flex items-center gap-2 px-4 py-2 bg-red-600/10 border border-red-500/30 rounded-lg text-sm font-bold text-red-400 hover:bg-red-600/20 transition-colors"
          >
            <Trash2 size={15} />
            Delete Unverified ({unverifiedCount})
          </button>
        )}
      </div>

      {/* Filters + Search */}
      <div className="flex items-center gap-3 flex-wrap">
        {/* Filter tabs */}
        <div className="flex bg-surface border border-border rounded-lg p-1 gap-1">
          {FILTERS.map(({ key, label, count }) => (
            <button
              key={key}
              onClick={() => setFilter(key)}
              className={`px-3 py-1.5 rounded-md text-xs font-bold transition-colors ${
                filter === key
                  ? 'bg-accent text-white'
                  : 'text-muted hover:text-text'
              }`}
            >
              {label}
              <span className={`ml-1.5 ${filter === key ? 'text-white/70' : 'text-muted/50'}`}>
                {count}
              </span>
            </button>
          ))}
        </div>

        {/* Search */}
        <div className="relative flex-1 max-w-xs">
          <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted" />
          <input
            type="text"
            placeholder="Search fighters..."
            value={search}
            onChange={e => setSearch(e.target.value)}
            className="w-full bg-surface border border-border rounded-lg py-2 pl-9 pr-3 text-sm focus:outline-none focus:border-accent"
          />
        </div>

        <p className="text-xs text-muted ml-auto">
          {visible.length} fighter{visible.length !== 1 ? 's' : ''}
        </p>
      </div>

      {/* Grid */}
      {loading ? (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-5">
          {[1, 2, 3, 4, 5, 6, 7, 8].map(i => (
            <div key={i} className="h-72 bg-surface rounded-xl border border-border animate-pulse" />
          ))}
        </div>
      ) : visible.length === 0 ? (
        <div className="border border-dashed border-border/30 rounded-2xl p-16 text-center">
          <ShieldAlert size={32} className="text-muted/20 mx-auto mb-3" />
          <p className="text-muted font-semibold">No fighters found</p>
          <p className="text-xs text-muted/40 mt-1">
            {filter === 'verified' ? 'No verified fighters yet — verify some fighters first'
             : filter === 'unverified' ? 'All fighters are verified 🎉'
             : 'No fighters in the database yet'}
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-5">
          {visible.map(f => (
            <FighterCard
              key={f.id}
              fighter={f}
              onVerify={handleVerify}
              onPush={handlePush}
              verifying={verifying}
            />
          ))}
        </div>
      )}
    </div>
  );
};

export default Fighters;
