import React, { useState, useCallback, useRef, useEffect } from 'react';
import {
  GitMerge, ChevronRight, CheckCircle, Zap, Search, X, AlertTriangle,
  ChevronUp, ChevronDown, Trash2, Clock, BarChart3, ListChecks,
  XCircle, Edit2, RotateCcw, Upload, FileText,
} from 'lucide-react';
import api, { crossReferenceEvent, extractIngestFile } from '../api';

type IngestType = 'fighter_profile' | 'fight_history';

interface FighterSearchResult {
  id: string;
  first_name: string;
  last_name: string;
  weight_class: string;
  wins: number;
  losses: number;
}

// ─── Session state ────────────────────────────────────────────────────────────
interface ConflictEntry { current: any; candidate: any }
interface Snapshot {
  aggregated: Record<string, any>;
  conflicts: Record<string, ConflictEntry>;
}
interface HistorySnapshot { bouts: any[] }

interface SessionState {
  type: IngestType;
  aggregated: Record<string, any>;
  conflicts: Record<string, ConflictEntry>;
  snapshots: Snapshot[];          // for undo (profile)
  bouts: any[];
  boutSnapshots: HistorySnapshot[]; // for undo (history)
  pasteCount: number;
  
  // New efficiency tracking
  startTime: number;              // session start
  entryStartTime: number;         // current fighter start
  totalFighters: number;          // for batch tracking
  completedFighters: number;
  batchQueue?: any[];             // pending fighters from a single paste
}

// ─── Merge helpers ────────────────────────────────────────────────────────────
const DRAFT_KEY = 'grit.manualIngest.draft.v1';

interface ManualIngestDraft {
  ingestType: IngestType;
  rawText: string;
  fighterName: string;
  selectedFighter: FighterSearchResult | null;
  session: SessionState | null;
  editMode: boolean;
  parseCoverage: { name: string; filled: string[]; missing: string[]; pct: number } | null;
  parseAudit: {
    status: 'ok' | 'mismatch' | 'skipped' | 'error';
    issues: { field: string; raw_value: string; parsed_value: string; reason: string }[];
    error?: string;
  } | null;
  addFighterHint: string | null;
  crossRefEventName: string;
  crossRefResult: CrossRefResult | null;
}

function mergeProfile(
  current: Record<string, any>,
  currentConflicts: Record<string, ConflictEntry>,
  incoming: Record<string, any>,
): { aggregated: Record<string, any>; conflicts: Record<string, ConflictEntry> } {
  const aggregated = { ...current };
  const conflicts  = { ...currentConflicts };

  for (const [key, val] of Object.entries(incoming)) {
    if (val === null || val === undefined) continue;
    const existing = aggregated[key];
    if (existing === null || existing === undefined || existing === '') {
      aggregated[key] = val;
      delete conflicts[key]; // no longer a conflict if we just filled it
    } else if (String(existing) !== String(val)) {
      conflicts[key] = { current: existing, candidate: val };
    }
  }
  return { aggregated, conflicts };
}

const normalizeEventName = (name: string): string => {
  if (!name) return '';
  const trimmed = name.trim();
  // Strip "UFC XXX:" prefixes to match backend normalization
  const match = trimmed.match(/^(UFC\s+(?:\d+|Fight\s+Night[^\:]+))\:/i);
  if (match) return match[1].trim();
  return trimmed;
};

// result is NOT part of the dedup key — same fight regardless of source perspective
const boutKey = (b: any) => {
  const eName = normalizeEventName(b.event_name || '');
  const opp = (b.opponent_name || '').toLowerCase().trim();
  const date = b.event_date ? b.event_date.split('T')[0] : ''; // use YYYY-MM-DD if available
  return `${eName.toLowerCase()}|${opp}${date ? `|${date}` : ''}`;
};

// Fields that are never silently overwritten during merge
const RESULT_PROTECTED_FIELDS = new Set(['result']);

interface ResultConflict { existing: string; incoming: string }

function mergeHistory(existing: any[], incoming: any[]): any[] {
  const processedKeys = new Set<string>();
  const merged: any[] = [];

  // Pass 1: iterate existing bouts — enrich with incoming data where safe
  for (const exBout of existing) {
    const key = boutKey(exBout);
    processedKeys.add(key);

    const inBout = incoming.find(b => boutKey(b) === key);
    if (!inBout) {
      merged.push(exBout);
      continue;
    }

    const updated: any = { ...exBout };
    const resultConflicts: ResultConflict[] =
      exBout._result_conflicts ? [...exBout._result_conflicts] : [];

    for (const [field, inVal] of Object.entries(inBout)) {
      if (field.startsWith('_') || inVal === null || inVal === undefined) continue;

      if (RESULT_PROTECTED_FIELDS.has(field)) {
        const exVal = updated[field];
        if (exVal && String(exVal) !== String(inVal)) {
          console.warn(
            `[FIGHT MERGE DEBUG]\n  event: ${exBout.event_name}\n  opponent: ${exBout.opponent_name}\n  existing_result: ${exVal}\n  incoming_result: ${inVal}\n  action: BLOCKED (conflict — operator must resolve)`
          );
          // Only add if this exact conflict isn't already tracked
          const alreadyTracked = resultConflicts.some(
            c => c.existing === String(exVal) && c.incoming === String(inVal)
          );
          if (!alreadyTracked) {
            resultConflicts.push({ existing: String(exVal), incoming: String(inVal) });
          }
        }
        continue; // NEVER overwrite result silently
      }

      // Fill missing values freely from incoming
      const exVal = updated[field];
      if (exVal === null || exVal === undefined || exVal === '') {
        updated[field] = inVal;
      }
    }

    if (resultConflicts.length > 0) {
      updated._result_conflicts = resultConflicts;
      console.warn(
        `[FIGHT MERGE DEBUG]  event: ${exBout.event_name} | opponent: ${exBout.opponent_name} | ${resultConflicts.length} result conflict(s) flagged`
      );
    } else {
      console.log(
        `[FIGHT MERGE DEBUG]  event: ${exBout.event_name} | opponent: ${exBout.opponent_name} | action: MERGED (result preserved: ${updated.result})`
      );
    }

    merged.push(updated);
  }

  // Pass 2: add genuinely new bouts (no match in existing)
  for (const inBout of incoming) {
    const key = boutKey(inBout);
    if (!processedKeys.has(key)) {
      console.log(
        `[FIGHT MERGE DEBUG]  event: ${inBout.event_name} | opponent: ${inBout.opponent_name} | action: ADDED (new bout, result: ${inBout.result})`
      );
      merged.push(inBout);
      processedKeys.add(key);
    }
  }

  // Sort chronologically; bouts without dates fall to the end
  return merged.sort((a, b) => {
    if (!a.event_date && !b.event_date) return 0;
    if (!a.event_date) return 1;
    if (!b.event_date) return -1;
    return a.event_date.localeCompare(b.event_date);
  });
}

// ─── Badge ────────────────────────────────────────────────────────────────────
const Badge = ({ children, color }: { children: React.ReactNode; color: 'green' | 'yellow' | 'red' | 'blue' | 'purple' }) => {
  const cls = {
    green:  'bg-green-500/10 text-green-400 border-green-500/20',
    yellow: 'bg-yellow-500/10 text-yellow-400 border-yellow-500/20',
    red:    'bg-red-500/10 text-red-400 border-red-500/20',
    blue:   'bg-blue-500/10 text-blue-400 border-blue-500/20',
    purple: 'bg-purple-500/10 text-purple-400 border-purple-500/20',
  }[color];
  return (
    <span className={`inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-semibold border ${cls}`}>
      {children}
    </span>
  );
};

// ─── Inline edit field ────────────────────────────────────────────────────────
const EditField = ({
  label, value, onChange, type = 'text', tier, correction,
}: {
  label: string; value: any; onChange: (v: any) => void;
  type?: 'text' | 'number'; tier?: 1; correction?: any;
}) => (
  <div className="flex items-start gap-3 py-2 border-b border-border/40 last:border-0 relative group">
    <span className="text-xs text-muted w-40 shrink-0 pt-2">
      {tier === 1 && <span className="text-red-400 mr-1">*</span>}
      {label}
    </span>
    <div className="flex-1 flex flex-col gap-1">
      <input
        type={type}
        value={value === null || value === undefined ? '' : String(value)}
        onChange={e => {
          const raw = e.target.value;
          onChange(type === 'number' ? (raw === '' ? null : Number(raw)) : (raw || null));
        }}
        onFocus={e => e.target.select()}
        className={`w-full bg-bg/80 border border-border/60 rounded px-2 py-1 text-xs font-mono text-text focus:outline-none focus:border-accent min-w-0 ${correction ? 'border-purple-500/40' : ''}`}
        placeholder="—"
      />
      {correction && (
        <span className="text-[9px] text-purple-400 font-bold uppercase tracking-tighter flex items-center gap-1 animate-pulse">
          <Zap size={8} /> Frequent Correction detected for this value
        </span>
      )}
    </div>
  </div>
);

