import axios from 'axios';

const api = axios.create({
  // Dev: hit '/api' so Vite's proxy forwards to the backend (and strips '/api').
  // Prod (single Railway service): FastAPI serves this dashboard, so call the
  // API on the same origin at the root ('') — e.g. '/pipeline/stats'.
  baseURL: import.meta.env.VITE_API_URL || (import.meta.env.DEV ? '/api' : ''),
});

// Stats
export const getStats = () => api.get('/pipeline/stats');

// Fighters
export const getFighters = () => api.get('/fighters');
export const getRecentFighters = () => api.get('/fighters/recent');
export const pushFighter = (id: string) => api.post(`/pipeline/push/fighter/${id}`);

// Events
export const getEvents = () => api.get('/events');
export const scanEvent = (eventName: string) => api.post('/events/scan', { event_name: eventName });
export const crossReferenceEvent = (eventName: string) =>
  api.post('/events/cross-reference', { event_name: eventName });

// News
export const getNews = () => api.get('/news');
export const pushNews = (id: string) => api.post(`/pipeline/push/news/${id}`);

// Pipeline monitor
export const getPipelineJobs = () => api.get('/pipeline/jobs');
export const triggerProcessQueue = () => api.post('/pipeline/process-queue');
export const testConnection = () => api.get('/pipeline/test-connection');
export const retryPipelineJob = (fighterName: string) =>
  api.post(`/pipeline/retry/${encodeURIComponent(fighterName)}`);

// Odds (Agent 6)
export const getOdds = (status?: string) => api.get('/odds', { params: status ? { status } : {} });
export const triggerOddsPull = () => api.post('/odds/pull');
export const approveOdds = (id: string) => api.patch(`/odds/${id}/approve`);
export const rejectOdds = (id: string) => api.patch(`/odds/${id}/reject`);
export const deleteOdds = (id: string) => api.delete(`/odds/${id}`);

// Images (Agent 7 + manual upload)
export const getPendingImages = () => api.get('/images/pending');
export const getAllFighterImages = () => api.get('/images/all');
export const generateImage = (fighterId: string) => api.post(`/images/generate/${fighterId}`);
export const generateAllImages = () => api.post('/images/generate-all');
export const clearImage = (fighterId: string) => api.patch(`/images/clear/${fighterId}`);

export const uploadFighterImage = (
  fighterId: string,
  imageType: 'headshot' | 'body_shot',
  file: File,
) => {
  const form = new FormData();
  form.append('image', file);
  form.append('image_type', imageType);
  return api.post<{ url: string; image_type: string }>(
    `/images/upload/${fighterId}`,
    form,
    { headers: { 'Content-Type': 'multipart/form-data' } },
  );
};

// Fighter (individual)
export const getFighter = (id: string) => api.get(`/pipeline/review/fighters/${id}`);

// Fighter verification
export const verifyFighter = (id: string, isVerified: boolean) =>
  api.patch(`/fighters/${id}/verify`, { is_verified: isVerified });
export const bulkDeleteUnverified = () =>
  api.delete('/fighters/unverified', { data: { confirm: 'DELETE_UNVERIFIED' } });

// Manual Ingestion
export const ingestRaw = (payload: { type: string; raw_text: string; fighter_name?: string }) =>
  api.post('/ingest/raw', payload);
export const ingestApprove = (payload: { type: string; data: any; fighter_id?: string }) =>
  api.post('/ingest/approve', payload);
export const searchFightersForIngest = (q: string) =>
  api.get(`/ingest/fighters/search?q=${encodeURIComponent(q)}`);
export const extractIngestFile = (file: File) => {
  const form = new FormData();
  form.append('file', file);
  return api.post<{ status: string; filename: string; text: string }>(
    '/ingest/extract-file',
    form,
    { headers: { 'Content-Type': 'multipart/form-data' } },
  );
};

// API Key Config
export const getKeysStatus = () => api.get<Record<string, boolean>>('/config/keys/status');
export const saveApiKeys = (keys: Record<string, string>) => api.post('/config/keys', { keys });

// Pipeline Review Dashboard
export const getReviewCounts    = () => api.get('/pipeline/review/counts');
export const getReviewFighters  = (status = 'pending') => api.get('/pipeline/review/fighters', { params: { status } });
export const getReviewFighter   = (id: string) => api.get(`/pipeline/review/fighters/${id}`);
export const approveFighter     = (id: string) => api.patch(`/pipeline/review/fighters/${id}/approve`);
export const rejectFighter      = (id: string) => api.patch(`/pipeline/review/fighters/${id}/reject`);
export const restoreFighter     = (id: string) => api.patch(`/pipeline/review/fighters/${id}/restore`);
export const editFighter        = (id: string, fields: Record<string, string>) =>
  api.put(`/pipeline/review/fighters/${id}`, { fields });
export const getReviewNews      = (status = 'pending') => api.get('/pipeline/review/news', { params: { status } });
export const approveNews        = (id: string) => api.patch(`/pipeline/review/news/${id}/approve`);
export const rejectNews         = (id: string) => api.patch(`/pipeline/review/news/${id}/reject`);
export const editNews           = (id: string, fields: Record<string, string>) =>
  api.put(`/pipeline/review/news/${id}`, { fields });
export const getNeedsAttention  = () => api.get('/pipeline/review/needs-attention');
export const getActivityLog     = (params?: Record<string, string>) =>
  api.get('/pipeline/activity-log', { params });

export default api;
