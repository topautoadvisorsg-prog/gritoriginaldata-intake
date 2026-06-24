import { useState, useEffect } from 'react';
import { Activity, RefreshCcw, CheckCircle, XCircle, Clock, Play, Zap, Wifi, AlertTriangle, RotateCcw } from 'lucide-react';
import { getPipelineJobs, triggerProcessQueue, testConnection, pushFighter, retryPipelineJob } from '../api';
import { ApiKeyPanel, type KeyDef } from '../components/ApiKeyPanel';

const MONITOR_KEYS: KeyDef[] = [
  {
    name: 'ANTHROPIC_API_KEY',
    label: 'Anthropic API Key',
    required: true,
    description: 'Required for the CrewAI pipeline (Agents 1–5). Powers fighter profile scraping, fight history, news analysis, and AI summaries. Missing this stops the entire pipeline. Get it at console.anthropic.com.',
    placeholder: 'sk-ant-...',
  },
  {
    name: 'DATA_ENGINE_API_KEY',
    label: 'GRIT Data Engine API Key',
    required: true,
    description: 'Auth key used when pushing processed fighter and event data to the GRIT main app via webhook. Without this, pushes will be rejected. Provided by the GRIT platform.',
    placeholder: '',
  },
  {
    name: 'MAIN_APP_API_URL',
    label: 'GRIT App URL',
    required: true,
    description: 'Base URL of the GRIT platform (e.g. https://gritoriginal-production.up.railway.app). All webhook pushes and fight-card lookups go here. Missing this means no data reaches the main app.',
    placeholder: 'https://gritoriginal-production.up.railway.app',
  },
  {
    name: 'SUPABASE_API_KEY',
    label: 'Supabase Service Key',
    required: true,
    description: 'Used by all agents to read and write fighter profiles, fight history, news, and odds to the Supabase database. Without this the pipeline cannot store or retrieve any data. Get it from your Supabase project settings → API.',
    placeholder: 'eyJh...',
  },
];

type Job = {
  fighter_name: string;
  status: string;
  event_id: string;
  event_name: string;
  event_date: string;
  fighter_id: string | null;
  admin_status: string | null;
  attempt_count: number;
  last_error: string | null;
  queued_at: string | null;
  status_updated_at: string | null;
};

type ConnResult = { status: string; [key: string]: any };

const STATUS_LABEL: Record<string, string> = {
  complete:  'Complete',
  failed:    'Failed',
  queued:    'Queued',
  profiling: 'Profiling',
  history:   'History',
  imaging:   'Imaging',
};