// ─── View field ───────────────────────────────────────────────────────────────
const ViewField = ({ label, value, tier, correction }: { label: string; value: any; tier?: 1; correction?: any }) => {
  const isEmpty = value === null || value === undefined || value === '';
  const display =
    typeof value === 'boolean' ? (value ? 'true' : 'false') :
    typeof value === 'object'  ? JSON.stringify(value) :
    String(value ?? '—');
  return (
    <div className="flex items-start gap-3 py-2 border-b border-border/40 last:border-0">
      <span className="text-xs text-muted w-40 shrink-0 pt-0.5">
        {tier === 1 && <span className="text-red-400 mr-1">*</span>}{label}
      </span>
      <div className="flex-1 flex flex-col gap-1">
        <span className={`text-sm font-mono break-all ${isEmpty ? 'text-muted/40 italic' : 'text-text'} ${correction ? 'text-purple-300 underline decoration-purple-500/50' : ''}`}>
          {display}
        </span>
        {correction && (
          <span className="text-[9px] text-purple-400 font-bold uppercase tracking-tighter flex items-center gap-1">
            <Zap size={8} /> Frequent correction pattern noted
          </span>
        )}
      </div>
    </div>
  );
};

// ─── Conflict resolver ────────────────────────────────────────────────────────
const ConflictPanel = ({
  conflicts,
  onAccept,
  onKeep,
}: {
  conflicts: Record<string, ConflictEntry>;
  onAccept: (key: string) => void;
  onKeep:   (key: string) => void;
}) => {
  const [open, setOpen] = useState(true);
  const keys = Object.keys(conflicts);
  if (keys.length === 0) return null;

  return (
    <div className="border border-yellow-500/30 bg-yellow-500/5 rounded-xl overflow-hidden">
      <button
        className="w-full flex items-center justify-between px-4 py-3 text-left"
        onClick={() => setOpen(o => !o)}
      >
        <div className="flex items-center gap-2">
          <AlertTriangle size={14} className="text-yellow-400" />
          <span className="text-xs font-bold text-yellow-400 uppercase tracking-wider">
            {keys.length} Conflict{keys.length !== 1 ? 's' : ''} — review before approving
          </span>
        </div>
        {open ? <ChevronUp size={14} className="text-muted" /> : <ChevronDown size={14} className="text-muted" />}
      </button>

      {open && (
        <div className="divide-y divide-yellow-500/10 border-t border-yellow-500/20">
          {keys.map(key => (
            <div key={key} className="px-4 py-3">
              <p className="text-[10px] uppercase tracking-wider text-muted/60 mb-2 font-bold">{key}</p>
              <div className="flex items-center gap-3 flex-wrap">
                {/* Current */}
                <div className="flex items-center gap-2 flex-1 min-w-0">
                  <span className="text-[10px] text-green-400 font-bold uppercase shrink-0">Current</span>
                  <span className="text-xs font-mono bg-green-500/10 border border-green-500/20 px-2 py-0.5 rounded text-green-300 truncate">
                    {String(conflicts[key].current)}
                  </span>
                  <button
                    onClick={() => onKeep(key)}
                    className="text-[10px] text-muted hover:text-green-400 font-semibold shrink-0"
                  >
                    Keep
                  </button>
                </div>

                <span className="text-muted/30 text-xs">vs</span>

                {/* Candidate */}
                <div className="flex items-center gap-2 flex-1 min-w-0">
                  <span className="text-[10px] text-blue-400 font-bold uppercase shrink-0">New</span>
                  <span className="text-xs font-mono bg-blue-500/10 border border-blue-500/20 px-2 py-0.5 rounded text-blue-300 truncate">
                    {String(conflicts[key].candidate)}
                  </span>
                  <button
                    onClick={() => onAccept(key)}
                    className="text-[10px] text-blue-400 hover:text-blue-300 font-bold border border-blue-500/30 rounded px-2 py-0.5 shrink-0"
                  >
                    Use New
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

// ─── Profile form (view + edit) ───────────────────────────────────────────────
const ProfileForm = ({
  data,
  editMode,
  onChange,
  corrections,
}: {
  data: Record<string, any>;
  editMode: boolean;
  onChange: (key: string, val: any) => void;
  corrections: Record<string, Record<string, any>>;
}) => {
  const F = editMode
    ? ({ label, k, type, tier }: { label: string; k: string; type?: 'text'|'number'; tier?: 1 }) => (
        <EditField 
          label={label} 
          value={data[k]} 
          onChange={v => onChange(k, v)} 
          type={type} 
          tier={tier} 
          correction={corrections[k]?.[String(data[k])]}
        />
      )
    : ({ label, k, tier }: { label: string; k: string; tier?: 1 }) => (
        <ViewField 
          label={label} 
          value={data[k]} 
          tier={tier} 
          correction={corrections[k]?.[String(data[k])]}
        />
      );

  return (
    <div className="space-y-4">
      <div>
        <h4 className="text-[10px] font-bold uppercase tracking-widest text-accent mb-2">Identity</h4>
        <F label="first_name"    k="first_name"    tier={1} />
        <F label="last_name"     k="last_name"     tier={1} />
        <F label="nickname"      k="nickname" />
        <F label="gender"        k="gender" />
        <F label="nationality"   k="nationality" />
        <F label="date_of_birth" k="date_of_birth" />
      </div>
      <div>
        <h4 className="text-[10px] font-bold uppercase tracking-widest text-accent mb-2">Record</h4>
        <F label="wins"                    k="wins"                    type="number" tier={1} />
        <F label="losses"                  k="losses"                  type="number" tier={1} />
        <F label="draws"                   k="draws"                   type="number" />
        <F label="weight_class"            k="weight_class"            tier={1} />
        <F label="ko_wins"                 k="ko_wins"                 type="number" />
        <F label="tko_wins"                k="tko_wins"                type="number" />
        <F label="sub_wins"                k="sub_wins"                type="number" />
        <F label="dec_wins"                k="dec_wins"                type="number" />
        <F label="losses_by_ko"            k="losses_by_ko"            type="number" />
        <F label="losses_by_submission"    k="losses_by_submission"    type="number" />
        <F label="losses_by_decision"      k="losses_by_decision"      type="number" />
      </div>
      <div>
        <h4 className="text-[10px] font-bold uppercase tracking-widest text-accent mb-2">Physical / Career</h4>
        <F label="height_inch"     k="height_inch"     type="number" />
        <F label="reach_inch"      k="reach_inch"      type="number" />
        <F label="stance"          k="stance" />
        <F label="gym"             k="gym" />
        <F label="fighting_out_of" k="fighting_out_of" />
        <F label="organization"    k="organization" />
        <F label="ranking"         k="ranking"         type="number" />
      </div>
      <div>
        <h4 className="text-[10px] font-bold uppercase tracking-widest text-accent mb-2">UFC Stats</h4>
        <F label="slpm"              k="slpm"              type="number" />
        <F label="sapm"              k="sapm"              type="number" />
        <F label="strike_accuracy"   k="strike_accuracy"   type="number" />
        <F label="strike_defense"    k="strike_defense"    type="number" />
        <F label="takedown_avg"      k="takedown_avg"      type="number" />
        <F label="takedown_accuracy" k="takedown_accuracy" type="number" />
        <F label="takedown_defense"  k="takedown_defense"  type="number" />
        <F label="submission_avg"    k="submission_avg"    type="number" />
      </div>
    </div>
  );
};

// ─── History list ─────────────────────────────────────────────────────────────
const HistoryList = ({
  bouts,
  onResolveConflict,
}: {
  bouts: any[];
  onResolveConflict?: (idx: number, useIncoming: boolean) => void;
}) => (
  <div className="space-y-2">
    <p className="text-xs text-muted mb-3">{bouts.length} bout(s) accumulated</p>
    {bouts.map((bout, i) => {
      const s = bout.bout_stats;
      const hasResultConflict = bout._result_conflicts?.length > 0;
      const conflict: ResultConflict | undefined = bout._result_conflicts?.[0];

      return (
        <div
          key={i}
          className={`border rounded-lg p-3 space-y-1.5 ${
            hasResultConflict
              ? 'border-orange-500/50 bg-orange-500/5'
              : 'border-border/40'
          }`}
        >
          {/* Header row */}
          <div className="flex items-center justify-between gap-2">
            <span className="font-semibold text-sm">{bout.opponent_name || '—'}</span>
            <span className={`text-xs font-bold px-2 py-0.5 rounded ${
              bout.result === 'Win'  ? 'bg-green-500/10 text-green-400' :
              bout.result === 'Loss' ? 'bg-red-500/10 text-red-400' :
              bout.result === 'NC'   ? 'bg-muted/20 text-muted' :
              'bg-muted/10 text-muted'
            }`}>{bout.result || '—'}</span>
          </div>

          {/* Event + date */}
          <p className="text-xs text-muted">
            {bout.event_name || '—'}
            {bout.event_date ? ` · ${bout.event_date}` : ''}
          </p>

          {/* Method + round + time + title */}
          <p className="text-xs text-text/60">
            {bout.method}{bout.method_detail ? ` (${bout.method_detail})` : ''}
            {bout.round ? ` · R${bout.round}` : ''}
            {bout.time  ? ` ${bout.time}` : ''}
            {bout.rounds_scheduled ? ` · ${bout.rounds_scheduled}Rnd` : ''}
            {bout.title_fight ? ' 🏆' : ''}
          </p>

          {/* Referee */}
          {bout.referee && (
            <p className="text-xs text-muted/70">Referee: {bout.referee}</p>
          )}

          {/* Bout stats grid — only shown when bout_stats is present */}
          {s && (
            <div className="mt-1 grid grid-cols-3 gap-x-3 gap-y-0.5 text-[10px] border-t border-border/30 pt-1.5">
              {s.kd          != null && <span className="text-muted">KD: <span className="text-text">{s.kd}</span></span>}
              {s.sig_str_landed != null && (
                <span className="text-muted">
                  Sig: <span className="text-text">{s.sig_str_landed}/{s.sig_str_attempted ?? '?'}</span>
                  {s.sig_str_pct != null ? ` (${s.sig_str_pct}%)` : ''}
                </span>
              )}
              {s.total_str_landed != null && (
                <span className="text-muted">
                  Total: <span className="text-text">{s.total_str_landed}/{s.total_str_attempted ?? '?'}</span>
                </span>
              )}
              {s.td_landed != null && (
                <span className="text-muted">
                  TD: <span className="text-text">{s.td_landed}/{s.td_attempted ?? '?'}</span>
                  {s.td_pct != null ? ` (${s.td_pct}%)` : ''}
                </span>
              )}
              {s.sub_att   != null && <span className="text-muted">Sub: <span className="text-text">{s.sub_att}</span></span>}
              {s.ctrl_time         && <span className="text-muted">Ctrl: <span className="text-text">{s.ctrl_time}</span></span>}
            </div>
          )}

          {/* ⚠ Result conflict resolver */}
          {hasResultConflict && conflict && onResolveConflict && (
            <div className="mt-2 border-t border-orange-500/30 pt-2 space-y-1.5">
              <p className="text-[10px] font-bold text-orange-400 uppercase tracking-wide">
                ⚠ Result Conflict — choose correct result
              </p>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => onResolveConflict(i, false)}
                  className="flex-1 text-[10px] font-bold py-1 px-2 rounded border border-green-500/40 bg-green-500/10 text-green-400 hover:bg-green-500/20"
                >
                  Keep: {conflict.existing}
                </button>
                <button
                  onClick={() => onResolveConflict(i, true)}
                  className="flex-1 text-[10px] font-bold py-1 px-2 rounded border border-red-400/40 bg-red-400/10 text-red-400 hover:bg-red-400/20"
                >
                  Use: {conflict.incoming}
                </button>
              </div>
              <p className="text-[9px] text-muted/60">
                Existing source takes priority until you decide. Approve is blocked until resolved.
              </p>
            </div>
          )}
        </div>
      );
    })}
  </div>
);

// ─── Fighter Search ───────────────────────────────────────────────────────────
const FighterSearch = ({
  selected, onSelect, autoFocus,
}: { selected: FighterSearchResult | null; onSelect: (f: FighterSearchResult | null) => void; autoFocus?: boolean }) => {
  const [query, setQuery]   = useState('');
  const [results, setResults] = useState<FighterSearchResult[]>([]);
  const [open, setOpen]     = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (autoFocus && !selected) {
      inputRef.current?.focus();
    }
  }, [autoFocus, selected]);

  const search = useCallback(async (q: string) => {
    setQuery(q);
    if (!q.trim()) { setResults([]); return; }
    try {
      const res = await api.get(`/ingest/fighters/search?q=${encodeURIComponent(q)}`);
      setResults(res.data);
      setOpen(true);
    } catch { setResults([]); }
  }, []);

  return (
    <div className="relative">
      <label className="block text-xs font-semibold text-muted mb-1">
        Step 1 — Select Fighter (whose history is this?)
      </label>
      {selected ? (
        <div className="flex items-center gap-3 bg-surface border border-accent/30 rounded-lg px-3 py-2">
          <span className="text-sm font-semibold flex-1">{selected.first_name} {selected.last_name}</span>
          <span className="text-xs text-muted">{selected.weight_class} · {selected.wins}W {selected.losses}L</span>
          <button onClick={() => { onSelect(null); setQuery(''); }} className="text-muted hover:text-red-400">
            <X size={14} />
          </button>
        </div>
      ) : (
        <div className="relative">
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted" />
          <input
            ref={inputRef}
            className="w-full bg-surface border border-border rounded-lg pl-9 pr-3 py-2 text-sm focus:outline-none focus:border-accent"
            placeholder="Search fighter name..."
            value={query}
            onChange={e => search(e.target.value)}
            onFocus={() => query && setOpen(true)}
          />
        </div>
      )}
      {open && results.length > 0 && !selected && (
        <div className="absolute z-20 w-full mt-1 bg-surface border border-border rounded-lg shadow-xl overflow-hidden">
          {results.map(f => (
            <button
              key={f.id}
              className="w-full text-left px-3 py-2 hover:bg-white/5 flex items-center justify-between"
              onClick={() => { onSelect(f); setOpen(false); setQuery(''); }}
            >
              <span className="text-sm font-medium">{f.first_name} {f.last_name}</span>
              <span className="text-xs text-muted">{f.weight_class} · {f.wins}W {f.losses}L</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
};

// ─── Event Cross-Reference Tool ───────────────────────────────────────────────
type FighterRef = { name: string; status: 'exists' | 'missing'; fighter_id: string | null };
type BoutRef = { fighter_a: FighterRef; fighter_b: FighterRef; weight_class?: string };
type CrossRefResult = { event_name: string; event_url?: string; bouts: BoutRef[]; error?: string };

interface EventIntakeToolProps {
  eventName: string;
  onEventNameChange: (v: string) => void;
  loading: boolean;
  result: CrossRefResult | null;
  errorMsg: string | null;
  onCheck: () => void;
  onClear: () => void;
  onAddFighter: (name: string) => void;
}

function EventIntakeTool({
  eventName, onEventNameChange, loading, result, errorMsg,
  onCheck, onClear, onAddFighter,
}: EventIntakeToolProps) {
  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') onCheck();
  };

  const missingCount = result
    ? result.bouts.reduce((n, b) => n + (b.fighter_a.status === 'missing' ? 1 : 0) + (b.fighter_b.status === 'missing' ? 1 : 0), 0)
    : 0;
  const existsCount = result
    ? result.bouts.reduce((n, b) => n + (b.fighter_a.status === 'exists' ? 1 : 0) + (b.fighter_b.status === 'exists' ? 1 : 0), 0)
    : 0;

  return (
    <div className="bg-surface border border-border/60 rounded-xl p-4 space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="text-[10px] uppercase font-black tracking-widest text-muted">Card Cross-Reference</h3>
        {(result || errorMsg) && (
          <button onClick={onClear} className="text-[10px] text-muted hover:text-accent uppercase font-bold">Clear</button>
        )}
      </div>

      <div className="flex gap-2">
        <input
          type="text"
          className="flex-1 bg-bg border border-border/40 rounded-lg px-3 py-2 text-[11px] font-mono focus:outline-none focus:border-accent placeholder-muted/30"
          placeholder="e.g. UFC 309"
          value={eventName}
          onChange={e => onEventNameChange(e.target.value)}
          onKeyDown={handleKeyDown}
          disabled={loading}
        />
        <button
          onClick={onCheck}
          disabled={loading || !eventName.trim()}
          className="px-3 py-2 bg-white/5 border border-border/60 rounded-lg text-[10px] font-black uppercase hover:bg-white/10 disabled:opacity-30 transition-colors whitespace-nowrap"
        >
          {loading ? '...' : 'Check Card'}
        </button>
      </div>

      {errorMsg && (
        <div className="text-[11px] text-red-400 bg-red-500/10 border border-red-500/20 rounded-lg px-3 py-2">
          {errorMsg}
        </div>
      )}

      {result && (
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-[10px] font-bold text-accent truncate max-w-[160px]">{result.event_name}</span>
            <div className="flex gap-2 text-[9px] font-black uppercase shrink-0">
              <span className="text-gold/80">{existsCount} in db</span>
              {missingCount > 0 && <span className="text-red-400">{missingCount} missing</span>}
            </div>
          </div>

          {result.bouts.length === 0 && (
            <p className="text-[11px] text-muted/50 text-center py-2">No bouts found for this event</p>
          )}

          <div className="space-y-1 max-h-64 overflow-y-auto pr-1">
            {result.bouts.map((bout, i) => (
              <div key={i} className="bg-bg/60 border border-border/30 rounded-lg px-2 py-2 space-y-1.5">
                {bout.weight_class && (
                  <p className="text-[9px] text-muted/40 uppercase font-bold tracking-wider">{bout.weight_class}</p>
                )}
                <div className="flex items-center gap-1.5">
                  <FighterStatusRow fighter={bout.fighter_a} onAdd={onAddFighter} />
                  <span className="text-[9px] text-muted/30 font-bold shrink-0">vs</span>
                  <FighterStatusRow fighter={bout.fighter_b} onAdd={onAddFighter} />
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function FighterStatusRow({ fighter, onAdd }: { fighter: FighterRef; onAdd: (name: string) => void }) {
  const exists = fighter.status === 'exists';
  return (
    <div className="flex items-center gap-1 flex-1 min-w-0">
      <span className={`text-[9px] font-black shrink-0 ${exists ? 'text-gold' : 'text-red-400'}`}>
        {exists ? '✔' : '✖'}
      </span>
      <span className={`text-[10px] truncate flex-1 ${exists ? 'text-muted/70' : 'text-red-300 font-semibold'}`}>
        {fighter.name}
      </span>
      {exists ? (
        <span className="text-[8px] font-black uppercase shrink-0 px-1.5 py-0.5 rounded bg-gold/10 text-gold">
          IN DB
        </span>
      ) : (
        <>
          <span className="text-[8px] font-black uppercase shrink-0 px-1.5 py-0.5 rounded bg-red-500/10 text-red-400">
            MISSING
          </span>
          <button
            onClick={() => onAdd(fighter.name)}
            className="text-[8px] font-black uppercase shrink-0 px-1.5 py-0.5 rounded bg-accent/20 text-accent hover:bg-accent/30 transition-colors whitespace-nowrap"
          >
            + Add
          </button>
        </>
      )}
    </div>
  );
}

// ─── Main Component ───────────────────────────────────────────────────────────
export default function ManualIngest() {
  const [ingestType, setIngestType]         = useState<IngestType>('fighter_profile');
  const [rawText, setRawText]               = useState('');
  const [fighterName, setFighterName]       = useState('');
  const [selectedFighter, setSelectedFighter] = useState<FighterSearchResult | null>(null);
  const draftLoadedRef = useRef(false);

  const [parsing, setParsing]       = useState(false);
  const [approving, setApproving]   = useState(false);
  const [parseError, setParseError] = useState<{ message: string; retryable: boolean } | null>(null);
  const [result, setResult]         = useState<any | null>(null);
  const [editMode, setEditMode]     = useState(false);
  const [duplicateWarning, setDuplicateWarning] = useState<{ id: string; name: string } | null>(null);
  const [addFighterHint, setAddFighterHint] = useState<string | null>(null);
  const [uploadingFile, setUploadingFile] = useState(false);
  const [uploadedFileName, setUploadedFileName] = useState<string | null>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);

  const pasteRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleFileSelected = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = ''; // allow re-selecting the same file later
    if (!file) return;

    setUploadingFile(true);
    setUploadError(null);
    try {
      const res = await extractIngestFile(file);
      setRawText(res.data.text);
      setUploadedFileName(res.data.filename);
    } catch (err: any) {
      setUploadError(err?.response?.data?.detail || 'Could not extract text from that file');
      setUploadedFileName(null);
    } finally {
      setUploadingFile(false);
    }
  };

  // ── Cross-reference state (lifted — persists across approve/reset cycles) ──
  const [crossRefEventName, setCrossRefEventName] = useState('');
  const [crossRefLoading, setCrossRefLoading]     = useState(false);
  const [crossRefResult, setCrossRefResult]       = useState<CrossRefResult | null>(null);
  const [crossRefError, setCrossRefError]         = useState<string | null>(null);

  const handleCrossRef = async () => {
    if (!crossRefEventName.trim()) return;
    setCrossRefLoading(true);
    setCrossRefResult(null);
    setCrossRefError(null);
    try {
      const res = await crossReferenceEvent(crossRefEventName.trim());
      const data: CrossRefResult = res.data;
      if (data.error) setCrossRefError(data.error);
      else setCrossRefResult(data);
    } catch (err: any) {
      setCrossRefError(err?.response?.data?.detail || 'Request failed');
    } finally {
      setCrossRefLoading(false);
    }
  };

  const handleCrossRefClear = () => {
    setCrossRefResult(null);
    setCrossRefError(null);
    setCrossRefEventName('');
  };

  const updateCrossRefFighterStatus = (fullName: string, fighter_id: string) => {
    if (!crossRefResult) return;
    const norm = (s: string) => s.toLowerCase().replace(/[^a-z]/g, '');
    const normTarget = norm(fullName);
    const updatedBouts = crossRefResult.bouts.map(bout => ({
      ...bout,
      fighter_a: norm(bout.fighter_a.name) === normTarget
        ? { ...bout.fighter_a, status: 'exists' as const, fighter_id }
        : bout.fighter_a,
      fighter_b: norm(bout.fighter_b.name) === normTarget
        ? { ...bout.fighter_b, status: 'exists' as const, fighter_id }
        : bout.fighter_b,
    }));
    setCrossRefResult({ ...crossRefResult, bouts: updatedBouts });
  };

  // ── Parse coverage (field feedback shown after fighter_profile parse) ───────
  const [parseCoverage, setParseCoverage] = useState<{
    name: string;
    filled: string[];
    missing: string[];
    pct: number;
  } | null>(null);

  function computeFighterCoverage(data: any) {
    const fields: { key: string; label: string }[] = [
      { key: 'first_name',          label: 'First Name' },
      { key: 'last_name',           label: 'Last Name' },
      { key: 'gender',              label: 'Gender' },
      { key: 'weight_class',        label: 'Weight Class' },
      { key: 'nationality',         label: 'Nationality' },
      { key: 'wins',                label: 'Record (W)' },
      { key: 'losses',              label: 'Record (L)' },
      { key: 'height',              label: 'Height' },
      { key: 'reach',               label: 'Reach' },
      { key: 'stance',              label: 'Stance' },
      { key: 'date_of_birth',       label: 'Date of Birth' },
      { key: 'fighting_out_of',     label: 'Fighting Out Of' },
      { key: 'slpm',                label: 'Strikes/Min' },
      { key: 'sapm',                label: 'Absorbed/Min' },
      { key: 'strike_accuracy',     label: 'Strike Accuracy' },
      { key: 'strike_defense',      label: 'Strike Defense' },
      { key: 'takedown_avg',        label: 'Takedown Avg' },
      { key: 'takedown_accuracy',   label: 'TD Accuracy' },
      { key: 'takedown_defense',    label: 'TD Defense' },
      { key: 'submission_avg',      label: 'Sub Avg' },
    ];
    const filled: string[] = [];
    const missing: string[] = [];
    for (const { key, label } of fields) {
      const val = data[key];
      const empty = val === null || val === undefined || val === '';
      (empty ? missing : filled).push(label);
    }
    const pct = Math.round((filled.length / fields.length) * 100);
    const name = [data.first_name, data.last_name].filter(Boolean).join(' ') || 'Unknown';
    return { name, filled, missing, pct };
  }

  // Autofocus paste area on mount and after successful parse
  useEffect(() => {
    if (!parsing && !result) {
      pasteRef.current?.focus();
    }
  }, [parsing, result]);

  // OpenAI audit result for the most recent paste (fight_history only)
  const [parseAudit, setParseAudit] = useState<{
    status: 'ok' | 'mismatch' | 'skipped' | 'error';
    issues: { field: string; raw_value: string; parsed_value: string; reason: string }[];
    error?: string;
  } | null>(null);

  // Session (accumulated data)
  const [session, setSession] = useState<SessionState | null>(null);

  const [sessionEndStats, setSessionEndStats] = useState<{ avg: number; total: number; count: number } | null>(null);
  const [correctionHistory, setCorrectionHistory] = useState<Record<string, Record<string, any>>>({});

  useEffect(() => {
    try {
      const rawDraft = localStorage.getItem(DRAFT_KEY);
      if (!rawDraft) return;
      const draft = JSON.parse(rawDraft) as Partial<ManualIngestDraft>;
      if (draft.ingestType) setIngestType(draft.ingestType);
      setRawText(draft.rawText ?? '');
      setFighterName(draft.fighterName ?? '');
      setSelectedFighter(draft.selectedFighter ?? null);
      setSession(draft.session ?? null);
      setEditMode(Boolean(draft.editMode));
      setParseCoverage(draft.parseCoverage ?? null);
      setParseAudit(draft.parseAudit ?? null);
      setAddFighterHint(draft.addFighterHint ?? null);
      setCrossRefEventName(draft.crossRefEventName ?? '');
      setCrossRefResult(draft.crossRefResult ?? null);
    } catch (err) {
      console.warn('Could not restore manual ingest draft', err);
      localStorage.removeItem(DRAFT_KEY);
    } finally {
      draftLoadedRef.current = true;
    }
  }, []);

  useEffect(() => {
    if (!draftLoadedRef.current) return;

    const hasDraft =
      rawText.trim() ||
      session ||
      selectedFighter ||
      fighterName.trim() ||
      crossRefEventName.trim() ||
      crossRefResult ||
      addFighterHint;

    if (!hasDraft) {
      localStorage.removeItem(DRAFT_KEY);
      return;
    }

    const draft: ManualIngestDraft = {
      ingestType,
      rawText,
      fighterName,
      selectedFighter,
      session,
      editMode,
      parseCoverage,
      parseAudit,
      addFighterHint,
      crossRefEventName,
      crossRefResult,
    };
    localStorage.setItem(DRAFT_KEY, JSON.stringify(draft));
  }, [
    addFighterHint,
    crossRefEventName,
    crossRefResult,
    editMode,
    fighterName,
    ingestType,
    parseAudit,
    parseCoverage,
    rawText,
    selectedFighter,
    session,
  ]);

  // ── Search & Target State ──────────────────────────────────────────────────
  const hasSession = session !== null;
  const profileConflictCount = session ? Object.keys(session.conflicts).length : 0;
  const boutResultConflictCount = session?.type === 'fight_history'
    ? (session.bouts || []).filter(b => b._result_conflicts?.length > 0).length
    : 0;
  const conflictCount = profileConflictCount + boutResultConflictCount;

  // ── Parse + Merge ─────────────────────────────────────────────────────────
  const handleParse = async () => {
    if (!rawText.trim()) return;
    if (ingestType === 'fight_history' && !selectedFighter) return;

    setParsing(true);
    setParseError(null);

    try {
      const res = await api.post('/ingest/raw', {
        type: ingestType,
        raw_text: rawText,
        fighter_name: ingestType === 'fight_history'
          ? (fighterName || (selectedFighter ? `${selectedFighter.first_name} ${selectedFighter.last_name}` : ''))
          : undefined,
      });

      const parsed = res.data;
      if (parsed.status === 'error') {
        setParseError({ message: parsed.error || 'Parsing failed', retryable: parsed.retryable ?? false });
        return;
      }

      const now = Date.now();
      if (parsed.type === 'fighter_profile') {
        const incomingData = parsed.data;
        let mainEntry = Array.isArray(incomingData) ? incomingData[0] : incomingData;
        let queue = Array.isArray(incomingData) ? incomingData.slice(1) : [];

        // Check for duplication on first paste
        if (!session) {
          try {
            const checkRes = await api.post('/ingest/check-names', [`${mainEntry.first_name} ${mainEntry.last_name}`]);
            if (checkRes.data?.[0]?.exists) {
              setDuplicateWarning({ id: checkRes.data[0].id, name: checkRes.data[0].name });
            }
          } catch (e) {
            console.error("Duplicate check failed", e);
          }
        }

        if (!session) {
          setSession({
            type: 'fighter_profile',
            aggregated: mainEntry,
            conflicts: {},
            snapshots: [],
            bouts: [],
            boutSnapshots: [],
            pasteCount: 1,
            startTime: now,
            entryStartTime: now,
            totalFighters: queue.length + 1,
            completedFighters: 0,
            batchQueue: queue,
          });
        } else {
          // Subsequent paste — merge into current
          const snapshot: Snapshot = {
            aggregated: { ...session.aggregated },
            conflicts:  { ...session.conflicts },
          };
          const { aggregated, conflicts } = mergeProfile(
            session.aggregated,
            session.conflicts,
            mainEntry,
          );
          setSession({
            ...session,
            aggregated,
            conflicts,
            snapshots: [...session.snapshots, snapshot],
            pasteCount: session.pasteCount + 1,
          });
        }
        // Compute field coverage from the freshly-parsed entry
        setParseCoverage(computeFighterCoverage(mainEntry));
      } else {
        // fight_history — append + deduplicate
        const incoming: any[] = Array.isArray(parsed.data) ? parsed.data : [];

        if (!session) {
          setSession({
            type: 'fight_history',
            aggregated: {},
            conflicts: {},
            snapshots: [],
            bouts: incoming,
            boutSnapshots: [],
            pasteCount: 1,
            startTime: now,
            entryStartTime: now,
            totalFighters: 1,
            completedFighters: 0,
          });
        } else {
          const merged = mergeHistory(session.bouts, incoming);
          setSession({
            ...session,
            bouts: merged,
            boutSnapshots: [...session.boutSnapshots, { bouts: [...session.bouts] }],
            pasteCount: session.pasteCount + 1,
          });
        }

        // Store OpenAI audit for this paste
        if (parsed.audit) {
          setParseAudit(parsed.audit);
        }
      }

      setRawText('');
      setAddFighterHint(null); // clear instruction banner after successful parse
    } catch (err: any) {
      setParseError({ message: err?.response?.data?.detail || 'Request failed', retryable: false });
    } finally {
      setParsing(false);
    }
  };

  // ── Bout result conflict resolution ──────────────────────────────────────
  const resolveBoutResultConflict = (boutIdx: number, useIncoming: boolean) => {
    if (!session) return;
    const updatedBouts = [...session.bouts];
    const bout = { ...updatedBouts[boutIdx] };
    if (useIncoming && bout._result_conflicts?.[0]) {
      bout.result = bout._result_conflicts[0].incoming;
    }
    // Conflict resolved — either kept existing or accepted incoming
    delete bout._result_conflicts;
    updatedBouts[boutIdx] = bout;
    setSession({ ...session, bouts: updatedBouts });
  };

  // ── Profile conflict resolution ───────────────────────────────────────────
  const acceptNew = (key: string) => {
    if (!session) return;
    const { [key]: conflict, ...rest } = session.conflicts;
    setSession({
      ...session,
      aggregated: { ...session.aggregated, [key]: conflict.candidate },
      conflicts: rest,
    });
  };

  const keepCurrent = (key: string) => {
    if (!session) return;
    const { [key]: _, ...rest } = session.conflicts;
    setSession({ ...session, conflicts: rest });
  };

  // ── Field edit (direct editing of aggregated data) ────────────────────────
  const handleFieldChange = (key: string, val: any) => {
    if (!session) return;
    const oldVal = session.aggregated[key];
    if (oldVal !== val) {
      setCorrectionHistory((prev: any) => ({
        ...prev,
        [key]: { ...prev[key], [String(oldVal)]: val }
      }));
    }
    setSession({ ...session, aggregated: { ...session.aggregated, [key]: val } });
  };

  // ── Undo last paste ───────────────────────────────────────────────────────
  const handleUndo = () => {
    if (!session) return;

    if (session.type === 'fighter_profile') {
      if (session.snapshots.length === 0) {
        setSession(null); // undo first paste → clear session
        return;
      }
      const prev = session.snapshots[session.snapshots.length - 1];
      setSession({
        ...session,
        aggregated: prev.aggregated,
        conflicts: prev.conflicts,
        snapshots: session.snapshots.slice(0, -1),
        pasteCount: session.pasteCount - 1,
      });
    } else {
      if (session.boutSnapshots.length === 0) {
        setSession(null);
        return;
      }
      const prev = session.boutSnapshots[session.boutSnapshots.length - 1];
      setSession({
        ...session,
        bouts: prev.bouts,
        boutSnapshots: session.boutSnapshots.slice(0, -1),
        pasteCount: session.pasteCount - 1,
      });
    }
  };

  // ── Clear session ─────────────────────────────────────────────────────────
  const handleClear = () => {
    setSession(null);
    setRawText('');
    setParseError(null);
    setEditMode(false);
    setParseCoverage(null);
    setAddFighterHint(null);
  };

  // ── Approve ───────────────────────────────────────────────────────────────
  const handleApprove = async () => {
    if (!session) return;

    if (session.type === 'fight_history' && !selectedFighter) {
      setParseError({ message: 'Select the fighter this history belongs to before approving', retryable: false });
      return;
    }

    setApproving(true);
    try {
      const data = session.type === 'fighter_profile'
        ? session.aggregated
        : session.bouts;

      const body: any = { type: session.type, data };
      if (session.type === 'fight_history') body.fighter_id = selectedFighter!.id;

      const res = await api.post('/ingest/approve', body);
      if (res.data.status === 'error') {
        setParseError({ message: 'Validation failed: ' + res.data.validation_errors?.join(', '), retryable: false });
      } else {
        // Update cross-ref status in-place if a fighter was just created/updated
        if (session.type === 'fighter_profile' && res.data.name && res.data.fighter_id) {
          updateCrossRefFighterStatus(res.data.name, res.data.fighter_id);
        }
        setResult(res.data);
        setParseCoverage(null);
        setSession(null);
        setEditMode(false);
      }
    } catch (err: any) {
      setParseError({ message: err?.response?.data?.detail || 'Approval failed', retryable: false });
    } finally {
      setApproving(false);
    }
  };

  // ── Full reset after success ──────────────────────────────────────────────
  const handleReset = () => {
    setResult(null);
    setSession(null);
    setRawText('');
    setFighterName('');
    setSelectedFighter(null);
    setParseError(null);
    setEditMode(false);
    setParseCoverage(null);
    setAddFighterHint(null);
  };

  const canApprove = session &&
    (session.type === 'fight_history' ? session.bouts.length > 0 && !!selectedFighter : true);

  const canUndo = session && (
    session.type === 'fighter_profile'
      ? session.pasteCount > 0
      : session.boutSnapshots.length > 0 || session.pasteCount > 0
  );

  return (
    <div className="h-full flex flex-col">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-black tracking-tight">Manual Ingestion</h1>
          <p className="text-muted text-sm mt-1">
            Paste from multiple sources — data is merged, not replaced.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Badge color="purple"><GitMerge size={11} /> Merge Mode</Badge>
          <Badge color="yellow">Manual</Badge>
          <Badge color="blue">Scrapers Paused</Badge>
        </div>
      </div>

      {/* Flow steps */}
      <div className="mb-5 flex items-center gap-2 text-xs text-muted/60 flex-wrap">
        {['Paste source', 'Merge into session', 'Resolve conflicts', 'Edit fields', 'Approve → DB', 'Verify', 'Push to GRIT'].map((step, i, arr) => (
          <React.Fragment key={step}>
            <span className="px-2 py-0.5 rounded bg-surface border border-border/50">{step}</span>
            {i < arr.length - 1 && <ChevronRight size={11} className="text-muted/30 shrink-0" />}
          </React.Fragment>
        ))}
      </div>

      {/* ── Always-rendered 2-column grid — EventIntakeTool stays mounted ── */}
      <div className="flex-1 grid grid-cols-2 gap-6 min-h-0">

          {/* ── Left: Input pane ──────────────────────────────────────────── */}
          <div className="flex flex-col gap-4 min-h-0">

            {/* Type selector */}
            <div className="flex gap-2">
              {(['fighter_profile', 'fight_history'] as IngestType[]).map(t => (
                <button
                  key={t}
                  onClick={() => {
                    if (session) return;
                    setIngestType(t);
                    setParseError(null);
                  }}
                  disabled={!!session && session.type !== t}
                  className={`flex-1 py-2.5 rounded-lg text-sm font-semibold border transition-colors ${
                    ingestType === t
                      ? 'bg-accent/10 text-accent border-accent/30'
                      : 'text-muted border-border hover:bg-white/5'
                  } disabled:opacity-30 disabled:cursor-not-allowed`}
                >
                  {t === 'fighter_profile' ? '① Fighter Profile' : '② Fight History'}
                </button>
              ))}
            </div>

            {/* Event Intake Tool — always rendered so scan persists */}
            <EventIntakeTool
              eventName={crossRefEventName}
              onEventNameChange={setCrossRefEventName}
              loading={crossRefLoading}
              result={crossRefResult}
              errorMsg={crossRefError}
              onCheck={handleCrossRef}
              onClear={handleCrossRefClear}
              onAddFighter={(name) => {
                setResult(null);
                setIngestType('fighter_profile');
                setRawText('');          // keep textarea empty — user must paste source
                setAddFighterHint(name); // show instruction banner instead
                setTimeout(() => {
                  pasteRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
                  pasteRef.current?.focus();
                }, 100);
              }}
            />

            {/* Paste area — hidden during success state */}
            {!result && (
              <>
                {/* Fight history: fighter selector */}
                {ingestType === 'fight_history' && (
                  <FighterSearch
                    selected={selectedFighter}
                    onSelect={setSelectedFighter}
                    autoFocus={!hasSession}
                  />
                )}

                {/* Source hint */}
                <div className="bg-surface/50 border border-border/40 rounded-lg p-3">
                  <p className="text-xs text-muted font-semibold mb-1 uppercase tracking-wider">Accepted Sources</p>
                  <p className="text-xs text-muted/60">
                    {ingestType === 'fighter_profile'
                      ? 'UFCStats · Tapology · Sherdog — paste full page text from any or all; each paste merges into the session'
                      : 'Sherdog fight history · Tapology history — paste full section; duplicate fights are automatically skipped'}
                  </p>
                </div>

                {parseAudit && parseAudit.status !== 'ok' && (
                  <div className={`rounded-xl border p-4 ${parseAudit?.status === 'mismatch' ? 'bg-red-500/10 border-red-500/30' : 'bg-yellow-500/10 border-yellow-500/30'}`}>
                    <div className="flex items-center gap-3 mb-2">
                      <AlertTriangle size={18} className={parseAudit?.status === 'mismatch' ? 'text-red-400' : 'text-yellow-400'} />
                      <h4 className={`text-sm font-bold ${parseAudit?.status === 'mismatch' ? 'text-red-400' : 'text-yellow-400'}`}>
                        {parseAudit?.status === 'mismatch' ? 'Data Mismatch Detected' : 'Conflict Resolution Required'}
                      </h4>
                    </div>
                  </div>
                )}

                {/* "+Add" instruction banner — shown when operator clicked Add for a missing fighter */}
                {addFighterHint && (
                  <div className="bg-accent/10 border border-accent/30 rounded-xl px-4 py-3 flex items-start gap-3 animate-in fade-in slide-in-from-top-2 duration-300">
                    <Zap size={15} className="text-accent shrink-0 mt-0.5" />
                    <div className="flex-1 min-w-0">
                      <p className="text-xs font-bold text-accent mb-0.5">
                        Adding: <span className="font-mono">{addFighterHint}</span>
                      </p>
                      <p className="text-[11px] text-muted/80">
                        Paste this fighter's full profile page from <strong className="text-text/70">UFCStats</strong>, <strong className="text-text/70">Tapology</strong>, or <strong className="text-text/70">Sherdog</strong> below, then click Parse.
                      </p>
                    </div>
                    <button onClick={() => setAddFighterHint(null)} className="text-muted hover:text-text shrink-0">
                      <X size={13} />
                    </button>
                  </div>
                )}

                {/* Raw text */}
                <div className="flex-1 flex flex-col min-h-0">
                  <div className="flex items-center justify-between mb-1">
                    <label className="text-xs font-semibold text-muted">
                      Raw Source Text
                      {hasSession && (
                        <span className="ml-2 text-accent">
                          (Paste {(session?.pasteCount ?? 0) + 1})
                        </span>
                      )}
                    </label>
                    <div className="flex items-center gap-2">
                      {hasSession && (
                        <span className="text-[10px] text-muted/50">Session active — new paste will merge</span>
                      )}
                      <input
                        ref={fileInputRef}
                        type="file"
                        accept=".docx,.txt,.md,.csv"
                        className="hidden"
                        onChange={handleFileSelected}
                      />
                      <button
                        onClick={() => fileInputRef.current?.click()}
                        disabled={uploadingFile}
                        className="flex items-center gap-1 text-[10px] font-bold uppercase tracking-wide px-2 py-1 rounded border border-border/60 text-muted hover:text-accent hover:border-accent/40 disabled:opacity-40 transition-colors"
                      >
                        <Upload size={11} />
                        {uploadingFile ? 'Extracting...' : 'Upload File'}
                      </button>
                    </div>
                  </div>
                  {uploadedFileName && !uploadError && (
                    <div className="flex items-center gap-1.5 mb-2 text-[10px] text-accent/80">
                      <FileText size={10} /> Loaded from {uploadedFileName} — review below, then Parse
                    </div>
                  )}
                  {uploadError && (
                    <div className="mb-2 text-[10px] text-red-400 bg-red-500/10 border border-red-500/20 rounded px-2 py-1.5">
                      {uploadError}
                    </div>
                  )}
                  <textarea
                    ref={pasteRef}
                    className="flex-1 w-full bg-surface border border-border rounded-lg p-3 text-xs font-mono resize-none focus:outline-none focus:border-accent placeholder-muted/30 min-h-[200px]"
                    placeholder={`Paste ${ingestType === 'fighter_profile' ? 'fighter profile' : 'fight history'} from UFCStats, Tapology, or Sherdog...`}
                    value={rawText}
                    onChange={e => setRawText(e.target.value)}
                  />
                </div>

                {/* Parse button */}
                <button
                  onClick={handleParse}
                  disabled={parsing || !rawText.trim() || (ingestType === 'fight_history' && !selectedFighter)}
                  className="w-full py-3 bg-accent rounded-lg font-bold text-sm text-white hover:bg-accent/90 disabled:opacity-40 disabled:cursor-not-allowed flex items-center justify-center gap-2"
                >
                  <Zap size={16} />
                  {parsing
                    ? 'Parsing with AI...'
                    : hasSession
                    ? `Parse & Merge (Paste ${(session?.pasteCount ?? 0) + 1})`
                    : 'Parse with AI'}
                </button>

                {ingestType === 'fight_history' && !selectedFighter && (
                  <p className="text-[10px] text-yellow-400/70 text-center -mt-2">
                    Select a fighter first
                  </p>
                )}
              </>
            )}

            {/* Prompt to continue after success */}
            {result && (
              <div className="flex-1 border border-dashed border-green-500/20 rounded-xl flex flex-col items-center justify-center text-center p-6 gap-3">
                <CheckCircle size={28} className="text-green-400/50" />
                <p className="text-sm text-muted font-semibold">Ready for next fighter</p>
                <p className="text-xs text-muted/40">Use "+ Add" above or start a new paste</p>
              </div>
            )}
          </div>

          {/* ── Right: Session / Preview pane ─────────────────────────────── */}
          <div className="flex flex-col gap-4 min-h-0">

            {/* Success state — shown in right column, scan stays visible left */}
            {result && (
              <div className="bg-green-500/10 border border-green-500/20 rounded-xl p-5 flex items-start gap-4 animate-in fade-in slide-in-from-top-2 duration-300">
                <CheckCircle className="text-green-400 shrink-0 mt-0.5" size={20} />
                <div className="flex-1 min-w-0">
                  <h3 className="font-bold text-green-400 mb-1">
                    {result.fights_created !== undefined
                      ? [
                          `${result.fights_created} fight(s) saved`,
                          result.fights_skipped  > 0 ? `${result.fights_skipped} skipped` : null,
                          result.fighters_created > 0 ? `${result.fighters_created} new opponent shell(s) created` : null,
                        ].filter(Boolean).join(' · ')
                      : `Fighter ${result.action}: ${result.name}`}
                  </h3>
                  {result.fighter_id && (
                    <p className="text-xs text-muted font-mono truncate">{result.fighter_id}</p>
                  )}
                  {/* Push status badge */}
                  <div className="flex items-center gap-2 mt-2">
                    {result.push_status === 'pushed' && (
                      <span className="inline-flex items-center gap-1 text-[10px] font-black uppercase px-2 py-0.5 rounded-full bg-green-500/20 text-green-400 border border-green-500/30">
                        <CheckCircle size={9} /> Pushed to GRIT
                      </span>
                    )}
                    {result.push_status === 'review_required' && (
                      <span className="inline-flex items-center gap-1 text-[10px] font-black uppercase px-2 py-0.5 rounded-full bg-yellow-500/10 text-yellow-400 border border-yellow-500/20">
                        <Clock size={9} /> Saved for review
                      </span>
                    )}
                    {result.push_status === 'fighter_not_in_grit' && (
                      <span className="inline-flex items-center gap-1 text-[10px] font-black uppercase px-2 py-0.5 rounded-full bg-yellow-500/10 text-yellow-400 border border-yellow-500/20">
                        ⚠ Fighter not yet in GRIT — push fighter first
                      </span>
                    )}
                    {result.push_status === 'no_url' && (
                      <span className="inline-flex items-center gap-1 text-[10px] font-black uppercase px-2 py-0.5 rounded-full bg-muted/10 text-muted border border-border/30">
                        Push skipped — MAIN_APP_API_URL not set
                      </span>
                    )}
                    {result.push_status === 'error' && (
                      <span className="inline-flex items-center gap-1 text-[10px] font-black uppercase px-2 py-0.5 rounded-full bg-red-500/10 text-red-400 border border-red-500/20">
                        ✖ Push error — check logs
                      </span>
                    )}
                  </div>
                </div>
                <button onClick={handleReset} className="text-sm text-accent hover:underline shrink-0 whitespace-nowrap">
                  Next Fighter
                </button>
              </div>
            )}

            {/* Duplicate Fighter Warning (NEW) */}
            {duplicateWarning && (
              <div className="bg-yellow-500/10 border border-yellow-500/30 rounded-xl p-4 flex items-start gap-3 animate-in fade-in slide-in-from-top-2 duration-300">
                <AlertTriangle className="text-yellow-400 shrink-0 mt-0.5" size={20} />
                <div className="flex-1">
                  <div className="flex items-center justify-between">
                    <p className="text-sm font-bold text-yellow-400">Potential Duplicate Detected</p>
                    <button onClick={() => setDuplicateWarning(null)} className="text-muted hover:text-white"><X size={14} /></button>
                  </div>
                  <p className="text-xs text-muted mt-1">
                    <span className="text-white font-bold">{duplicateWarning.name}</span> already exists in the database. 
                    Adding them again will create a duplicate record.
                  </p>
                  <div className="flex gap-3 mt-3">
                    <a 
                      href={`/fighters/${duplicateWarning.id}`} 
                      target="_blank" 
                      className="text-[10px] font-bold uppercase px-3 py-1.5 bg-yellow-500/20 text-yellow-400 rounded hover:bg-yellow-500/30 transition-colors"
                    >
                      View Existing Fighter
                    </a>
                    <button 
                      onClick={() => setDuplicateWarning(null)}
                      className="text-[10px] font-bold uppercase px-3 py-1.5 bg-white/5 text-muted rounded hover:bg-white/10 transition-colors"
                    >
                      Ignore & Proceed
                    </button>
                  </div>
                </div>
              </div>
            )}

            {/* Empty */}
            {!session && !parseError && !parsing && (
              <div className="flex-1 border border-dashed border-border/30 rounded-xl flex flex-col items-center justify-center text-center p-8">
                <GitMerge size={32} className="text-muted/20 mb-3" />
                <p className="text-muted text-sm font-semibold">Session empty</p>
                <p className="text-xs text-muted/40 mt-1">
                  Paste from UFCStats, Tapology, or Sherdog — each paste merges into the same profile
                </p>
              </div>
            )}

            {/* Loading */}
            {parsing && (
              <div className="flex-1 border border-border/20 rounded-xl flex flex-col items-center justify-center text-center p-8">
                <div className="w-8 h-8 border-2 border-accent border-t-transparent rounded-full animate-spin mb-3" />
                <p className="text-muted text-sm">Extracting &amp; merging with Claude...</p>
              </div>
            )}

            {/* Error */}
            {parseError && !parsing && (
              <div className={`border rounded-xl p-4 flex items-start gap-3 shrink-0 ${
                parseError.retryable
                  ? 'bg-yellow-500/10 border-yellow-500/20'
                  : 'bg-red-500/10 border-red-500/20'
              }`}>
                <AlertTriangle size={18} className={`shrink-0 mt-0.5 ${parseError.retryable ? 'text-yellow-400' : 'text-red-400'}`} />
                <div className="flex-1">
                  <p className={`text-sm font-semibold mb-1 ${parseError.retryable ? 'text-yellow-400' : 'text-red-400'}`}>
                    {parseError.retryable ? 'Service Busy' : 'Error'}
                  </p>
                  <p className="text-xs text-muted">{parseError.message}</p>
                  <div className="flex items-center gap-3 mt-2">
                    {parseError.retryable && (
                      <button
                        onClick={() => { setParseError(null); }}
                        className="text-xs text-yellow-400 hover:underline font-semibold"
                      >
                        Dismiss &amp; Retry
                      </button>
                    )}
                    <button onClick={() => setParseError(null)} className="text-xs text-accent hover:underline">
                      Dismiss
                    </button>
                  </div>
                </div>
              </div>
            )}

            {/* OpenAI Audit Banner */}
            {parseAudit && parseAudit.status === 'mismatch' && parseAudit.issues.length > 0 && !parsing && (
              <div className="shrink-0 border border-orange-500/40 bg-orange-500/8 rounded-xl p-4">
                <div className="flex items-start justify-between gap-3 mb-3">
                  <div className="flex items-center gap-2">
                    <AlertTriangle size={16} className="text-orange-400 shrink-0" />
                    <span className="text-sm font-bold text-orange-400">
                      Audit Flag — {parseAudit.issues.length} mismatch{parseAudit.issues.length !== 1 ? 'es' : ''} detected
                    </span>
                  </div>
                  <button
                    onClick={() => setParseAudit(null)}
                    className="text-muted hover:text-text"
                  >
                    <X size={14} />
                  </button>
                </div>
                <p className="text-xs text-muted mb-3">
                  OpenAI compared raw text to parsed output and flagged the following. Review before approving.
                </p>
                <div className="space-y-2">
                  {parseAudit.issues.map((issue, i) => (
                    <div key={i} className="bg-black/20 rounded-lg px-3 py-2 text-xs">
                      <div className="flex items-center gap-2 mb-1">
                        <span className="font-mono font-bold text-orange-300 uppercase tracking-wide">
                          {issue.field}
                        </span>
                      </div>
                      <div className="grid grid-cols-2 gap-2">
                        <div>
                          <span className="text-muted/60">Raw text says: </span>
                          <span className="font-semibold text-green-400">{issue.raw_value}</span>
                        </div>
                        <div>
                          <span className="text-muted/60">Parsed as: </span>
                          <span className="font-semibold text-red-400">{issue.parsed_value}</span>
                        </div>
                      </div>
                      <p className="text-muted/70 mt-1 italic">{issue.reason}</p>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Active session */}
            {session && !parsing && (
              <div className="flex flex-col gap-4 animate-in fade-in slide-in-from-right-4 duration-500 min-h-0 h-full">
                {/* Merge Mode Banner */}
                <div className="bg-purple-600/20 border border-purple-500/30 rounded-xl px-4 py-3 flex items-center justify-between shadow-lg shadow-purple-500/10">
                  <div className="flex items-center gap-3">
                    <div className="w-8 h-8 rounded-lg bg-purple-500/20 flex items-center justify-center animate-pulse">
                        <GitMerge size={16} className="text-purple-400" />
                    </div>
                    <div>
                        <p className="text-[10px] font-black uppercase tracking-[0.2em] text-purple-400 leading-none">Status</p>
                        <p className="text-xs font-bold text-white mt-1">Merge Session Active</p>
                    </div>
                  </div>
                  <div className="text-[10px] font-black uppercase tracking-widest text-purple-400/60">
                    Paste {session.pasteCount + 1} Pending
                  </div>
                </div>

                {/* Field Coverage Panel — shown after fighter_profile parse */}
                {parseCoverage && session.type === 'fighter_profile' && (
                  <div className="bg-bg border border-border/40 rounded-xl p-3 shrink-0 animate-in fade-in duration-300">
                    <div className="flex items-center justify-between mb-2">
                      <span className="text-[10px] font-black uppercase tracking-widest text-muted">Field Coverage — {parseCoverage.name}</span>
                      <div className="flex items-center gap-2">
                        <div className="h-1.5 w-24 bg-white/10 rounded-full overflow-hidden">
                          <div
                            className={`h-full rounded-full transition-all ${parseCoverage.pct >= 70 ? 'bg-green-400' : parseCoverage.pct >= 40 ? 'bg-yellow-400' : 'bg-red-400'}`}
                            style={{ width: `${parseCoverage.pct}%` }}
                          />
                        </div>
                        <span className={`text-[10px] font-black tabular-nums ${parseCoverage.pct >= 70 ? 'text-green-400' : parseCoverage.pct >= 40 ? 'text-yellow-400' : 'text-red-400'}`}>
                          {parseCoverage.pct}%
                        </span>
                        <button onClick={() => setParseCoverage(null)} className="text-muted/40 hover:text-muted ml-1">
                          <X size={10} />
                        </button>
                      </div>
                    </div>
                    <div className="flex flex-wrap gap-x-3 gap-y-0.5">
                      {parseCoverage.filled.map(f => (
                        <span key={f} className="text-[9px] text-green-400/80">✔ {f}</span>
                      ))}
                      {parseCoverage.missing.map(f => (
                        <span key={f} className="text-[9px] text-red-400/60">✖ {f}</span>
                      ))}
                    </div>
                  </div>
                )}

                {/* Session controls bar */}
                <div className="flex items-center justify-between gap-3 shrink-0">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-bold">Aggregated Profile</span>
                    <Badge color="purple">
                      {session.pasteCount} paste{session.pasteCount !== 1 ? 's' : ''}
                    </Badge>
                    {conflictCount > 0 && (
                      <Badge color="yellow">{conflictCount} conflict{conflictCount !== 1 ? 's' : ''}</Badge>
                    )}
                    {conflictCount === 0 && session.pasteCount > 0 && (
                      <Badge color="green">No conflicts</Badge>
                    )}
                  </div>
                  <div className="flex items-center gap-2">
                    {session.type === 'fighter_profile' && (
                      <button
                        onClick={() => setEditMode(e => !e)}
                        className="flex items-center gap-1 text-xs text-accent hover:underline"
                      >
                        <Edit2 size={11} />
                        {editMode ? 'View' : 'Edit Fields'}
                      </button>
                    )}
                    <button
                      onClick={handleUndo}
                      disabled={!canUndo}
                      title="Undo last paste"
                      className="flex items-center gap-1 text-xs text-muted hover:text-text disabled:opacity-30"
                    >
                      <RotateCcw size={12} />
                      Undo
                    </button>
                    <button
                      onClick={handleClear}
                      title="Clear session"
                      className="flex items-center gap-1 text-xs text-red-400/70 hover:text-red-400"
                    >
                      <Trash2 size={12} />
                      Clear
                    </button>
                  </div>
                </div>

                {/* Conflicts */}
                {conflictCount > 0 && (
                  <ConflictPanel
                    conflicts={session.conflicts}
                    onAccept={acceptNew}
                    onKeep={keepCurrent}
                  />
                )}

                {/* Fight history: require fighter */}
                {session.type === 'fight_history' && !selectedFighter && (
                  <div className="bg-yellow-500/5 border border-yellow-500/20 rounded-lg p-3 shrink-0">
                    <p className="text-xs text-yellow-400 font-semibold">
                      ⚠ Select a fighter above to link this history before approving
                    </p>
                  </div>
                )}

                {/* Data view */}
                <div className="flex-1 overflow-auto min-h-0 bg-surface border border-border rounded-xl p-4">
                  {session.type === 'fighter_profile' ? (
                    <ProfileForm
                      data={session.aggregated}
                      editMode={editMode}
                      onChange={handleFieldChange}
                      corrections={correctionHistory}
                    />
                  ) : (
                    <HistoryList
                      bouts={session.bouts}
                      onResolveConflict={resolveBoutResultConflict}
                    />
                  )}
                </div>

                {/* Approve / Reject */}
                <div className="flex gap-3 shrink-0">
                  <button
                    onClick={handleApprove}
                    disabled={approving || !canApprove || conflictCount > 0}
                    title={conflictCount > 0 ? 'Resolve all conflicts before approving' : undefined}
                    className="flex-1 py-3 bg-green-600 rounded-lg font-bold text-sm text-white hover:bg-green-500 disabled:opacity-40 disabled:cursor-not-allowed flex items-center justify-center gap-2"
                  >
                    <CheckCircle size={16} />
                    {approving
                      ? 'Saving...'
                      : conflictCount > 0
                      ? `Resolve ${conflictCount} conflict${conflictCount !== 1 ? 's' : ''} first`
                      : 'Approve & Save to Database'}
                  </button>

                  <button
                    onClick={handleClear}
                    className="px-4 py-3 bg-red-500/10 border border-red-500/20 rounded-lg font-bold text-sm text-red-400 hover:bg-red-500/20 flex items-center justify-center gap-2"
                  >
                    <XCircle size={16} />
                    Clear Session
                  </button>
                </div>

                <p className="text-[10px] text-muted/40 text-center shrink-0">
                  Saves as <strong>unverified + pending</strong>. Conflicts must be resolved before approving.
                </p>
              </div>
            )}
          </div>
        </div>
      {/* ── SESSION PROGRESS WIDGET ── */}
      {session && (
        <div className="fixed bottom-8 left-8 z-[60] bg-surface/90 backdrop-blur-xl border border-accent/20 rounded-2xl p-4 shadow-2xl flex items-center gap-6 animate-in slide-in-from-left-8 duration-500">
          <div className="flex flex-col">
            <span className="text-[10px] font-black uppercase tracking-widest text-muted">Session Progress</span>
            <div className="flex items-center gap-2 mt-1">
              <ListChecks size={14} className="text-accent" />
              <span className="text-sm font-bold tabular-nums">
                {session.completedFighters + 1} / {session.totalFighters}
              </span>
            </div>
          </div>
          <div className="w-px h-8 bg-white/10" />
          <div className="flex flex-col">
            <span className="text-[10px] font-black uppercase tracking-widest text-muted">Avg Time</span>
            <div className="flex items-center gap-2 mt-1">
              <Clock size={14} className="text-muted" />
              <span className="text-sm font-bold tabular-nums">
                {Math.round((Date.now() - session.startTime) / 1000 / (session.completedFighters || 1))}s
              </span>
            </div>
          </div>
        </div>
      )}

      {/* ── SESSION SUMMARY MODAL ── */}
      {sessionEndStats && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center p-6 backdrop-blur-sm bg-black/40">
          <div className="glass-card max-w-md w-full p-8 rounded-[2rem] border-accent/20 shadow-[0_0_50px_rgba(255,184,0,0.15)] animate-in zoom-in-95 duration-300">
            <div className="flex flex-col items-center text-center">
              <div className="w-16 h-16 bg-accent/10 rounded-full flex items-center justify-center mb-6">
                <BarChart3 size={32} className="text-accent glow-accent" />
              </div>
              <h2 className="text-2xl font-black uppercase tracking-tighter mb-2 italic">Session Complete</h2>
              <p className="text-muted text-sm mb-8">Metrics for your final optimization report</p>
              
              <div className="grid grid-cols-2 gap-4 w-full mb-8">
                <div className="bg-white/5 rounded-2xl p-4 flex flex-col items-center">
                  <span className="text-2xl font-black tabular-nums">{sessionEndStats.count}</span>
                  <span className="text-[10px] font-black uppercase tracking-widest text-muted mt-1">Processed</span>
                </div>
                <div className="bg-white/5 rounded-2xl p-4 flex flex-col items-center">
                  <span className="text-2xl font-black tabular-nums">{Math.round(sessionEndStats.avg)}s</span>
                  <span className="text-[10px] font-black uppercase tracking-widest text-muted mt-1">Avg / Fighter</span>
                </div>
                <div className="col-span-2 bg-accent/10 rounded-2xl p-4 flex flex-col items-center border border-accent/20">
                  <span className="text-2xl font-black tabular-nums">{Math.round(sessionEndStats.total / 60)}m {Math.round(sessionEndStats.total % 60)}s</span>
                  <span className="text-[10px] font-black uppercase tracking-widest text-accent mt-1">Total Session Time</span>
                </div>
              </div>

              <button 
                onClick={() => setSessionEndStats(null)}
                className="w-full py-4 bg-accent text-black font-black uppercase tracking-widest rounded-xl hover:scale-105 transition-all shadow-[0_0_20px_rgba(255,184,0,0.3)]"
              >
                Close Report
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
