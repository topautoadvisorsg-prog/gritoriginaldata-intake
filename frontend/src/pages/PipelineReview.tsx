import { useState, useEffect, useCallback } from 'react';
import {
  CheckCircle, XCircle, Clock, Activity, AlertTriangle, Users,
  TrendingUp, RefreshCcw, ChevronRight, X, Edit2, Save,
  RotateCcw, Image, Search,
} from 'lucide-react';
import {
  getReviewCounts, getReviewFighters, getReviewFighter,
  approveFighter, rejectFighter, restoreFighter, editFighter,
  getReviewNews, approveNews, rejectNews,
  getOdds, approveOdds, rejectOdds,
  getNeedsAttention, getActivityLog,
} from '../api';

// ── Types ─────────────────────────────────────────────────────────────────────

// Loosely-shaped rows from the review API — fields vary by ingestion source.
type Fighter = Record<string, any>;
type NewsItem = Record<string, any>;
type OddsItem = Record<string, unknown>;
type FightBout  = Record<string, unknown>;
type LogEntry   = Record<string, unknown>;

type Counts = {
  pending:  { fighters: number; news: number; odds: number };
  approved: { fighters: number; news: number; odds: number };
  rejected: { fighters: number; news: number; odds: number };
  needs_attention: number;
  today:    { pushed: number; approved: number; rejected: number };
  last_activity: string | null;
};

type PreviewRecord =
  | { kind: 'fighter'; data: Fighter; history: FightBout[] }
  | { kind: 'news';    data: NewsItem }
  | { kind: 'odds';    data: OddsItem };

// ── Helpers ───────────────────────────────────────────────────────────────────

function ts(iso: unknown): string {
  if (!iso) return '—';
  try { return new Date(iso as string).toLocaleString(); } catch { return String(iso); }
}
function relTime(iso: unknown): string {
  if (!iso) return '—';
  try {
    const diff = (Date.now() - new Date(iso as string).getTime()) / 1000;
    if (diff < 60)    return `${Math.round(diff)}s ago`;
    if (diff < 3600)  return `${Math.round(diff / 60)}m ago`;
    if (diff < 86400) return `${Math.round(diff / 3600)}h ago`;
    return `${Math.round(diff / 86400)}d ago`;
  } catch { return '—'; }
}

const STAT = ({ label, value, sub, loading }: { label: string; value: string | number; sub?: string; loading?: boolean }) => (
  <div className="bg-surface border border-border rounded-xl px-5 py-3.5 flex flex-col gap-0.5">
    <div className="text-[10px] text-muted uppercase font-black tracking-widest">{label}</div>
    {loading ? (
      <div className="h-7 w-10 bg-border/40 rounded animate-pulse mt-0.5" />
    ) : (
      <div className="text-2xl font-black leading-none">{value}</div>
    )}
    {sub && <div className="text-[11px] text-muted">{sub}</div>}
  </div>
);

// ── Record Row (shared between tabs) ──────────────────────────────────────────

function FighterRow({
  f, onPreview, onApprove, onReject, onRestore, status,
}: {
  f: Fighter;
  onPreview: (f: Fighter) => void;
  onApprove?: (id: string) => void;
  onReject?:  (id: string) => void;
  onRestore?: (id: string) => void;
  status: string;
}) {
  const name = `${f.first_name ?? ''} ${f.last_name ?? ''}`.trim() || '—';
  return (
    <div className="flex items-center gap-3 px-4 py-3 bg-surface border border-border rounded-xl hover:border-accent/40 transition-colors group">
      {/* Photo */}
      <div className="w-10 h-10 rounded-lg overflow-hidden bg-bg border border-border shrink-0">
        {f.image_url && !(f.image_url as string).includes('placeholder') ? (
          <img src={f.image_url as string} alt={name} className="w-full h-full object-cover" />
        ) : (
          <div className="w-full h-full flex items-center justify-center text-muted"><Users size={16} /></div>
        )}
      </div>
      {/* Info */}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="font-bold text-sm truncate">{name}</span>
          {f.nickname && <span className="text-muted text-xs truncate">"{f.nickname as string}"</span>}
          {f.needs_image && <span className="text-[10px] bg-gold/10 text-gold px-1.5 rounded font-bold">NO PHOTO</span>}
        </div>
        <div className="text-[11px] text-muted mt-0.5 flex items-center gap-2">
          <span>{(f.weight_class as string) || 'Unknown class'}</span>
          {f.nationality && <><span>·</span><span>{f.nationality as string}</span></>}
          {f.created_at && <><span>·</span><span>{relTime(f.created_at)}</span></>}
        </div>
      </div>
      <div className="flex flex-col items-end gap-1 shrink-0 px-4">
        <div className="text-xs font-black text-white tabular-nums">
          {`${f.wins ?? 0}–${f.losses ?? 0}–${f.draws ?? 0}`}
        </div>
        {f.is_verified ? (
          <div className="flex items-center gap-1 text-[9px] font-black uppercase tracking-tighter text-green-400">
            <CheckCircle size={10} /> Ready
          </div>
        ) : (
          <div className="flex items-center gap-1 text-[9px] font-black uppercase tracking-tighter text-red-400/60">
            <AlertTriangle size={10} /> Pending
          </div>
        )}
      </div>
      {/* Actions */}
      <div className="flex items-center gap-2 shrink-0">
        <button
          onClick={() => onPreview(f)}
          className="text-muted hover:text-text transition-colors p-1.5 rounded-lg hover:bg-white/5"
          title="Preview"
        >
          <ChevronRight size={16} />
        </button>
        {onApprove && status !== 'approved' && (
          <button
            onClick={() => onApprove(f.id as string)}
            className="text-green hover:text-green/80 transition-colors p-1.5 rounded-lg hover:bg-green/10"
            title="Approve & push"
          >
            <CheckCircle size={16} />
          </button>
        )}
        {onReject && status !== 'rejected' && (
          <button
            onClick={() => onReject(f.id as string)}
            className="text-accent hover:text-accent/80 transition-colors p-1.5 rounded-lg hover:bg-accent/10"
            title="Reject"
          >
            <XCircle size={16} />
          </button>
        )}
        {onRestore && status === 'rejected' && (
          <button
            onClick={() => onRestore(f.id as string)}
            className="text-gold hover:text-gold/80 transition-colors p-1.5 rounded-lg hover:bg-gold/10"
            title="Restore to pending"
          >
            <RotateCcw size={16} />
          </button>
        )}
      </div>
    </div>
  );
}

