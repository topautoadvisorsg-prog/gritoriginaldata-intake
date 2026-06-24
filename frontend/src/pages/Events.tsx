import { useState, useEffect } from 'react';
import { Calendar, MapPin, Trophy, Users } from 'lucide-react';
import api from '../api';
import { ApiKeyPanel, type KeyDef } from '../components/ApiKeyPanel';

const EVENTS_KEYS: KeyDef[] = [
  {
    name: 'MAIN_APP_API_URL',
    label: 'GRIT App URL',
    required: true,
    description: 'Base URL of the GRIT platform (e.g. https://gritoriginal-production.up.railway.app). Used to push event data and fight cards to the main app. Missing this means events cannot be sent.',
    placeholder: 'https://gritoriginal-production.up.railway.app',
  },
  {
    name: 'DATA_ENGINE_API_KEY',
    label: 'GRIT Data Engine API Key',
    required: true,
    description: 'Auth key sent with every push to the GRIT main app webhook. Without this, the main app will reject all incoming event data. Provided by the GRIT platform.',
    placeholder: '',
  },
];

const Events = () => {
  const [events, setEvents] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api.get('/events').then(res => {
      setEvents(res.data);
      setLoading(false);
    }).catch(() => setLoading(false));
  }, []);

  return (
    <div className="space-y-8">
      <h2 className="text-3xl font-bold">MMA Events</h2>
      
      <div className="grid grid-cols-1 gap-4">
        {loading ? [1,2].map(i => (
          <div key={i} className="h-32 bg-surface rounded-xl border border-border animate-pulse"></div>
        )) : events.map((event: any) => (
          <div key={event.id} className="bg-surface rounded-xl border border-border p-6 flex items-center justify-between hover:border-accent/40 transition-colors">
            <div className="flex gap-6 items-center">
              <div className="w-16 h-16 bg-bg rounded-lg border border-border flex flex-col items-center justify-center">
                <div className="text-[10px] uppercase font-bold text-accent">{new Date(event.date).toLocaleString('default', { month: 'short' })}</div>
                <div className="text-xl font-black">{new Date(event.date).getDate()}</div>
              </div>
              <div>
                <h3 className="text-xl font-bold mb-1">{event.name}</h3>
                <div className="flex gap-4 text-sm text-muted">
                  <div className="flex items-center gap-1.5"><Trophy size={14} className="text-gold" /> {event.organization}</div>
                  <div className="flex items-center gap-1.5"><MapPin size={14} /> {event.venue || event.city}</div>
                </div>
              </div>
            </div>
            
            <div className="flex items-center gap-8">
               <div className="text-center">
                 <div className="text-xs uppercase font-bold text-muted mb-1">Status</div>
                 <div className={`px-2 py-1 rounded text-[10px] uppercase font-black tracking-widest ${
                   event.status?.toUpperCase() === 'OPEN' ? 'bg-green/10 text-green' : 'bg-blue-500/10 text-blue-400'
                 }`}>{event.status}</div>
               </div>
               <button className="bg-bg border border-border hover:border-accent hover:text-accent px-6 py-2 rounded-lg font-bold transition-all">
                 View Bouts
               </button>
            </div>
          </div>
        ))}
        {!loading && events.length === 0 && (
          <div className="bg-surface/50 border border-dashed border-border rounded-xl p-12 text-center text-muted">
             No events scanned yet. Trigger a scan from the dashboard.
          </div>
        )}
      </div>

      {/* API Key Config */}
      <ApiKeyPanel keys={EVENTS_KEYS} agentLabel="Agent 1 — Event Scanner" />
    </div>
  );
};

export default Events;
