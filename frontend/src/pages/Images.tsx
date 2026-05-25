import { useState, useEffect, useRef, type RefObject } from 'react';
import {
  Image, Upload, RefreshCcw, CheckCircle, AlertTriangle, X, User, PersonStanding,
  Copy, Check,
} from 'lucide-react';
import { getAllFighterImages, uploadFighterImage } from '../api';

type FilterMode = 'missing_headshot' | 'missing_body' | 'complete';

type Fighter = {
  id: string;
  first_name: string;
  last_name: string;
  weight_class: string | null;
  image_url: string | null;
  body_image_url: string | null;
  needs_image: boolean | null;
  image_source?: string | null;
  ai_generated?: boolean | null;
};

type ModalState = {
  fighter: Fighter;
  imageType: 'headshot' | 'body_shot';
  file: File;
  previewUrl: string;
};

const isPlaceholder = (url: string | null | undefined) =>
  !url || url.includes('via.placeholder.com');

const hasHeadshot = (f: Fighter) => !isPlaceholder(f.image_url);
const hasBodyShot = (f: Fighter) => !isPlaceholder(f.body_image_url);
const isComplete  = (f: Fighter) => hasHeadshot(f) && hasBodyShot(f);

const HEADSHOT_PROMPT =
  'Professional MMA fighter portrait, 512x512, centered face, sharp lighting, black background, photorealistic, high detail';

const BODY_PROMPT =
  'Professional MMA fighter half-body portrait, 600x800 aspect, sharp lighting, black background, photorealistic, no icons';

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };
  return (
    <button
      onClick={copy}
      className="flex items-center gap-1.5 text-[10px] uppercase font-black tracking-wide px-3 py-1.5 rounded-lg border border-border bg-bg hover:border-accent/40 hover:text-accent transition-colors text-muted"
    >
      {copied ? <Check size={11} className="text-green" /> : <Copy size={11} />}
      {copied ? 'Copied' : 'Copy'}
    </button>
  );
}

const FILTERS: { key: FilterMode; label: string; getCount: (fighters: Fighter[]) => number }[] = [
  { key: 'missing_headshot', label: 'Missing Headshot', getCount: fs => fs.filter(f => !hasHeadshot(f)).length },
  { key: 'missing_body',     label: 'Missing Body',     getCount: fs => fs.filter(f => !hasBodyShot(f)).length },
  { key: 'complete',         label: 'Complete',          getCount: fs => fs.filter(isComplete).length },
];