function NewsRow({
  n, onPreview, onApprove, onReject, status,
}: {
  n: NewsItem;
  onPreview: (n: NewsItem) => void;
  onApprove?: (id: string) => void;
  onReject?: (id: string) => void;
  status: string;
}) {
  const isIntel = (n.layer as string) === 'intelligence';
  return (
    <div className="flex items-start gap-3 px-4 py-3 bg-surface border border-border rounded-xl hover:border-accent/40 transition-colors">
      <div className={`shrink-0 mt-0.5 px-1.5 py-0.5 rounded text-[10px] font-black uppercase tracking-wider ${isIntel ? 'bg-accent/10 text-accent' : 'bg-white/5 text-muted'}`}>
        {isIntel ? 'INTEL' : 'NEWS'}
      </div>
      <div className="flex-1 min-w-0">
        <div className="font-bold text-sm leading-tight truncate">{((n.headline || n.title) as string) || 'Untitled'}</div>
        <div className="text-[11px] text-muted mt-0.5">{relTime(n.published_at || n.created_at)}</div>
      </div>
      <div className="flex items-center gap-2 shrink-0">
        <button onClick={() => onPreview(n)} className="text-muted hover:text-text transition-colors p-1.5 rounded-lg hover:bg-white/5"><ChevronRight size={16} /></button>
        {onApprove && status !== 'approved' && (
          <button onClick={() => onApprove(n.id as string)} className="text-green hover:text-green/80 p-1.5 rounded-lg hover:bg-green/10"><CheckCircle size={16} /></button>
        )}
        {onReject && status !== 'rejected' && (
          <button onClick={() => onReject(n.id as string)} className="text-accent hover:text-accent/80 p-1.5 rounded-lg hover:bg-accent/10"><XCircle size={16} /></button>
        )}
      </div>
    </div>
  );
}

function OddsRow({ o, onApprove, onReject, status }: { o: OddsItem; onApprove?: (id: string) => void; onReject?: (id: string) => void; status: string }) {
  const f1 = (o as Record<string, unknown>)['event_fights'] as Record<string, unknown> | undefined;
  const matchup = f1
    ? `${(f1['fighters!event_fights_fighter1_id_fkey'] as Record<string, unknown> | undefined)?.last_name ?? '?'} vs ${(f1['fighters!event_fights_fighter2_id_fkey'] as Record<string, unknown> | undefined)?.last_name ?? '?'}`
    : 'Unknown matchup';
  return (
    <div className="flex items-center gap-3 px-4 py-3 bg-surface border border-border rounded-xl hover:border-accent/40 transition-colors">
      <TrendingUp size={15} className="text-gold shrink-0" />
      <div className="flex-1 min-w-0">
        <div className="font-bold text-sm">{matchup}</div>
        <div className="text-[11px] text-muted mt-0.5">
          {o.fighter1_ml != null ? `${(o.fighter1_ml as number) > 0 ? '+' : ''}${o.fighter1_ml}` : '?'}
          {' / '}
          {o.fighter2_ml != null ? `${(o.fighter2_ml as number) > 0 ? '+' : ''}${o.fighter2_ml}` : '?'}
          {o.source && <> · {o.source as string}</>}
          {o.pulled_at && <> · {relTime(o.pulled_at)}</>}
        </div>
      </div>
      <div className="flex items-center gap-2 shrink-0">
        {onApprove && status !== 'approved' && (
          <button onClick={() => onApprove(o.id as string)} className="text-green hover:text-green/80 p-1.5 rounded-lg hover:bg-green/10"><CheckCircle size={16} /></button>
        )}
        {onReject && status !== 'rejected' && (
          <button onClick={() => onReject(o.id as string)} className="text-accent hover:text-accent/80 p-1.5 rounded-lg hover:bg-accent/10"><XCircle size={16} /></button>
        )}
      </div>
    </div>
  );
}

// ── Fighter Preview Panel ──────────────────────────────────────────────────────

