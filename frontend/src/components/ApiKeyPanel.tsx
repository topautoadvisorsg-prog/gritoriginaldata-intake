import { useState, useEffect } from 'react';
import { KeyRound, CheckCircle2, XCircle, Save, Eye, EyeOff, ChevronDown, ChevronUp } from 'lucide-react';
import { getKeysStatus, saveApiKeys } from '../api';

export interface KeyDef {
  name: string;
  label: string;
  description: string;
  required: boolean;
  placeholder?: string;
}

interface Props {
  keys: KeyDef[];
  agentLabel: string;
}

export const ApiKeyPanel = ({ keys, agentLabel }: Props) => {
  const [status, setStatus] = useState<Record<string, boolean>>({});
  const [values, setValues] = useState<Record<string, string>>({});
  const [visible, setVisible] = useState<Record<string, boolean>>({});
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState<string[]>([]);
  const [error, setError] = useState('');
  const [open, setOpen] = useState(false);

  const fetchStatus = async () => {
    try {
      const res = await getKeysStatus();
      setStatus(res.data);
      // If any required key is missing, auto-expand
      const anyMissing = keys.some(k => k.required && !res.data[k.name]);
      if (anyMissing) setOpen(true);
    } catch {
      // ignore
    }
  };

  useEffect(() => { fetchStatus(); }, []);

  const handleSave = async () => {
    const toSave: Record<string, string> = {};
    for (const k of keys) {
      if (values[k.name]?.trim()) {
        toSave[k.name] = values[k.name].trim();
      }
    }
    if (Object.keys(toSave).length === 0) return;

    setSaving(true);
    setError('');
    setSaved([]);
    try {
      await saveApiKeys(toSave);
      setSaved(Object.keys(toSave));
      setValues({});
      await fetchStatus();
    } catch (e: any) {
      setError(e?.response?.data?.detail || 'Failed to save keys.');
    } finally {
      setSaving(false);
    }
  };

  const missingRequired = keys.filter(k => k.required && !status[k.name]);
  const allSet = keys.every(k => !k.required || status[k.name]);

  return (
    <div className="border border-border rounded-xl overflow-hidden">
      {/* Header / toggle */}
      <button
        onClick={() => setOpen(o => !o)}
        className="w-full flex items-center justify-between px-5 py-4 bg-surface hover:bg-white/[0.03] transition-colors"
      >
        <div className="flex items-center gap-3">
          <KeyRound size={16} className={allSet ? 'text-green' : 'text-gold'} />
          <span className="text-sm font-bold">API Keys — {agentLabel}</span>
          {missingRequired.length > 0 && (
            <span className="px-2 py-0.5 bg-gold/10 text-gold border border-gold/30 rounded text-[10px] uppercase font-black">
              {missingRequired.length} missing
            </span>
          )}
          {allSet && (
            <span className="px-2 py-0.5 bg-green/10 text-green border border-green/30 rounded text-[10px] uppercase font-black">
              all set
            </span>
          )}
        </div>
        {open ? <ChevronUp size={16} className="text-muted" /> : <ChevronDown size={16} className="text-muted" />}
      </button>

      {open && (
        <div className="px-5 py-5 bg-bg/50 border-t border-border space-y-4">
          {keys.map(k => {
            const isSet = status[k.name];
            const show = visible[k.name];
            return (
              <div key={k.name}>
                <div className="flex items-center justify-between mb-1.5">
                  <div className="flex items-center gap-2">
                    <label className="text-sm font-bold">{k.label}</label>
                    {k.required ? (
                      <span className="text-[10px] uppercase font-black text-accent">required</span>
                    ) : (
                      <span className="text-[10px] uppercase font-black text-muted">optional</span>
                    )}
                  </div>
                  <div className="flex items-center gap-1.5">
                    {isSet ? (
                      <span className="flex items-center gap-1 text-green text-[11px] font-bold">
                        <CheckCircle2 size={13} /> Set
                      </span>
                    ) : (
                      <span className="flex items-center gap-1 text-gold text-[11px] font-bold">
                        <XCircle size={13} /> Not set
                      </span>
                    )}
                  </div>
                </div>
                <p className="text-[11px] text-muted mb-2">{k.description}</p>
                <div className="relative">
                  <input
                    type={show ? 'text' : 'password'}
                    placeholder={isSet ? '••••••••••••••••  (already set — paste to update)' : (k.placeholder || `Enter ${k.label}...`)}
                    value={values[k.name] || ''}
                    onChange={e => setValues(v => ({ ...v, [k.name]: e.target.value }))}
                    className="w-full bg-surface border border-border rounded-lg px-4 py-2.5 pr-10 text-sm font-mono focus:outline-none focus:border-accent placeholder:text-muted/40"
                  />
                  <button
                    type="button"
                    onClick={() => setVisible(v => ({ ...v, [k.name]: !v[k.name] }))}
                    className="absolute right-3 top-1/2 -translate-y-1/2 text-muted hover:text-text"
                  >
                    {show ? <EyeOff size={15} /> : <Eye size={15} />}
                  </button>
                </div>
                {saved.includes(k.name) && (
                  <p className="text-green text-[11px] mt-1 font-bold">Saved successfully.</p>
                )}
              </div>
            );
          })}

          {error && (
            <p className="text-accent text-xs bg-accent/10 border border-accent/30 rounded px-3 py-2">{error}</p>
          )}

          <div className="flex justify-end pt-1">
            <button
              onClick={handleSave}
              disabled={saving || Object.values(values).every(v => !v?.trim())}
              className="flex items-center gap-2 bg-accent hover:bg-accent/90 text-white px-5 py-2 rounded-lg font-bold text-sm transition-colors disabled:opacity-40"
            >
              <Save size={14} />
              {saving ? 'Saving...' : 'Save Keys'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
};