const Images = () => {
  const [fighters, setFighters] = useState<Fighter[]>([]);
  const [loading, setLoading]   = useState(true);
  const [filter, setFilter]     = useState<FilterMode | null>(null);
  const [modal, setModal]       = useState<ModalState | null>(null);
  const [importing, setImporting] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);
  const hsRef   = useRef<HTMLInputElement | null>(null);
  const bodyRef = useRef<HTMLInputElement | null>(null);

  const fetchFighters = async () => {
    setLoading(true);
    try {
      const res = await getAllFighterImages();
      setFighters(res.data || []);
    } catch {
      setFighters([]);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { fetchFighters(); }, []);

  const filtered = filter === null
    ? fighters
    : fighters.filter(f => {
        if (filter === 'missing_headshot') return !hasHeadshot(f);
        if (filter === 'missing_body')     return !hasBodyShot(f);
        if (filter === 'complete')         return isComplete(f);
        return true;
      });

  const openFileDialog = (
    fighter: Fighter,
    imageType: 'headshot' | 'body_shot',
    ref: RefObject<HTMLInputElement | null>,
  ) => {
    if (!ref.current) return;
    ref.current.dataset.fighterJson = JSON.stringify(fighter);
    ref.current.dataset.imageType   = imageType;
    ref.current.value = '';
    ref.current.click();
  };

  const handleFileChosen = (
    e: React.ChangeEvent<HTMLInputElement>,
    imageType: 'headshot' | 'body_shot',
  ) => {
    const file = e.target.files?.[0];
    const json = e.target.dataset.fighterJson;
    if (!file || !json) return;
    const fighter: Fighter = JSON.parse(json);
    setImportError(null);
    setModal({ fighter, imageType, file, previewUrl: URL.createObjectURL(file) });
  };

  const handleApprove = async () => {
    if (!modal) return;
    setImporting(true);
    setImportError(null);
    try {
      const res = await uploadFighterImage(modal.fighter.id, modal.imageType, modal.file);
      const newUrl = res.data.url;
      setFighters(prev =>
        prev.map(f => {
          if (f.id !== modal.fighter.id) return f;
          if (modal.imageType === 'headshot') {
            return { ...f, image_url: newUrl, image_source: 'manual', needs_image: false };
          }
          return { ...f, body_image_url: newUrl, ai_generated: false };
        }),
      );
      URL.revokeObjectURL(modal.previewUrl);
      setModal(null);
    } catch (e: any) {
      setImportError(e?.response?.data?.detail || e?.message || 'Upload failed.');
    } finally {
      setImporting(false);
    }
  };

  const handleCancel = () => {
    if (modal) URL.revokeObjectURL(modal.previewUrl);
    setModal(null);
    setImportError(null);
  };

  const slotLabel = modal?.imageType === 'headshot' ? 'Headshot' : 'Body';

  return (
    <div className="space-y-6">
      {/* Hidden file inputs */}
      <input ref={hsRef}   type="file" accept="image/*" className="hidden" onChange={e => handleFileChosen(e, 'headshot')} />
      <input ref={bodyRef} type="file" accept="image/*" className="hidden" onChange={e => handleFileChosen(e, 'body_shot')} />

      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-3xl font-bold flex items-center gap-3">
            <Image className="text-accent" size={28} />
            Fighter Images
          </h2>
          <p className="text-muted text-sm mt-1">Upload and manage fighter headshots and body images</p>
        </div>
        <button
          onClick={fetchFighters}
          className="bg-surface border border-border p-2.5 rounded-lg hover:bg-white/5 transition-colors"
          title="Refresh"
        >
          <RefreshCcw size={18} className={loading ? 'animate-spin text-muted' : 'text-muted'} />
        </button>
      </div>

      {/* ── SOP Panel ─────────────────────────────────────────── */}
      <div className="border border-border bg-surface rounded-xl overflow-hidden">
        <div className="px-6 py-4 border-b border-border">
          <div className="text-[11px] uppercase font-black tracking-widest text-muted">Standard Operating Procedure</div>
          <div className="font-bold text-lg mt-0.5">Image SOP — Prompts + Sizes</div>
        </div>

        <div className="grid md:grid-cols-2 divide-y md:divide-y-0 md:divide-x divide-border">
          {/* Headshot */}
          <div className="p-5 space-y-3">
            <div className="flex items-center justify-between">
              <div>
                <div className="text-[10px] uppercase font-black tracking-widest text-muted">Headshot Prompt</div>
                <div className="text-xs text-muted mt-0.5">Mandatory Size: <span className="text-accent font-bold">512 × 512</span></div>
              </div>
              <CopyButton text={HEADSHOT_PROMPT} />
            </div>
            <div className="bg-bg border border-border rounded-lg px-4 py-3 text-sm text-text/90 leading-relaxed font-mono">
              {HEADSHOT_PROMPT}
            </div>
          </div>

          {/* Body */}
          <div className="p-5 space-y-3">
            <div className="flex items-center justify-between">
              <div>
                <div className="text-[10px] uppercase font-black tracking-widest text-muted">Body Image Prompt</div>
                <div className="text-xs text-muted mt-0.5">Mandatory Size: <span className="text-accent font-bold">600 × 800</span></div>
              </div>
              <CopyButton text={BODY_PROMPT} />
            </div>
            <div className="bg-bg border border-border rounded-lg px-4 py-3 text-sm text-text/90 leading-relaxed font-mono">
              {BODY_PROMPT}
            </div>
          </div>
        </div>

        {/* Workflow steps */}
        <div className="border-t border-border px-6 py-4">
          <div className="text-[10px] uppercase font-black tracking-widest text-muted mb-3">Operator Workflow</div>
          <ol className="flex flex-wrap gap-x-8 gap-y-2">
            {[
              'Agent 1 finds fighters',
              'Check: exists? skip. New? create.',
              'Copy prompt → generate externally (Midjourney / DALL·E / etc.)',
              'Upload headshot + body image below',
              'Done — clean, consistent, controlled',
            ].map((step, i) => (
              <li key={i} className="flex items-start gap-2 text-xs text-muted min-w-[180px]">
                <span className="shrink-0 w-5 h-5 rounded-full bg-accent/10 border border-accent/30 text-accent text-[10px] font-black flex items-center justify-center mt-0.5">
                  {i + 1}
                </span>
                {step}
              </li>
            ))}
          </ol>
        </div>
      </div>

      {/* ── Filters ───────────────────────────────────────────── */}
      <div className="flex flex-wrap items-center gap-2">
        <button
          onClick={() => setFilter(null)}
          className={`px-4 py-2 rounded-lg text-sm font-bold uppercase tracking-wide border transition-colors ${
            filter === null
              ? 'bg-accent/10 border-accent/40 text-accent'
              : 'bg-surface border-border text-muted hover:text-text'
          }`}
        >
          All ({fighters.length})
        </button>
        {FILTERS.map(({ key, label, getCount }) => (
          <button
            key={key}
            onClick={() => setFilter(key)}
            className={`px-4 py-2 rounded-lg text-sm font-bold uppercase tracking-wide border transition-colors ${
              filter === key
                ? 'bg-accent/10 border-accent/40 text-accent'
                : 'bg-surface border-border text-muted hover:text-text'
            }`}
          >
            {label} ({getCount(fighters)})
          </button>
        ))}
      </div>

      {/* ── Fighter Grid ──────────────────────────────────────── */}
      {loading ? (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-5">
          {[...Array(8)].map((_, i) => (
            <div key={i} className="bg-surface border border-border rounded-xl h-64 animate-pulse" />
          ))}
        </div>
      ) : filtered.length === 0 ? (
        <div className="bg-surface border border-border rounded-xl p-16 text-center">
          <Image size={40} className="mx-auto mb-4 text-muted/30" />
          <p className="text-muted">No fighters match this filter.</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-5">
          {filtered.map(f => {
            const hs   = hasHeadshot(f);
            const hb   = hasBodyShot(f);
            const done = hs && hb;
            const name = `${f.first_name ?? ''} ${f.last_name ?? ''}`.trim();

            return (
              <div
                key={f.id}
                className={`bg-surface border rounded-xl overflow-hidden ${
                  done ? 'border-green/20' : 'border-border'
                }`}
              >
                {/* Card header */}
                <div className="px-4 pt-4 pb-2 flex items-start justify-between gap-2">
                  <div>
                    <div className="text-[10px] uppercase font-bold text-muted tracking-widest">
                      {f.weight_class ?? '—'}
                    </div>
                    <div className="font-bold text-sm leading-tight">{name}</div>
                  </div>
                  <div className="shrink-0 mt-0.5">
                    {done ? (
                      <span className="flex items-center gap-1 text-[10px] text-green font-black uppercase">
                        <CheckCircle size={11} /> Complete
                      </span>
                    ) : (
                      <span className="flex items-center gap-1 text-[10px] text-gold font-black uppercase">
                        <AlertTriangle size={11} /> Incomplete
                      </span>
                    )}
                  </div>
                </div>

                {/* Image slots */}
                <div className="grid grid-cols-2 gap-2 px-4 pb-4">
                  {/* Headshot */}
                  <div className="space-y-1.5">
                    <div className="flex items-center gap-1 text-[9px] uppercase font-black text-muted tracking-widest">
                      <User size={9} /> Headshot
                    </div>
                    <div
                      className="h-32 rounded-lg overflow-hidden bg-bg cursor-pointer group relative"
                      onClick={() => openFileDialog(f, 'headshot', hsRef)}
                      title="Upload headshot"
                    >
                      {hs ? (
                        <>
                          <img
                            src={f.image_url!}
                            alt={`${name} headshot`}
                            className="w-full h-full object-cover"
                            onError={e => { (e.target as HTMLImageElement).style.display = 'none'; }}
                          />
                          <div className="absolute inset-0 bg-black/50 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center">
                            <Upload size={18} className="text-white" />
                          </div>
                        </>
                      ) : (
                        <div className="w-full h-full flex flex-col items-center justify-center gap-1 text-muted/30 group-hover:text-accent/50 transition-colors">
                          <User size={20} />
                          <span className="text-[8px] uppercase font-bold">Missing</span>
                        </div>
                      )}
                    </div>
                    <button
                      onClick={() => openFileDialog(f, 'headshot', hsRef)}
                      className="w-full flex items-center justify-center gap-1 text-[9px] uppercase font-black py-1.5 rounded-lg bg-bg border border-border hover:border-accent/40 hover:text-accent transition-colors text-muted"
                    >
                      <Upload size={9} />
                      {hs ? 'Replace' : 'Upload'}
                    </button>
                  </div>

                  {/* Body */}
                  <div className="space-y-1.5">
                    <div className="flex items-center gap-1 text-[9px] uppercase font-black text-muted tracking-widest">
                      <PersonStanding size={9} /> Body
                    </div>
                    <div
                      className="h-32 rounded-lg overflow-hidden bg-bg cursor-pointer group relative"
                      onClick={() => openFileDialog(f, 'body_shot', bodyRef)}
                      title="Upload body image"
                    >
                      {hb ? (
                        <>
                          <img
                            src={f.body_image_url!}
                            alt={`${name} body`}
                            className="w-full h-full object-cover"
                            onError={e => { (e.target as HTMLImageElement).style.display = 'none'; }}
                          />
                          <div className="absolute inset-0 bg-black/50 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center">
                            <Upload size={18} className="text-white" />
                          </div>
                        </>
                      ) : (
                        <div className="w-full h-full flex flex-col items-center justify-center gap-1 text-muted/30 group-hover:text-accent/50 transition-colors">
                          <PersonStanding size={20} />
                          <span className="text-[8px] uppercase font-bold">Missing</span>
                        </div>
                      )}
                    </div>
                    <button
                      onClick={() => openFileDialog(f, 'body_shot', bodyRef)}
                      className="w-full flex items-center justify-center gap-1 text-[9px] uppercase font-black py-1.5 rounded-lg bg-bg border border-border hover:border-accent/40 hover:text-accent transition-colors text-muted"
                    >
                      <Upload size={9} />
                      {hb ? 'Replace' : 'Upload'}
                    </button>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* ── Upload preview modal ──────────────────────────────── */}
      {modal && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-4"
          onClick={e => { if (e.target === e.currentTarget) handleCancel(); }}
        >
          <div className="bg-surface border border-border rounded-2xl w-full max-w-md overflow-hidden">
            <div className="flex items-center justify-between px-6 py-4 border-b border-border">
              <div>
                <div className="font-bold">
                  {modal.fighter.first_name} {modal.fighter.last_name} — {slotLabel}
                </div>
                <div className="text-xs text-muted mt-0.5">{modal.file.name}</div>
              </div>
              <button onClick={handleCancel} className="text-muted hover:text-text transition-colors">
                <X size={20} />
              </button>
            </div>

            <div className="bg-bg flex items-center justify-center p-4" style={{ minHeight: 240 }}>
              <img
                src={modal.previewUrl}
                alt="Preview"
                className={`object-contain rounded-lg ${
                  modal.imageType === 'headshot' ? 'max-h-60 max-w-60' : 'max-h-72 max-w-44'
                }`}
              />
            </div>

            {importError && (
              <div className="mx-6 mt-4 flex items-start gap-2 border border-accent/30 bg-accent/5 rounded-lg p-3 text-xs text-accent">
                <AlertTriangle size={14} className="shrink-0 mt-0.5" />
                {importError}
              </div>
            )}

            <div className="px-6 py-4 flex gap-3">
              <button
                onClick={handleCancel}
                disabled={importing}
                className="flex-1 py-2.5 rounded-xl border border-border text-sm font-bold text-muted hover:text-text hover:border-text/30 transition-colors disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                onClick={handleApprove}
                disabled={importing}
                className="flex-1 py-2.5 rounded-xl bg-green/20 border border-green/40 text-green text-sm font-bold hover:bg-green/30 transition-colors disabled:opacity-50 flex items-center justify-center gap-2"
              >
                {importing ? (
                  <><RefreshCcw size={14} className="animate-spin" /> Importing…</>
                ) : (
                  <><CheckCircle size={14} /> Approve &amp; Import</>
                )}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default Images;
