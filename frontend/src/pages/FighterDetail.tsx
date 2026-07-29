import { useState, useEffect } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import {
  ArrowLeft, ShieldCheck, ShieldAlert, CheckCircle, XCircle,
  AlertTriangle, Upload, Send, Clock, Swords, User, Zap, ChevronRight
} from 'lucide-react';
import api from '../api';

interface Fighter {
  id: string;
  first_name: string;
  last_name: string;
  nickname: string | null;
  gender: string | null;
  nationality: string | null;
  date_of_birth: string | null;
  weight_class: string;
  height_inch: number | null;
  reach_inch: number | null;
  stance: string | null;
  gym: string | null;
  head_coach: string | null;
  fighting_out_of: string | null;
  organization: string | null;
  ranking: number | null;
  is_active: boolean;
  is_champion: boolean;
  wins: number;
  losses: number;
  draws: number;
  nc: number | null;
  ko_wins: number | null;
  tko_wins: number | null;
  sub_wins: number | null;
  dec_wins: number | null;
  losses_by_ko: number | null;
  losses_by_submission: number | null;
  losses_by_decision: number | null;
  slpm: number | null;
  sapm: number | null;
  strike_accuracy: number | null;
  strike_defense: number | null;
  takedown_avg: number | null;
  takedown_accuracy: number | null;
  takedown_defense: number | null;
  submission_avg: number | null;
  image_url: string | null;
  body_image_url: string | null;
  is_verified: boolean;
  admin_status: string | null;
  notes: string | null;
  bio: string | null;
  created_at: string | null;
}

interface Bout {
  id: string;
  opponent_name: string | null;
  result: string | null;
  method: string | null;
  method_detail: string | null;
  round: number | null;
  time: string | null;
  event_name: string | null;
  event_date: string | null;
  title_fight: boolean | null;
  weight_class: string | null;
}

const fmtDate = (v: string | null) => {
  if (!v) return '—';
  const d = new Date(v);
  if (isNaN(d.getTime())) return v;
  return d.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
};

const fmt = (v: any, suffix = '') =>
  v === null || v === undefined ? '—' : `${v}${suffix}`;

const pct = (v: any) =>
  v === null || v === undefined ? '—' : `${Math.round(Number(v) * 100)}%`;

const StatCell = ({ label, value, subValue }: { label: string; value: string; subValue?: string }) => (
  <div className="glass-card rounded-xl p-4 flex flex-col items-center justify-center text-center transition-all hover:border-accent/40 group">
    <div className="text-[10px] uppercase tracking-widest text-accent/50 font-black mb-1 group-hover:text-accent/80 transition-colors">{label}</div>
    <div className="text-xl font-black text-white tabular-nums tracking-tight">{value}</div>
    {subValue && <div className="text-[9px] text-muted font-bold mt-1 uppercase tracking-tighter">{subValue}</div>}
  </div>
);