const Monitor = () => {
  const [jobs, setJobs] = useState<Job[]>([]);
  const [loading, setLoading] = useState(true);
  const [processing, setProcessing] = useState(false);
  const [processMsg, setProcessMsg] = useState('');
  const [connResults, setConnResults] = useState<Record<string, ConnResult> | null>(null);
  const [connTesting, setConnTesting] = useState(false);
  const [expandedErrors, setExpandedErrors] = useState<Set<string>>(new Set());
  const [retrying, setRetrying] = useState<Set<string>>(new Set());

  const fetchJobs = async () => {
    try {
      const res = await getPipelineJobs();
      setJobs(res.data || []);
    } catch {
      // ignore
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchJobs();
    const interval = setInterval(fetchJobs, 10000);
    return () => clearInterval(interval);
  }, []);

  const handleProcessQueue = async () => {
    setProcessing(true);
    setProcessMsg('');
    try {
      await triggerProcessQueue();
      setProcessMsg('Queue processing started. Fighters will be profiled in the background (this may take several minutes per fighter).');
    } catch {
      setProcessMsg('Failed to trigger queue processing. Check backend connection.');
    } finally {
      setProcessing(false);
    }
  };

  const handleTestConnection = async () => {
    setConnTesting(true);
    setConnResults(null);
    try {
      const res = await testConnection();
      setConnResults(res.data.checks);
    } catch {
      setConnResults({ error: { status: 'error', detail: 'Could not reach backend.' } });
    } finally {
      setConnTesting(false);
    }
  };

  const handlePush = async (fighterId: string, name: string) => {
    try {
      await pushFighter(fighterId);
      alert(`Successfully pushed ${name} to GRIT!`);
    } catch (e: any) {
      alert(`Push failed: ${e.message}`);
    }
  };

  const handleRetry = async (fighterName: string) => {
    setRetrying(prev => new Set(prev).add(fighterName));
    try {
      await retryPipelineJob(fighterName);
      setProcessMsg(`Retry started for ${fighterName}. Refreshing shortly…`);
      setTimeout(fetchJobs, 2000);
    } catch (e: any) {
      alert(`Retry failed: ${e.message}`);
    } finally {
      setRetrying(prev => {
        const next = new Set(prev);
        next.delete(fighterName);
        return next;
      });
    }
  };

  const toggleError = (name: string) => {
    setExpandedErrors(prev => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  };

  const getStatusIcon = (status: string) => {
    switch (status) {
      case 'complete':  return <CheckCircle size={16} className="text-green" />;
      case 'failed':
      case 'error':     return <XCircle size={16} className="text-accent" />;
      case 'queued':    return <Clock size={16} className="text-muted" />;
      default:          return <RefreshCcw size={16} className="text-gold animate-spin" />;
    }
  };

  const hasError = (job: Job) => !!job.last_error && job.status !== 'complete';

  const statusCounts = jobs.reduce((acc: Record<string, number>, j) => {
    acc[j.status] = (acc[j.status] || 0) + 1;
    return acc;
  }, {});

  return (
    <div className="space-y-8">
      <div className="flex flex-wrap justify-between items-center gap-4">
        <h2 className="text-3xl font-bold flex items-center gap-3">
          <Activity className="text-accent" />
          Pipeline Monitor
        </h2>
        <div className="flex gap-3">
          <button
            onClick={handleTestConnection}
            disabled={connTesting}
            className="flex items-center gap-2 bg-surface border border-border px-4 py-2 rounded-lg hover:bg-white/5 transition-colors text-sm font-bold disabled:opacity-50"
          >
            <Wifi size={16} className={connTesting ? 'text-gold animate-pulse' : 'text-green'} />
            {connTesting ? 'Testing...' : 'Test Connection'}
          </button>
          <button
            onClick={handleProcessQueue}
            disabled={processing}
            className="flex items-center gap-2 bg-accent hover:bg-accent/90 text-white px-4 py-2 rounded-lg text-sm font-bold transition-colors disabled:opacity-50"
          >
            <Play size={16} />
            {processing ? 'Starting...' : 'Process Queue'}
          </button>
          <button
            onClick={() => { setLoading(true); fetchJobs(); }}
            className="bg-surface border border-border p-2 rounded-lg hover:bg-white/5 transition-colors"
          >
            <RefreshCcw size={18} className={loading ? 'animate-spin' : ''} />
          </button>
        </div>
      </div>

      {processMsg && (
        <p className="text-sm text-green bg-green/10 border border-green/30 rounded-lg px-4 py-3">{processMsg}</p>
      )}

      {jobs.length > 0 && (
        <div className="flex gap-3 flex-wrap">
          {Object.entries(statusCounts).map(([s, n]) => (
            <div key={s} className="px-3 py-1.5 bg-surface border border-border rounded-full text-xs font-bold flex items-center gap-2">
              {getStatusIcon(s)}
              <span className="uppercase tracking-widest">{STATUS_LABEL[s] ?? s}</span>
              <span className="text-muted ml-1">× {n}</span>
            </div>
          ))}
          <div className="px-3 py-1.5 bg-surface border border-border rounded-full text-xs font-bold flex items-center gap-2 text-muted">
            Total: {jobs.length}
          </div>
        </div>
      )}

      {connResults && (
        <div className="bg-surface border border-border rounded-xl overflow-hidden">
          <div className="px-6 py-4 bg-bg border-b border-border">
            <h3 className="font-bold text-sm flex items-center gap-2">
              <Wifi size={15} className="text-accent" />
              Connection Test Results
            </h3>
          </div>
          <div className="divide-y divide-border">
            {Object.entries(connResults).map(([key, result]) => (
              <div key={key} className="px-6 py-4 flex items-start gap-4">
                <div className="mt-0.5">
                  {result.status === 'ok' ? (
                    <CheckCircle size={16} className="text-green" />
                  ) : result.status === 'warning' ? (
                    <Zap size={16} className="text-gold" />
                  ) : (
                    <XCircle size={16} className="text-accent" />
                  )}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="font-bold text-sm capitalize">{key.replace(/_/g, ' ')}</div>
                  <div className="text-xs text-muted mt-1 font-mono break-all">
                    {JSON.stringify(result, null, 0).slice(0, 200)}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="bg-surface border border-border rounded-xl overflow-x-auto">
        <table className="w-full text-left">
          <thead className="bg-bg text-muted text-[10px] uppercase font-black tracking-[0.2em]">
            <tr>
              <th className="px-6 py-4">Fighter</th>
              <th className="px-6 py-4">Status</th>
              <th className="px-6 py-4">Attempts</th>
              <th className="px-6 py-4">Event</th>
              <th className="px-6 py-4">Event Date</th>
              <th className="px-6 py-4 text-center">Action</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {jobs.map((job) => (
              <tr
                key={job.fighter_name}
                className={`hover:bg-white/5 transition-colors ${job.status === 'failed' ? 'bg-accent/5' : ''}`}
              >
                <td className="px-6 py-4">
                  <div className="flex flex-col gap-1">
                    <div className="flex items-center gap-2 font-bold">
                      {job.fighter_name}
                      {hasError(job) && (
                        <button
                          onClick={() => toggleError(job.fighter_name)}
                          title={expandedErrors.has(job.fighter_name) ? 'Hide error' : 'Show error details'}
                          className="text-accent hover:text-accent/70 transition-colors flex-shrink-0"
                        >
                          <AlertTriangle size={14} />
                        </button>
                      )}
                    </div>
                    {hasError(job) && expandedErrors.has(job.fighter_name) && (
                      <div className="border border-accent/20 rounded-lg p-3 mt-1 bg-accent/5">
                        <div className="text-[10px] uppercase font-black text-accent tracking-widest mb-1.5 flex items-center gap-1">
                          <AlertTriangle size={9} />
                          Last Error
                          {job.status_updated_at && (
                            <span className="text-muted font-normal normal-case tracking-normal ml-2">
                              {new Date(job.status_updated_at).toLocaleString()}
                            </span>
                          )}
                        </div>
                        <pre className="text-xs text-muted font-mono whitespace-pre-wrap break-all leading-relaxed max-w-xl">
                          {job.last_error}
                        </pre>
                      </div>
                    )}
                  </div>
                </td>
                <td className="px-6 py-4">
                  <div className="flex items-center gap-2">
                    {getStatusIcon(job.status)}
                    <span className={`text-xs uppercase font-bold tracking-widest ${job.status === 'failed' ? 'text-accent' : ''}`}>
                      {STATUS_LABEL[job.status] ?? job.status}
                    </span>
                  </div>
                </td>
                <td className="px-6 py-4">
                  {(job.attempt_count ?? 0) > 0 ? (
                    <span className={`text-xs font-mono ${job.attempt_count >= 3 ? 'text-accent' : 'text-gold'}`}>
                      {job.attempt_count}/3
                    </span>
                  ) : (
                    <span className="text-muted text-xs">—</span>
                  )}
                </td>
                <td className="px-6 py-4 text-sm text-muted">{job.event_name || '—'}</td>
                <td className="px-6 py-4 text-xs text-muted font-mono">
                  {job.event_date ? job.event_date.split('T')[0] : '—'}
                </td>
                <td className="px-6 py-4 text-center">
                  <div className="flex items-center justify-center gap-2">
                    {job.status === 'complete' && job.fighter_id ? (
                      job.admin_status === 'approved' ? (
                        <button
                          onClick={() => handlePush(job.fighter_id!, job.fighter_name)}
                          className="text-[10px] bg-green/20 text-green border border-green/30 px-3 py-1 rounded hover:bg-green/30 transition-colors uppercase font-black"
                        >
                          Push
                        </button>
                      ) : (
                        <button
                          disabled
                          title="Approve in Review first"
                          className="text-[10px] bg-surface text-muted border border-border px-3 py-1 rounded uppercase font-black cursor-not-allowed opacity-50"
                        >
                          Push
                        </button>
                      )
                    ) : null}
                    {(job.status === 'failed' || job.status === 'error') && (
                      <button
                        onClick={() => handleRetry(job.fighter_name)}
                        disabled={retrying.has(job.fighter_name)}
                        title="Force retry this fighter from the beginning"
                        className="text-[10px] bg-gold/20 text-gold border border-gold/30 px-3 py-1 rounded hover:bg-gold/30 transition-colors uppercase font-black flex items-center gap-1 disabled:opacity-50"
                      >
                        <RotateCcw size={10} />
                        {retrying.has(job.fighter_name) ? 'Starting…' : 'Retry'}
                      </button>
                    )}
                    {job.status !== 'complete' && job.status !== 'failed' && job.status !== 'error' && (
                      <span className="text-muted text-[10px]">—</span>
                    )}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {jobs.length === 0 && !loading && (
          <div className="p-12 text-center text-muted italic">No fighters in pipeline queue. Scan an event to get started.</div>
        )}
      </div>

      <ApiKeyPanel keys={MONITOR_KEYS} agentLabel="Pipeline — CrewAI &amp; GRIT Webhook" />
    </div>
  );
};

export default Monitor;