function FighterPreviewPanel({
  fighterId,
  onClose,
  onApprove,
  onReject,
  status,
}: {
  fighterId: string;
  onClose: () => void;
  onApprove: (id: string) => void;
  onReject: (id: string) => void;
  status: string;
}) {
  const [data, setData]       = useState<{ fighter: Fighter; fight_history: FightBout[] } | null>(null);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState(false);
  const [edits, setEdits]     = useState<Record<string, string>>({});
  const [saving, setSaving]   = useState(false);

  useEffect(() => {
    getReviewFighter(fighterId)
      .then(r => { setData(r.data); setLoading(false); })
      .catch(() => setLoading(false));
  }, [fighterId]);

  const handleSave = async () => {
    if (!data || !Object.keys(edits).length) { setEditing(false); return; }
    setSaving(true);
    try {
      await editFighter(fighterId, edits);
      setData(prev => prev ? { ...prev, fighter: { ...prev.fighter, ...edits } } : prev);
      setEditing(false);
      setEdits({});
    } finally { setSaving(false); }
  };

  const f = data?.fighter;
  const history = data?.fight_history ?? [];

  const STAT_ROW = (label: string, key: string) => (
    <div className="flex items-center justify-between py-1.5 border-b border-border/50">
      <span className="text-[11px] text-muted uppercase tracking-wide">{label}</span>
      {editing ? (
        <input
          className="text-sm font-medium bg-bg border border-border rounded-lg px-2 py-0.5 w-40 text-right"
          defaultValue={(f?.[key] as string) ?? ''}
          onChange={e => setEdits(prev => ({ ...prev, [key]: e.target.value }))}
        />
      ) : (
        <span className="text-sm font-medium">{(f?.[key] as string) || '—'}</span>
      )}
    </div>
  );

  return (
    <div className="fixed inset-0 z-50 flex">
      <div className="flex-1 bg-black/60 backdrop-blur-sm" onClick={onClose} />
      <div className="w-[640px] h-full bg-bg border-l border-border overflow-y-auto flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-border sticky top-0 bg-bg z-10">
          <div className="flex items-center gap-3">
            <span className="text-[10px] font-black uppercase tracking-widest text-muted bg-white/5 px-2 py-1 rounded">
              FIGHTER PREVIEW
            </span>
            {f && (
              <span className={`text-[10px] font-black uppercase px-2 py-1 rounded ${
                status === 'approved' ? 'bg-green/10 text-green' :
                status === 'rejected' ? 'bg-accent/10 text-accent' :
                'bg-gold/10 text-gold'
              }`}>{status}</span>
            )}
          </div>
          <button onClick={onClose} className="text-muted hover:text-text transition-colors"><X size={18} /></button>
        </div>

        {loading ? (
          <div className="flex-1 flex items-center justify-center text-muted text-sm">Loading…</div>
        ) : !f ? (
          <div className="flex-1 flex items-center justify-center text-muted text-sm">Fighter not found</div>
        ) : (
          <div className="flex-1 p-6 space-y-6">
            {/* Identity */}
            <div className="flex gap-5">
              <div className="w-24 h-28 rounded-xl overflow-hidden bg-surface border border-border shrink-0">
                {f.image_url && !(f.image_url as string).includes('placeholder') ? (
                  <img src={f.image_url as string} alt="headshot" className="w-full h-full object-cover" />
                ) : (
                  <div className="w-full h-full flex flex-col items-center justify-center gap-1 text-muted">
                    <Image size={20} />
                    <span className="text-[9px] font-bold">NO PHOTO</span>
                  </div>
                )}
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-3 mb-1">
                  <h2 className="text-3xl font-black italic tracking-tighter text-white uppercase leading-none truncate">
                    {(f.first_name as string) || ''} <span className="text-accent">{(f.last_name as string) || ''}</span>
                  </h2>
                  {f.is_verified ? (
                    <div className="bg-green-500/20 border border-green-500/30 rounded-full px-2 py-0.5 flex items-center gap-1.5 shrink-0">
                      <div className="w-1 h-1 rounded-full bg-green-500 animate-pulse" />
                      <span className="text-[9px] font-black uppercase tracking-widest text-green-400 leading-none">Ready</span>
                    </div>
                  ) : (
                    <div className="bg-red-500/10 border border-red-500/20 rounded-full px-2 py-0.5 flex items-center gap-1.5 shrink-0">
                      <div className="w-1 h-1 rounded-full bg-red-500" />
                      <span className="text-[9px] font-black uppercase tracking-widest text-red-400/60 leading-none">Audit</span>
                    </div>
                  )}
                </div>
                {f.nickname && <p className="text-muted text-sm font-black italic tracking-tight opacity-40">"{(f.nickname as string)}"</p>}
                
                <div className="flex items-center gap-4 mt-4">
                  <div className="flex flex-col">
                    <span className="text-2xl font-black text-white tabular-nums leading-none tracking-tight">{f.wins as number ?? 0}</span>
                    <span className="text-[8px] font-black uppercase tracking-widest text-green-500/80 mt-1">Wins</span>
                  </div>
                  <div className="w-px h-6 bg-white/10" />
                  <div className="flex flex-col">
                    <span className="text-2xl font-black text-white/60 tabular-nums leading-none tracking-tight">{f.losses as number ?? 0}</span>
                    <span className="text-[8px] font-black uppercase tracking-widest text-red-500/80 mt-1">Losses</span>
                  </div>
                  <div className="w-px h-6 bg-white/10" />
                  <div className="flex flex-col">
                    <span className="text-2xl font-black text-white/30 tabular-nums leading-none tracking-tight">{f.draws as number ?? 0}</span>
                    <span className="text-[8px] font-black uppercase tracking-widest text-muted mt-1">Draws</span>
                  </div>
                </div>

                <div className="flex flex-wrap gap-1.5 mt-4">
                  {f.weight_class && (
                    <span className="text-[10px] bg-white/5 border border-white/10 text-accent px-2 py-0.5 rounded-md font-black uppercase tracking-widest">
                      {f.weight_class as string}
                    </span>
                  )}
                  {f.organization && (
                    <span className="text-[10px] bg-white/5 border border-white/10 text-muted px-2 py-0.5 rounded-md font-black uppercase tracking-widest">
                      {f.organization as string}
                    </span>
                  )}
                </div>
              </div>
            </div>

            {/* Edit toggle */}
            <div className="flex justify-end gap-2">
              {editing ? (
                <>
                  <button
                    onClick={() => { setEditing(false); setEdits({}); }}
                    className="text-xs text-muted border border-border px-3 py-1.5 rounded-lg hover:bg-white/5 transition-colors"
                  >Cancel</button>
                  <button
                    onClick={handleSave}
                    disabled={saving}
                    className="text-xs bg-accent text-white px-3 py-1.5 rounded-lg hover:bg-accent/80 transition-colors flex items-center gap-1.5 disabled:opacity-50"
                  ><Save size={12} />{saving ? 'Saving…' : 'Save Changes'}</button>
                </>
              ) : (
                <button
                  onClick={() => setEditing(true)}
                  className="text-xs text-muted border border-border px-3 py-1.5 rounded-lg hover:bg-white/5 transition-colors flex items-center gap-1.5"
                ><Edit2 size={12} />Edit Fields</button>
              )}
            </div>

            {/* Personal stats */}
            <div className="bg-surface border border-border rounded-xl p-4 space-y-0">
              <div className="text-[10px] font-black uppercase tracking-widest text-muted mb-2">PROFILE</div>
              {STAT_ROW('Date of Birth', 'date_of_birth')}
              {STAT_ROW('Nationality', 'nationality')}
              {STAT_ROW('Height (in)', 'height_in')}
              {STAT_ROW('Reach (in)', 'reach_in')}
              {STAT_ROW('Stance', 'stance')}
              {STAT_ROW('Gym', 'gym')}
              {STAT_ROW('Team', 'team')}
              {STAT_ROW('Head Coach', 'head_coach')}
              {STAT_ROW('Fighting Out Of', 'fighting_out_of')}
              {STAT_ROW('Status', 'status')}
              {STAT_ROW('Twitter', 'twitter_handle')}
              {STAT_ROW('Instagram', 'instagram_handle')}
            </div>

            {/* Performance */}
            <div className="bg-surface border border-border rounded-xl p-4">
              <div className="text-[10px] font-black uppercase tracking-widest text-muted mb-3">PERFORMANCE</div>
              <div className="grid grid-cols-3 gap-3">
                {[
                  ['KO Wins', 'ko_wins'], ['Sub Wins', 'submission_wins'], ['Dec Wins', 'decision_wins'],
                  ['KO Loss', 'losses_by_ko'], ['Sub Loss', 'losses_by_submission'], ['Dec Loss', 'losses_by_decision'],
                  ['Str Lnd/Min', 'strikes_landed_per_min'], ['Str Acc', 'strike_accuracy'], ['Str Abs/Min', 'strikes_absorbed_per_min'],
                  ['Str Def', 'strike_defense'], ['TD Avg', 'takedown_avg'], ['TD Acc', 'takedown_accuracy'],
                  ['TD Def', 'takedown_defense'], ['Sub Avg', 'submission_avg'],
                ].map(([label, key]) => (
                  <div key={key} className="bg-bg border border-border rounded-lg p-2.5 text-center">
                    <div className="text-[9px] text-muted uppercase font-bold tracking-wider">{label}</div>
                    <div className="text-sm font-black mt-0.5">{(f[key] as string) ?? '—'}</div>
                  </div>
                ))}
              </div>
            </div>

            {/* AI Brief */}
            {f.bio && (
              <div className="bg-surface border border-border rounded-xl p-4">
                <div className="text-[10px] font-black uppercase tracking-widest text-muted mb-2">AI BRIEF</div>
                <p className="text-sm text-muted leading-relaxed whitespace-pre-wrap">{f.bio as string}</p>
              </div>
            )}

            {/* Fight history */}
            {history.length > 0 && (
              <div className="bg-surface border border-border rounded-xl p-4">
                <div className="text-[10px] font-black uppercase tracking-widest text-muted mb-3">
                  FIGHT HISTORY ({history.length})
                </div>
                <div className="space-y-1">
                  {history.map((bout, i) => {
                    const res = (bout.result as string)?.toLowerCase();
                    const resColor = res === 'win' ? 'text-green' : res === 'loss' ? 'text-accent' : 'text-muted';
                    return (
                      <div key={i} className="flex items-center gap-2 py-1.5 border-b border-border/40 last:border-0 text-xs">
                        <span className={`font-black w-8 uppercase ${resColor}`}>{res?.slice(0, 1).toUpperCase() ?? '?'}</span>
                        <span className="flex-1 font-medium truncate">{(bout.opponent_name as string) || '—'}</span>
                        <span className="text-muted truncate max-w-[100px]">{(bout.method as string) || '—'}</span>
                        <span className="text-muted w-14 text-right">{(bout.event_date as string)?.slice(0, 7) ?? '—'}</span>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            {/* Source links */}
            <div className="flex gap-3">
              {f.sherdog_url && (
                <a href={f.sherdog_url as string} target="_blank" rel="noreferrer"
                   className="text-xs text-accent hover:underline">Sherdog ↗</a>
              )}
              {f.tapology_url && (
                <a href={f.tapology_url as string} target="_blank" rel="noreferrer"
                   className="text-xs text-accent hover:underline">Tapology ↗</a>
              )}
            </div>

            {/* Action buttons */}
            <div className="flex gap-3 pt-2">
              {status !== 'approved' && (
                <button
                  onClick={() => { onApprove(fighterId); onClose(); }}
                  className="flex-1 bg-green-500/10 hover:bg-green-500/20 text-green-400 border border-green-500/30 font-black text-[10px] uppercase tracking-widest py-3 rounded-xl transition-colors flex items-center justify-center gap-2"
                >
                  <CheckCircle size={16} />Approve & Push to GRIT
                </button>
              )}
              {status !== 'rejected' && (
                <button
                  onClick={() => { onReject(fighterId); onClose(); }}
                  className="flex-1 bg-red-500/10 hover:bg-red-500/20 text-red-400 border border-red-500/30 font-black text-[10px] uppercase tracking-widest py-3 rounded-xl transition-colors flex items-center justify-center gap-2"
                >
                  <XCircle size={16} />Reject
                </button>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ── News Preview Panel ─────────────────────────────────────────────────────────

function NewsPreviewPanel({
  news, onClose, onApprove, onReject, status,
}: {
  news: NewsItem;
  onClose: () => void;
  onApprove: (id: string) => void;
  onReject: (id: string) => void;
  status: string;
}) {
  const isIntel = (news.layer as string) === 'intelligence';
  const tags = (news.tags as string[] | undefined) ?? [];

  return (
    <div className="fixed inset-0 z-50 flex">
      <div className="flex-1 bg-black/60 backdrop-blur-sm" onClick={onClose} />
      <div className="w-[600px] h-full bg-bg border-l border-border overflow-y-auto flex flex-col">
        <div className="flex items-center justify-between px-6 py-4 border-b border-border sticky top-0 bg-bg z-10">
          <div className="flex items-center gap-2">
            <span className={`text-[10px] font-black uppercase px-2 py-1 rounded ${isIntel ? 'bg-accent/10 text-accent' : 'bg-white/5 text-muted'}`}>
              {isIntel ? 'INTELLIGENCE' : 'STANDARD NEWS'}
            </span>
          </div>
          <button onClick={onClose} className="text-muted hover:text-text"><X size={18} /></button>
        </div>
        <div className="flex-1 p-6 space-y-5">
          <h2 className="text-xl font-black leading-snug">{((news.headline || news.title) as string) || 'Untitled'}</h2>
          <div className="text-[11px] text-muted">{ts(news.published_at || news.created_at)}</div>
          {tags.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {tags.map((t, i) => (
                <span key={i} className="text-[10px] bg-accent/10 text-accent px-2 py-0.5 rounded-full font-bold">{t}</span>
              ))}
            </div>
          )}
          {(news.summary || news.content) && (
            <div className="bg-surface border border-border rounded-xl p-4">
              <p className="text-sm text-muted leading-relaxed whitespace-pre-wrap">{((news.summary || news.content) as string)}</p>
            </div>
          )}
          {news.source_url && (
            <a href={news.source_url as string} target="_blank" rel="noreferrer"
               className="text-xs text-accent hover:underline block">Source ↗</a>
          )}
          <div className="flex gap-3 pt-2">
            {status !== 'approved' && (
              <button onClick={() => { onApprove(news.id as string); onClose(); }}
                className="flex-1 bg-green/10 hover:bg-green/20 text-green border border-green/20 font-bold py-3 rounded-xl transition-colors flex items-center justify-center gap-2">
                <CheckCircle size={16} />Approve
              </button>
            )}
            {status !== 'rejected' && (
              <button onClick={() => { onReject(news.id as string); onClose(); }}
                className="flex-1 bg-accent/10 hover:bg-accent/20 text-accent border border-accent/20 font-bold py-3 rounded-xl transition-colors flex items-center justify-center gap-2">
                <XCircle size={16} />Reject
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Tab: Pending Review ────────────────────────────────────────────────────────

function PendingTab({ onPreview }: { onPreview: (r: PreviewRecord) => void }) {
  const [fighters, setFighters] = useState<Fighter[]>([]);
  const [news,     setNews]     = useState<NewsItem[]>([]);
  const [odds,     setOdds]     = useState<OddsItem[]>([]);
  const [section,  setSection]  = useState<'fighters'|'news'|'odds'>('fighters');
  const [busy,     setBusy]     = useState<Record<string, boolean>>({});

  const load = useCallback(async () => {
    const [f, n, o] = await Promise.allSettled([
      getReviewFighters('pending'),
      getReviewNews('pending'),
      getOdds('staging'),
    ]);
    if (f.status === 'fulfilled') setFighters(f.value.data);
    if (n.status === 'fulfilled') setNews(n.value.data);
    if (o.status === 'fulfilled') setOdds(o.value.data);
  }, []);

  useEffect(() => { load(); }, [load]);

  const act = async (fn: () => Promise<unknown>, id: string, cb: () => void) => {
    setBusy(b => ({ ...b, [id]: true }));
    try { await fn(); cb(); } finally { setBusy(b => ({ ...b, [id]: false })); }
  };

  const handleApproveFighter = (id: string) =>
    act(() => approveFighter(id), id, () => setFighters(fs => fs.filter(f => f.id !== id)));
  const handleRejectFighter = (id: string) =>
    act(() => rejectFighter(id), id, () => setFighters(fs => fs.filter(f => f.id !== id)));
  const handleApproveNews = (id: string) =>
    act(() => approveNews(id), id, () => setNews(ns => ns.filter(n => n.id !== id)));
  const handleRejectNews = (id: string) =>
    act(() => rejectNews(id), id, () => setNews(ns => ns.filter(n => n.id !== id)));
  const handleApproveOdds = (id: string) =>
    act(() => approveOdds(id), id, () => setOdds(os => os.filter(o => o.id !== id)));
  const handleRejectOdds = (id: string) =>
    act(() => rejectOdds(id), id, () => setOdds(os => os.filter(o => o.id !== id)));

  const PILL = (key: typeof section, label: string, count: number) => (
    <button
      onClick={() => setSection(key)}
      className={`px-3 py-1.5 rounded-lg text-xs font-bold transition-colors flex items-center gap-1.5 ${
        section === key ? 'bg-accent/10 text-accent' : 'text-muted hover:text-text hover:bg-white/5'
      }`}
    >
      {label}
      <span className="bg-white/10 px-1.5 py-0.5 rounded text-[10px]">{count}</span>
    </button>
  );

  return (
    <div className="space-y-4">
      <div className="flex gap-2">
        {PILL('fighters', 'Fighters', fighters.length)}
        {PILL('news',     'News',     news.length)}
        {PILL('odds',     'Odds',     odds.length)}
      </div>

      {section === 'fighters' && (
        <div className="space-y-2">
          {fighters.length === 0 ? (
            <Empty label="No pending fighters" />
          ) : fighters.map(f => (
            <FighterRow
              key={f.id as string}
              f={f}
              status="pending"
              onPreview={f => onPreview({ kind: 'fighter', data: f, history: [] })}
              onApprove={busy[f.id as string] ? undefined : handleApproveFighter}
              onReject={busy[f.id as string] ? undefined : handleRejectFighter}
            />
          ))}
        </div>
      )}
      {section === 'news' && (
        <div className="space-y-2">
          {news.length === 0 ? (
            <Empty label="No pending news" />
          ) : news.map(n => (
            <NewsRow
              key={n.id as string}
              n={n}
              status="pending"
              onPreview={n => onPreview({ kind: 'news', data: n })}
              onApprove={busy[n.id as string] ? undefined : handleApproveNews}
              onReject={busy[n.id as string] ? undefined : handleRejectNews}
            />
          ))}
        </div>
      )}
      {section === 'odds' && (
        <div className="space-y-2">
          {odds.length === 0 ? (
            <Empty label="No pending odds" />
          ) : odds.map(o => (
            <OddsRow
              key={o.id as string}
              o={o}
              status="staging"
              onApprove={busy[o.id as string] ? undefined : handleApproveOdds}
              onReject={busy[o.id as string] ? undefined : handleRejectOdds}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// ── Tab: Activity Log ──────────────────────────────────────────────────────────

const STATUS_DOT: Record<string, string> = {
  success: 'bg-green',
  failed:  'bg-accent',
  skipped: 'bg-gold',
};
const AGENT_LABEL: Record<string, string> = {
  'Agent 1': 'A1', 'Agent 2': 'A2', 'Agent 3': 'A3',
  'Agent 4': 'A4', 'Agent 6': 'A6', 'Agent 7': 'A7',
  'Admin': 'AD', 'System': 'SYS',
};

function ActivityLogTab() {
  const [entries, setEntries] = useState<LogEntry[]>([]);
  const [search,  setSearch]  = useState('');
  const [filterAgent,  setFilterAgent]  = useState('');
  const [filterStatus, setFilterStatus] = useState('');
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    const params: Record<string, string> = { limit: '200' };
    if (filterAgent)  params.agent_name = filterAgent;
    if (filterStatus) params.status     = filterStatus;
    if (search)       params.search     = search;
    try {
      const r = await getActivityLog(params);
      setEntries(r.data);
    } finally { setLoading(false); }
  }, [search, filterAgent, filterStatus]);

  useEffect(() => { load(); }, [load]);

  return (
    <div className="space-y-4">
      {/* Filters */}
      <div className="flex gap-3 flex-wrap">
        <div className="relative">
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted" />
          <input
            className="bg-surface border border-border rounded-xl pl-8 pr-3 py-2 text-sm focus:outline-none focus:border-accent transition-colors w-52"
            placeholder="Search fighter / event…"
            value={search}
            onChange={e => setSearch(e.target.value)}
          />
        </div>
        <select
          className="bg-surface border border-border rounded-xl px-3 py-2 text-sm focus:outline-none focus:border-accent transition-colors"
          value={filterAgent}
          onChange={e => setFilterAgent(e.target.value)}
        >
          <option value="">All Agents</option>
          {['Agent 1','Agent 2','Agent 3','Agent 4','Agent 6','Agent 7','Admin','System'].map(a => (
            <option key={a} value={a}>{a}</option>
          ))}
        </select>
        <select
          className="bg-surface border border-border rounded-xl px-3 py-2 text-sm focus:outline-none focus:border-accent transition-colors"
          value={filterStatus}
          onChange={e => setFilterStatus(e.target.value)}
        >
          <option value="">All Statuses</option>
          <option value="success">Success</option>
          <option value="failed">Failed</option>
          <option value="skipped">Skipped</option>
        </select>
        <button onClick={load} className="bg-surface border border-border rounded-xl px-3 py-2 text-muted hover:text-text transition-colors">
          <RefreshCcw size={14} />
        </button>
      </div>

      {loading ? (
        <div className="text-sm text-muted">Loading…</div>
      ) : entries.length === 0 ? (
        <Empty label="No activity yet. Run the pipeline to see logs here." />
      ) : (
        <div className="space-y-1">
          {entries.map((e, i) => (
            <div key={i} className="flex items-start gap-3 px-4 py-2.5 bg-surface border border-border rounded-xl text-xs">
              <div className={`mt-1.5 w-1.5 h-1.5 rounded-full shrink-0 ${STATUS_DOT[(e.status as string)] ?? 'bg-border'}`} />
              <div className="w-8 shrink-0">
                <span className="font-black text-muted text-[10px]">{AGENT_LABEL[e.agent_name as string] ?? (e.agent_name as string)?.slice(0, 3)}</span>
              </div>
              <div className="flex-1 min-w-0">
                <span className="font-bold capitalize">{e.action as string}</span>
                {e.entity_name && <span className="text-muted ml-1.5">{e.entity_name as string}</span>}
                {e.detail && <div className="text-muted mt-0.5 truncate">{e.detail as string}</div>}
              </div>
              <div className="text-muted shrink-0">{relTime(e.created_at)}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Tab: Approved ──────────────────────────────────────────────────────────────

function ApprovedTab({ onPreview }: { onPreview: (r: PreviewRecord) => void }) {
  const [fighters, setFighters] = useState<Fighter[]>([]);
  const [news, setNews]         = useState<NewsItem[]>([]);
  const [odds, setOdds]         = useState<OddsItem[]>([]);
  const [section, setSection]   = useState<'fighters'|'news'|'odds'>('fighters');

  useEffect(() => {
    Promise.allSettled([
      getReviewFighters('approved'),
      getReviewNews('approved'),
      getOdds('approved'),
    ]).then(([f, n, o]) => {
      if (f.status === 'fulfilled') setFighters(f.value.data);
      if (n.status === 'fulfilled') setNews(n.value.data);
      if (o.status === 'fulfilled') setOdds(o.value.data);
    });
  }, []);

  const PILL = (key: typeof section, label: string, count: number) => (
    <button onClick={() => setSection(key)}
      className={`px-3 py-1.5 rounded-lg text-xs font-bold transition-colors flex items-center gap-1.5 ${section === key ? 'bg-green/10 text-green' : 'text-muted hover:text-text hover:bg-white/5'}`}>
      {label}<span className="bg-white/10 px-1.5 py-0.5 rounded text-[10px]">{count}</span>
    </button>
  );

  return (
    <div className="space-y-4">
      <div className="flex gap-2">
        {PILL('fighters','Fighters',fighters.length)}
        {PILL('news','News',news.length)}
        {PILL('odds','Odds',odds.length)}
      </div>
      {section === 'fighters' && (
        <div className="space-y-2">
          {fighters.length === 0 ? <Empty label="No approved fighters yet" /> :
            fighters.map(f => (
              <FighterRow key={f.id as string} f={f} status="approved"
                onPreview={f => onPreview({ kind: 'fighter', data: f, history: [] })} />
            ))}
        </div>
      )}
      {section === 'news' && (
        <div className="space-y-2">
          {news.length === 0 ? <Empty label="No approved news yet" /> :
            news.map(n => (
              <NewsRow key={n.id as string} n={n} status="approved"
                onPreview={n => onPreview({ kind: 'news', data: n })} />
            ))}
        </div>
      )}
      {section === 'odds' && (
        <div className="space-y-2">
          {odds.length === 0 ? <Empty label="No approved odds yet" /> :
            odds.map(o => <OddsRow key={o.id as string} o={o} status="approved" />)}
        </div>
      )}
    </div>
  );
}

// ── Tab: Rejected ──────────────────────────────────────────────────────────────

function RejectedTab({ onPreview }: { onPreview: (r: PreviewRecord) => void }) {
  const [fighters, setFighters] = useState<Fighter[]>([]);
  const [news, setNews]         = useState<NewsItem[]>([]);
  const [odds, setOdds]         = useState<OddsItem[]>([]);
  const [section, setSection]   = useState<'fighters'|'news'|'odds'>('fighters');

  useEffect(() => {
    Promise.allSettled([
      getReviewFighters('rejected'),
      getReviewNews('rejected'),
      getOdds('rejected'),
    ]).then(([f, n, o]) => {
      if (f.status === 'fulfilled') setFighters(f.value.data);
      if (n.status === 'fulfilled') setNews(n.value.data);
      if (o.status === 'fulfilled') setOdds(o.value.data);
    });
  }, []);

  const handleRestore = async (id: string) => {
    await restoreFighter(id);
    setFighters(fs => fs.filter(f => f.id !== id));
  };

  const PILL = (key: typeof section, label: string, count: number) => (
    <button onClick={() => setSection(key)}
      className={`px-3 py-1.5 rounded-lg text-xs font-bold transition-colors flex items-center gap-1.5 ${section === key ? 'bg-accent/10 text-accent' : 'text-muted hover:text-text hover:bg-white/5'}`}>
      {label}<span className="bg-white/10 px-1.5 py-0.5 rounded text-[10px]">{count}</span>
    </button>
  );

  return (
    <div className="space-y-4">
      <div className="flex gap-2">
        {PILL('fighters','Fighters',fighters.length)}
        {PILL('news','News',news.length)}
        {PILL('odds','Odds',odds.length)}
      </div>
      {section === 'fighters' && (
        <div className="space-y-2">
          {fighters.length === 0 ? <Empty label="No rejected fighters" /> :
            fighters.map(f => (
              <FighterRow key={f.id as string} f={f} status="rejected"
                onPreview={f => onPreview({ kind: 'fighter', data: f, history: [] })}
                onRestore={handleRestore} />
            ))}
        </div>
      )}
      {section === 'news' && (
        <div className="space-y-2">
          {news.length === 0 ? <Empty label="No rejected news" /> :
            news.map(n => <NewsRow key={n.id as string} n={n} status="rejected"
              onPreview={n => onPreview({ kind: 'news', data: n })} />)}
        </div>
      )}
      {section === 'odds' && (
        <div className="space-y-2">
          {odds.length === 0 ? <Empty label="No rejected odds" /> :
            odds.map(o => <OddsRow key={o.id as string} o={o} status="rejected" />)}
        </div>
      )}
    </div>
  );
}

// ── Tab: Needs Attention ───────────────────────────────────────────────────────

function NeedsAttentionTab() {
  const [data, setData] = useState<{ needs_image: Fighter[] }>({ needs_image: [] });

  useEffect(() => {
    getNeedsAttention().then(r => setData(r.data)).catch(() => {});
  }, []);

  return (
    <div className="space-y-6">
      {data.needs_image.length > 0 && (
        <div className="space-y-3">
          <h3 className="text-sm font-black uppercase tracking-widest text-muted flex items-center gap-2">
            <Image size={14} className="text-gold" />No Photo ({data.needs_image.length})
          </h3>
          <div className="space-y-2">
            {data.needs_image.map(f => (
              <div key={f.id as string} className="flex items-center gap-3 px-4 py-3 bg-surface border border-border rounded-xl">
                <AlertTriangle size={14} className="text-gold shrink-0" />
                <div className="flex-1">
                  <span className="font-bold text-sm">{(f.first_name as string) || ''} {(f.last_name as string) || ''}</span>
                  <span className="text-muted text-xs ml-2">{(f.weight_class as string) || ''}</span>
                </div>
                <span className="text-[10px] bg-gold/10 text-gold px-2 py-0.5 rounded font-bold">NEEDS PHOTO</span>
              </div>
            ))}
          </div>
        </div>
      )}
      {data.needs_image.length === 0 && (
        <Empty label="Nothing needs attention. All records are in good shape." />
      )}
    </div>
  );
}

// ── Empty State ────────────────────────────────────────────────────────────────

function Empty({ label }: { label: string }) {
  return (
    <div className="py-14 text-center text-muted text-sm border border-dashed border-border rounded-xl">
      {label}
    </div>
  );
}

// ── Main Page ──────────────────────────────────────────────────────────────────

type Tab = 'pending' | 'log' | 'approved' | 'rejected' | 'attention';

export default function PipelineReview() {
  const [activeTab, setActiveTab] = useState<Tab>('pending');
  const [counts, setCounts]       = useState<Counts | null>(null);
  const [countsLoading, setCountsLoading] = useState(true);
  const [preview, setPreview]     = useState<PreviewRecord | null>(null);
  const [lastUpdated, setLastUpdated] = useState<Date>(new Date());

  const loadCounts = useCallback(async () => {
    try {
      const r = await getReviewCounts();
      setCounts(r.data);
      setLastUpdated(new Date());
    } catch {} finally {
      setCountsLoading(false);
    }
  }, []);

  useEffect(() => {
    loadCounts();
    const t = setInterval(loadCounts, 30000);
    return () => clearInterval(t);
  }, [loadCounts]);

  const totalPending = (counts?.pending.fighters ?? 0) + (counts?.pending.news ?? 0) + (counts?.pending.odds ?? 0);
  const totalApproved = (counts?.approved.fighters ?? 0) + (counts?.approved.news ?? 0) + (counts?.approved.odds ?? 0);
  const totalRejected = (counts?.rejected.fighters ?? 0) + (counts?.rejected.news ?? 0) + (counts?.rejected.odds ?? 0);
  const needsAttention = counts?.needs_attention ?? 0;

  const TAB = (key: Tab, label: string, icon: React.ReactNode, badge?: number, badgeColor?: string) => (
    <button
      onClick={() => setActiveTab(key)}
      className={`flex items-center gap-2 px-4 py-2.5 border-b-2 text-sm font-bold transition-colors ${
        activeTab === key
          ? 'border-accent text-text'
          : 'border-transparent text-muted hover:text-text'
      }`}
    >
      {icon}{label}
      {badge !== undefined && badge > 0 && (
        <span className={`text-[10px] px-1.5 py-0.5 rounded-full font-black ${badgeColor ?? 'bg-white/10 text-muted'}`}>
          {badge}
        </span>
      )}
    </button>
  );

  // Build preview-aware approve/reject for FighterPreviewPanel
  const handleApproveFromPreview = async (id: string) => {
    await approveFighter(id);
    setPreview(null);
    loadCounts();
  };
  const handleRejectFromPreview = async (id: string) => {
    await rejectFighter(id);
    setPreview(null);
    loadCounts();
  };

  return (
    <div className="space-y-8">
      {/* Page header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-black">Pipeline Review</h1>
          <p className="text-muted text-sm mt-1">Review every record before it goes live. Nothing publishes without your approval.</p>
        </div>
        <div className="flex items-center gap-3 text-xs text-muted">
          <span>Updated {relTime(lastUpdated)}</span>
          <button onClick={loadCounts} className="p-2 hover:bg-white/5 rounded-lg transition-colors">
            <RefreshCcw size={14} />
          </button>
        </div>
      </div>

      {/* Global stats bar */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
        <STAT label="Pending Review"  value={totalPending}                   sub="awaiting decision" loading={countsLoading} />
        <STAT label="Pushed Today"    value={counts?.today.pushed ?? 0}      sub="sent to GRIT"     loading={countsLoading} />
        <STAT label="Approved Today"  value={counts?.today.approved ?? 0}    sub="approved"         loading={countsLoading} />
        <STAT label="Rejected Today"  value={counts?.today.rejected ?? 0}    sub="rejected"         loading={countsLoading} />
        <STAT label="Total Approved"  value={totalApproved}                  sub="all time"         loading={countsLoading} />
        <STAT label="Needs Attention" value={needsAttention}                 sub="action required"  loading={countsLoading} />
      </div>

      {/* Tab bar */}
      <div className="border-b border-border flex gap-0 overflow-x-auto">
        {TAB('pending',   'Pending Review', <Clock size={15} />,       totalPending,   'bg-gold/20 text-gold')}
        {TAB('log',       'Activity Log',   <Activity size={15} />)}
        {TAB('approved',  'Approved',       <CheckCircle size={15} />, totalApproved,  'bg-green/20 text-green')}
        {TAB('rejected',  'Rejected',       <XCircle size={15} />,     totalRejected,  'bg-accent/20 text-accent')}
        {TAB('attention', 'Needs Attention',<AlertTriangle size={15} />,needsAttention,'bg-gold/20 text-gold')}
      </div>

      {/* Tab content */}
      <div>
        {activeTab === 'pending'   && <PendingTab   onPreview={setPreview} />}
        {activeTab === 'log'       && <ActivityLogTab />}
        {activeTab === 'approved'  && <ApprovedTab  onPreview={setPreview} />}
        {activeTab === 'rejected'  && <RejectedTab  onPreview={setPreview} />}
        {activeTab === 'attention' && <NeedsAttentionTab />}
      </div>

      {/* Preview panels */}
      {preview?.kind === 'fighter' && (
        <FighterPreviewPanel
          fighterId={preview.data.id as string}
          status={(preview.data.admin_status as string) ?? 'pending'}
          onClose={() => setPreview(null)}
          onApprove={handleApproveFromPreview}
          onReject={handleRejectFromPreview}
        />
      )}
      {preview?.kind === 'news' && (
        <NewsPreviewPanel
          news={preview.data}
          status={(preview.data.admin_status as string) ?? 'pending'}
          onClose={() => setPreview(null)}
          onApprove={async id => { await approveNews(id); setPreview(null); loadCounts(); }}
          onReject={async id => { await rejectNews(id); setPreview(null); loadCounts(); }}
        />
      )}
    </div>
  );
}