export default function FighterDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();

  const [fighter, setFighter] = useState<Fighter | null>(null);
  const [history, setHistory] = useState<Bout[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [verifying, setVerifying] = useState(false);
  const [pushing, setPushing] = useState(false);
  const [uploadingHead, setUploadingHead] = useState(false);
  const [uploadingBody, setUploadingBody] = useState(false);
  const [generatingBio, setGeneratingBio] = useState(false);
  const [toast, setToast] = useState<{ msg: string; type: 'success' | 'error' } | null>(null);

  const showToast = (msg: string, type: 'success' | 'error' = 'success') => {
    setToast({ msg, type });
    setTimeout(() => setToast(null), 3500);
  };

  useEffect(() => {
    if (!id) return;
    (async () => {
      try {
        const res = await api.get(`/pipeline/review/fighters/${id}`);
        const raw = res.data.fighter;
        const p = raw.performance || {};
        setFighter({
          ...raw,
          ko_wins:               p.ko_wins   ?? 0,
          tko_wins:              p.tko_wins   ?? 0,
          sub_wins:              p.submission_wins  ?? 0,
          dec_wins:              p.decision_wins    ?? 0,
          losses_by_ko:          p.losses_by_ko         ?? 0,
          losses_by_submission:  p.losses_by_submission ?? 0,
          losses_by_decision:    p.losses_by_decision   ?? 0,
          slpm:                  p.strikes_landed_per_min   ?? null,
          sapm:                  p.strikes_absorbed_per_min ?? null,
          strike_accuracy:       p.strike_accuracy    ?? null,
          strike_defense:        p.strike_defense     ?? null,
          takedown_avg:          p.takedown_avg       ?? null,
          takedown_accuracy:     p.takedown_accuracy  ?? null,
          takedown_defense:      p.takedown_defense   ?? null,
          submission_avg:        p.submission_avg     ?? null,
        });
        setHistory(res.data.fight_history || []);
      } catch (e: any) {
        setError(e?.response?.data?.detail || 'Failed to load fighter');
      } finally {
        setLoading(false);
      }
    })();
  }, [id]);

  const handleVerify = async () => {
    if (!fighter) return;
    const nextVal = !fighter.is_verified;
    setVerifying(true);
    try {
      await api.patch(`/fighters/${fighter.id}/verify`, { is_verified: nextVal });
      setFighter(prev => prev ? { ...prev, is_verified: nextVal } : prev);
      showToast(nextVal ? 'Fighter verified ✅' : 'Verification removed');
    } catch {
      showToast('Failed to update verification', 'error');
    } finally {
      setVerifying(false);
    }
  };

  const handlePush = async () => {
    if (!fighter) return;
    setPushing(true);
    try {
      await api.post(`/pipeline/push/fighter/${fighter.id}`);
      showToast('Fighter pushed to GRIT ✅');
    } catch (e: any) {
      showToast('Push failed: ' + (e?.response?.data?.detail || e.message), 'error');
    } finally {
      setPushing(false);
    }
  };

  const handleGenerateBio = async () => {
    if (!fighter) return;
    setGeneratingBio(true);
    try {
      const res = await api.post(`/fighters/${fighter.id}/generate-bio`);
      setFighter(prev => prev ? { ...prev, bio: res.data.bio } : prev);
      showToast('Bio generated ✅');
    } catch (e: any) {
      showToast('Bio generation failed: ' + (e?.response?.data?.detail || e.message), 'error');
    } finally {
      setGeneratingBio(false);
    }
  };

  const handleDeleteImage = async (type: 'headshot' | 'body_shot') => {
      if (!fighter) return;
      const set = type === 'headshot' ? setUploadingHead : setUploadingBody;
      set(true);
      try {
          await api.delete(`/images/${fighter.id}/${type}`);
          setFighter(prev => {
              if (!prev) return prev;
              return type === 'headshot'
                  ? { ...prev, image_url: null }
                  : { ...prev, body_image_url: null };
          });
          showToast(`${type === 'headshot' ? 'Headshot' : 'Body shot'} removed`);
      } catch (e: any) {
          showToast('Failed to remove image', 'error');
      } finally {
          set(false);
      }
  };

  const handleImageUpload = async (
    type: 'headshot' | 'body_shot',
    file: File,
  ) => {
    if (!fighter) return;
    const set = type === 'headshot' ? setUploadingHead : setUploadingBody;
    set(true);
    try {
      const form = new FormData();
      form.append('image', file);
      form.append('image_type', type);
      const res = await api.post(`/images/upload/${fighter.id}`, form, {
        headers: { 'Content-Type': 'multipart/form-data' },
      });
      const url: string = res.data.url;
      setFighter(prev => {
        if (!prev) return prev;
        return type === 'headshot'
          ? { ...prev, image_url: url }
          : { ...prev, body_image_url: url };
      });
      showToast(`${type === 'headshot' ? 'Headshot' : 'Body shot'} uploaded ✅`);
    } catch (e: any) {
      showToast('Upload failed: ' + (e?.response?.data?.detail || e.message), 'error');
    } finally {
      set(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-[50vh]">
        <div className="w-12 h-12 border-2 border-accent border-t-transparent rounded-full animate-spin glow-accent" />
      </div>
    );
  }

  if (error || !fighter) {
    return (
      <div className="flex flex-col items-center justify-center h-[50vh] gap-4">
        <div className="w-16 h-16 bg-red-500/10 rounded-full flex items-center justify-center">
          <AlertTriangle className="text-red-500" size={32} />
        </div>
        <div className="text-center">
          <p className="text-red-400 font-black text-xl uppercase tracking-tighter">Fighter Not Found</p>
          <p className="text-muted text-sm mt-1">{error || 'The requested fighter profile does not exist or has been removed.'}</p>
        </div>
        <button onClick={() => navigate('/fighters')} className="px-6 py-2 bg-surface border border-border rounded-lg text-sm font-bold text-accent hover:border-accent/40 transition-all active:scale-95">
          ← Return to Directory
        </button>
      </div>
    );
  }

  const canPush = fighter.is_verified && fighter.admin_status === 'approved';

  return (
    <div className="space-y-8 pb-20 animate-in fade-in slide-in-from-bottom-4 duration-700">
      {/* Toast */}
      {toast && (
        <div className={`fixed top-8 right-8 z-50 flex items-center gap-4 px-6 py-4 rounded-2xl shadow-2xl backdrop-blur-xl border ${
          toast.type === 'success'
            ? 'bg-green-500/10 border-green-500/30 text-green-300'
            : 'bg-red-500/10 border-red-500/30 text-red-300'
        }`}>
          {toast.type === 'success' ? <CheckCircle size={20} className="glow-accent" /> : <AlertTriangle size={20} />}
          <span className="font-bold tracking-tight">{toast.msg}</span>
        </div>
      )}

      {/* ── TOP NAV ── */}
      <div className="flex items-center justify-between">
        <Link
          to="/fighters"
          className="group flex items-center gap-2 text-xs font-black uppercase tracking-widest text-muted hover:text-accent transition-all"
        >
          <div className="w-8 h-8 rounded-full border border-border flex items-center justify-center group-hover:border-accent/40 group-hover:bg-accent/5 transition-all">
            <ArrowLeft size={14} />
          </div>
          Back to Directory
        </Link>

        <div className="flex items-center gap-2">
            <div className="text-[10px] uppercase font-black tracking-widest text-muted mr-2">Core Status:</div>
            {fighter.is_verified ? (
                <div className="flex items-center gap-1.5 px-3 py-1 bg-green-500/20 border border-green-500/30 rounded-md text-[10px] font-black uppercase tracking-tighter text-green-400">
                    <ShieldCheck size={12} fill="currentColor" /> Ready for Push
                </div>
            ) : (
                <div className="flex items-center gap-1.5 px-3 py-1 bg-red-500/10 border border-red-500/20 rounded-md text-[10px] font-black uppercase tracking-tighter text-red-400">
                    <ShieldAlert size={12} /> Audit Pending
                </div>
            )}
        </div>
      </div>

      {/* ── HERO HEADER ── */}
      <div className="glass-card rounded-[2rem] overflow-hidden shadow-2xl relative">
        <div className="absolute top-0 right-0 w-1/2 h-full bg-gradient-to-l from-accent/5 via-transparent to-transparent pointer-events-none" />
        
        <div className="flex flex-col md:flex-row items-stretch min-h-[300px]">
          <div className="relative w-full md:w-80 shrink-0 bg-bg/80 flex items-center justify-center overflow-hidden border-r border-white/5 group">
            {fighter.image_url ? (
              <img
                src={fighter.image_url}
                alt={`${fighter.first_name} ${fighter.last_name}`}
                className="w-full h-full object-cover object-top opacity-90 group-hover:opacity-100 group-hover:scale-105 transition-all duration-700"
              />
            ) : (
              <div className="w-full h-full flex items-center justify-center text-8xl font-black text-white/5 select-none font-display">
                {fighter.first_name?.charAt(0)}
              </div>
            )}
            
            {fighter.is_champion && (
              <div className="absolute top-6 left-6 -rotate-12 px-4 py-1.5 bg-accent text-[11px] font-black uppercase tracking-tighter text-black shadow-lg z-10 border border-white/20">
                🏆 Legend Status
              </div>
            )}
          </div>

          <div className="flex-1 p-8 md:p-12 flex flex-col justify-between relative z-10">
            <div>
              <div className="flex flex-col gap-2 mb-6">
                <div className="flex items-center gap-4">
                  <h1 className="text-5xl font-black italic tracking-tighter text-white uppercase leading-none">
                    {fighter.first_name} <span className="text-accent">{fighter.last_name}</span>
                  </h1>
                </div>
                {fighter.nickname && (
                  <p className="text-xl text-muted font-black italic tracking-tight opacity-40 leading-none">"{fighter.nickname}"</p>
                )}
              </div>

              <p className="text-lg font-bold text-muted flex items-center gap-4 mb-10">
                <span>{fighter.weight_class}</span>
                <span className="w-1.5 h-1.5 rounded-full bg-border" />
                <span className="text-white">
                  {fighter.wins}-{fighter.losses}-{fighter.draws}
                  <span className="text-muted text-sm ml-2">
                    ({fighter.wins_ko} KO, {fighter.wins_sub} SUB)
                  </span>
                </span>
              </p>

              <div className="flex items-center gap-12">
                <div className="flex flex-col">
                  <span className="text-4xl font-black text-white tabular-nums leading-none tracking-tight">{fighter.wins}</span>
                  <span className="text-[10px] font-black uppercase tracking-widest text-green-500/80 mt-2">Victories</span>
                </div>
                <div className="w-px h-10 bg-white/10" />
                <div className="flex flex-col">
                  <span className="text-4xl font-black text-white/60 tabular-nums leading-none tracking-tight">{fighter.losses}</span>
                  <span className="text-[10px] font-black uppercase tracking-widest text-red-500/80 mt-2">Defeats</span>
                </div>
                <div className="w-px h-10 bg-white/10" />
                <div className="flex flex-col">
                  <span className="text-4xl font-black text-white/30 tabular-nums leading-none tracking-tight">{fighter.draws}</span>
                  <span className="text-[10px] font-black uppercase tracking-widest text-muted mt-2">Neutral</span>
                </div>
                {fighter.ranking && (
                  <>
                    <div className="w-px h-10 bg-white/10" />
                    <div className="flex flex-col">
                      <span className="text-4xl font-black text-accent tabular-nums leading-none tracking-tight">#{fighter.ranking}</span>
                      <span className="text-[10px] font-black uppercase tracking-widest text-accent/80 mt-2">Ranked</span>
                    </div>
                  </>
                )}
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* ── ACTION BAR (STICKY) ── */}
      <div className="sticky top-0 z-50 flex items-center justify-between bg-black/60 backdrop-blur-xl border-b border-white/5 px-8 py-4 -mx-8 shadow-2xl">
        <div className="flex items-center gap-6">
          <div className="flex flex-col">
            <span className="text-[10px] font-black uppercase tracking-widest text-muted leading-none">Pipeline Integrity</span>
            <div className="flex items-center gap-2 mt-1">
              {fighter.is_verified ? (
                <CheckCircle size={14} className="text-green-500" />
              ) : (
                <AlertTriangle size={14} className="text-red-500" />
              )}
              <span className={`text-xs font-bold uppercase tracking-tight ${fighter.is_verified ? 'text-green-400' : 'text-red-400'}`}>
                {fighter.is_verified ? 'Verified & Safe to Push' : 'Pending Manual Review'}
              </span>
            </div>
          </div>
          <div className="h-8 w-px bg-white/10" />
          <div className="flex flex-col">
            <span className="text-[10px] font-black uppercase tracking-widest text-muted leading-none">Admin Status</span>
            <span className={`text-xs font-bold mt-1 uppercase italic tracking-tighter ${
                fighter.admin_status === 'approved' ? 'text-green-400' :
                fighter.admin_status === 'rejected' ? 'text-red-400' :
                'text-yellow-400'
            }`}>
              {fighter.admin_status || 'Unprocessed'}
            </span>
          </div>
        </div>
        
        <div className="flex items-center gap-3">
          <button
            onClick={handleVerify}
            disabled={verifying}
            className={`flex items-center gap-2 px-6 py-2.5 rounded-lg font-bold text-xs uppercase tracking-widest transition-all ${
              fighter.is_verified 
                ? 'bg-green-500/20 text-green-400 border border-green-500/30'
                : 'bg-accent text-black hover:scale-105 hover:shadow-[0_0_20px_rgba(255,184,0,0.4)]'
            }`}
          >
            {verifying ? (
              <div className="w-3.5 h-3.5 border-2 border-current border-t-transparent rounded-full animate-spin" />
            ) : fighter.is_verified ? (
              <ShieldCheck size={14} fill="currentColor" />
            ) : (
              <Zap size={14} />
            )}
            {fighter.is_verified ? 'Verified' : 'Verify Profile'}
          </button>
          
          <button
            onClick={handlePush}
            disabled={!canPush || pushing}
            className={`flex items-center gap-2 px-6 py-2.5 rounded-lg font-black text-xs uppercase tracking-widest transition-all shadow-lg ${
              canPush 
                ? 'bg-white text-black hover:bg-accent hover:scale-105' 
                : 'bg-white/5 text-white/20 cursor-not-allowed border border-white/5'
            }`}
          >
            {pushing ? (
              <div className="w-3.5 h-3.5 border-2 border-current border-t-transparent rounded-full animate-spin" />
            ) : (
              <ChevronRight size={14} />
            )}
            Push to Production
          </button>
        </div>
      </div>

      {/* ── GRID CONTENT ── */}
      <div className="grid grid-cols-12 gap-8">
        <div className="col-span-12 lg:col-span-8 space-y-8">
          <div className="glass-card rounded-[2rem] p-8">
            <div className="flex items-center justify-between mb-8">
              <h2 className="text-lg font-black uppercase tracking-tighter flex items-center gap-3 font-display text-white">
                <Swords size={20} className="text-accent" /> Fight Intelligence
              </h2>
              <div className="h-px flex-1 bg-white/5 mx-6" />
              <div className="text-[10px] font-black uppercase tracking-widest text-muted">Core Engine Metrics</div>
            </div>

            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
              <StatCell label="Record Total" value={String(fighter.wins + fighter.losses + fighter.draws + (fighter.nc || 0))} />
              <StatCell label="KO Win %" value={pct(((fighter.ko_wins || 0) + (fighter.tko_wins || 0)) / (fighter.wins || 1))} subValue="Power Index" />
              <StatCell label="Acc" value={pct(fighter.strike_accuracy)} subValue="Precision" />
              <StatCell label="Def" value={pct(fighter.strike_defense)} subValue="Guard" />
            </div>

            <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mt-4">
              <StatCell label="KO Finish" value={fmt((fighter.ko_wins || 0) + (fighter.tko_wins || 0))} />
              <StatCell label="Sub Finish" value={fmt(fighter.sub_wins)} />
              <StatCell label="Dec Control" value={fmt(fighter.dec_wins)} />
              <StatCell label="Reach Index" value={fighter.reach_inch ? `${fighter.reach_inch}"` : "—"} />
            </div>
          </div>

          <div className="glass-card rounded-[2rem] p-8">
            <div className="flex items-center justify-between mb-8">
              <h2 className="text-lg font-black uppercase tracking-tighter flex items-center gap-3 font-display text-white">
                <Clock size={20} className="text-accent" /> Historical Ledger
              </h2>
              <div className="text-[10px] font-black uppercase tracking-widest text-muted">{history.length} Professional Bouts</div>
            </div>

            {history.length === 0 ? (
              <div className="border border-dashed border-white/5 rounded-2xl p-16 text-center bg-bg/20">
                <Swords size={40} className="text-white/5 mx-auto mb-4" />
                <p className="text-muted font-black uppercase tracking-widest text-xs">No Records Found</p>
              </div>
            ) : (
              <div className="space-y-3">
                {history.map((bout, i) => (
                  <div key={bout.id || i} className="flex items-center gap-6 p-5 rounded-2xl border border-white/5 bg-surface/20 hover:bg-white/5 transition-all group">
                    <div className={`w-12 h-12 rounded-xl flex items-center justify-center text-xs font-black uppercase tracking-tighter shadow-lg shrink-0 ${
                      bout.result === 'Win' ? 'bg-accent/10 border border-accent/30 text-accent glow-accent' :
                      bout.result === 'Loss' ? 'bg-red-500/10 border border-red-500/30 text-red-500' :
                      'bg-white/5 border border-white/10 text-muted'
                    }`}>
                      {bout.result === 'Win' ? 'WIN' : bout.result === 'Loss' ? 'LOSS' : 'NC'}
                    </div>

                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <p className="text-base font-black text-white/90 group-hover:text-accent transition-colors truncate tracking-tight">
                          {bout.opponent_name || 'Anonymous Opponent'}
                        </p>
                        {bout.title_fight && <div className="px-2 py-0.5 bg-accent text-[8px] font-black uppercase tracking-tighter text-black rounded">TITLE</div>}
                      </div>
                      <div className="flex items-center gap-3 mt-1">
                        <span className="text-[10px] font-bold text-muted/60 uppercase tracking-widest truncate">{bout.event_name}</span>
                        <div className="w-1 h-1 rounded-full bg-white/10" />
                        <span className="text-[10px] font-bold text-muted/40 tabular-nums">{bout.event_date?.slice(0, 10)}</span>
                      </div>
                    </div>

                    <div className="text-right shrink-0">
                      <p className="text-sm font-black text-white/80 tracking-tight uppercase">{bout.method || '—'}</p>
                      <p className="text-[10px] font-bold text-accent/50 uppercase tracking-widest mt-1">
                        {bout.round ? `Round ${bout.round}` : ''} {bout.time ? ` · ${bout.time}` : ''}
                      </p>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        <div className="col-span-12 lg:col-span-4 space-y-8">
          <div className="glass-card rounded-[2rem] p-8">
            <h3 className="text-xs font-black uppercase tracking-[0.2em] text-accent/60 mb-6 font-display">Technical Profile</h3>
            <div className="space-y-6">
              {[
                ['Nationality', fighter.nationality, true],
                ['Birth Date', fmtDate(fighter.date_of_birth)],
                ['Global Status', fighter.is_active ? 'Active Professional' : 'Inactive/Retired', fighter.is_active],
                ['Current Gym', fighter.gym, true],
                ['Stance', fighter.stance],
                ['Fighting Out Of', fighter.fighting_out_of],
              ].map(([label, value, highlight], i) => (
                <div key={i} className="flex justify-between items-start border-b border-white/5 pb-4 last:border-0 last:pb-0">
                  <span className="text-[10px] font-black uppercase tracking-widest text-muted/50">{label}</span>
                  <span className={`text-sm font-black text-right max-w-[150px] ${highlight ? 'text-white' : 'text-muted/80'}`}>{fmt(value)}</span>
                </div>
              ))}
            </div>
          </div>

          <div className="glass-card rounded-[2rem] p-8">
            <h3 className="text-xs font-black uppercase tracking-[0.2em] text-accent/60 mb-6 font-display">Asset Pipeline</h3>
            <div className="space-y-4">
              <ImageUploadCard label="Profile Headshot" url={fighter.image_url} uploading={uploadingHead} onUpload={f => handleImageUpload('headshot', f)} onClear={() => handleDeleteImage('headshot')} />
              <ImageUploadCard label="Full Body Render" url={fighter.body_image_url} uploading={uploadingBody} onUpload={f => handleImageUpload('body_shot', f)} onClear={() => handleDeleteImage('body_shot')} />
            </div>
          </div>

          <div className="glass-card rounded-[2rem] p-8">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-xs font-black uppercase tracking-[0.2em] text-accent/60 font-display">
                Bio (Public Profile)
              </h3>
              <button
                onClick={handleGenerateBio}
                disabled={generatingBio}
                className="flex items-center gap-1.5 text-[10px] font-black uppercase tracking-wide px-3 py-1.5 rounded-lg bg-accent/10 border border-accent/30 text-accent hover:bg-accent/20 disabled:opacity-40 transition-colors"
              >
                <Zap size={11} className={generatingBio ? 'animate-pulse' : ''} />
                {generatingBio ? 'Writing...' : fighter.bio ? 'Regenerate' : 'Generate Bio'}
              </button>
            </div>
            {fighter.bio ? (
              <p className="text-sm text-muted leading-relaxed">{fighter.bio}</p>
            ) : (
              <p className="text-xs text-muted/40 italic">
                No bio yet — generated from this fighter's record and fight history, shown on their GRIT profile page.
              </p>
            )}
          </div>

          {fighter.notes && (
            <div className="bg-accent/10 border border-accent/20 rounded-[2rem] p-8 relative overflow-hidden group">
              <div className="absolute top-0 right-0 p-4 opacity-5 group-hover:opacity-10 transition-opacity">
                <User size={120} className="text-accent" />
              </div>
              <h3 className="text-[10px] font-black uppercase tracking-[0.3em] text-accent mb-4 relative z-10">AI Intel</h3>
              <p className="text-sm font-semibold text-accent/80 leading-relaxed relative z-10 italic">
                “{fighter.notes}”
              </p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function ImageUploadCard({ label, url, uploading, onUpload, onClear }: { label: string; url: string | null; uploading: boolean; onUpload: (f: File) => void; onClear: () => void }) {
  return (
    <div className="bg-black/40 border border-white/5 rounded-2xl overflow-hidden group border-dashed hover:border-accent/40 transition-all flex flex-col">
      <div className="aspect-[4/5] relative flex items-center justify-center bg-black/20 overflow-hidden">
        {url ? (
          <img src={url} alt={label} className="w-full h-full object-cover group-hover:scale-105 transition-all duration-500" />
        ) : (
          <User size={40} className="text-white/5" />
        )}
        {uploading && (
          <div className="absolute inset-0 bg-black/80 backdrop-blur-sm flex items-center justify-center">
            <div className="w-8 h-8 border-2 border-accent border-t-transparent rounded-full animate-spin glow-accent" />
          </div>
        )}
      </div>
      <div className="flex border-t border-white/5">
          <label className="flex-1 flex items-center justify-center gap-3 py-3 bg-white/5 hover:bg-accent hover:text-black transition-all cursor-pointer">
            <Upload size={14} />
            <span className="text-[10px] font-black uppercase tracking-widest">{url ? 'Replace' : 'Upload'}</span>
            <input type="file" className="hidden" accept="image/*" onChange={e => { const f = e.target.files?.[0]; if (f) onUpload(f); }} />
          </label>
          {url && (
              <button 
                onClick={onClear}
                className="px-4 bg-red-500/10 text-red-500 hover:bg-red-500 hover:text-white transition-all flex items-center justify-center border-l border-white/5"
              >
                  <XCircle size={14} />
              </button>
          )}
      </div>
    </div>
  );
}
