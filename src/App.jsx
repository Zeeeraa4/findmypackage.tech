import { useCallback, useEffect, useMemo, useState } from 'react';
import { HashRouter, Routes, Route, useParams } from 'react-router-dom';
import { supabase } from './lib/supabaseClient';

const VAPID_PUBLIC_KEY = import.meta.env.VITE_VAPID_PUBLIC_KEY;

const CONSENT_TEXT =
  'I consent to receive high-urgency SMS alerts from Find My Package / Porch Pirate Alert regarding security incidents in my building. Message frequency varies. Msg & data rates may apply. Reply STOP to opt-out at any time.';

/* ---------- helpers ---------- */
function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64);
  return Uint8Array.from([...raw].map((c) => c.charCodeAt(0)));
}

function timeAgo(iso, now) {
  const s = Math.max(0, Math.floor((now - new Date(iso).getTime()) / 1000));
  if (s < 60) return 'just now';
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} mins ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} hrs ago`;
  const d = Math.floor(h / 24);
  return `${d} days ago`;
}

function formatE164(input) {
  const raw = String(input || '').trim();
  const digits = raw.replace(/\D/g, '');
  if (!digits) return '';
  if (raw.startsWith('+')) {
    const max = digits.startsWith('1') ? 11 : 15;
    return '+' + digits.slice(0, max);
  }
  const national = digits.startsWith('1') ? digits.slice(1) : digits;
  return '+1' + national.slice(0, 10);
}

/* ---------- layout wrapper sub-components ---------- */
function Shell({ children }) {
  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100 antialiased p-4 sm:p-6 lg:p-8">
      <div className="max-w-md mx-auto bg-zinc-900 border border-zinc-800 rounded-xl p-5 shadow-2xl mt-4">
        {children}
      </div>
    </div>
  );
}

function Header() {
  return (
    <div className="border-b border-zinc-800 pb-3 mb-4">
      <h1 className="text-xl font-black tracking-tight text-zinc-100">FIND MY PACKAGE</h1>
      <p className="text-xs font-bold text-red-500 uppercase tracking-widest">Porch Pirate Alert System</p>
    </div>
  );
}

/* ---------- main dashboard logic ---------- */
function Dashboard() {
  const { buildingId } = useParams(); // Automatically extracts the ID from /#/building/id links
  const [session, setSession] = useState(null);
  const [profile, setProfile] = useState(null);
  const [building, setBuilding] = useState(null);
  const [alerts, setAlerts] = useState([]);
  const [now, setNow] = useState(Date.now());
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({ location: '', suspect: '' });
  const [submitting, setSubmitting] = useState(false);
  const [joinCode, setJoinCode] = useState('');
  const [error, setError] = useState('');
  const [pushState, setPushState] = useState('idle');

  const [settingsOpen, setSettingsOpen] = useState(false);
  const [phoneInput, setPhoneInput] = useState('');
  const [consent, setConsent] = useState(false);
  const [savingPhone, setSavingPhone] = useState(false);
  const [phoneMsg, setPhoneMsg] = useState({ type: '', text: '' });

  const pushSupported = typeof window !== 'undefined' && 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => setSession(data.session));
    const { data: sub } = supabase.auth.onAuthStateChange((_e, s) => setSession(s));
    return () => sub.subscription.unsubscribe();
  }, []);

  const loadProfile = useCallback(async () => {
    if (!session) return;
    const { data: p } = await supabase.from('users').select('*').eq('id', session.user.id).maybeSingle();
    setProfile(p);
    setPhoneInput(p?.phone_number || '');
    
    // Fallback lookups: if route has a building ID, use it; otherwise use the profile default building
    const targetBuildingId = buildingId || p?.building_id;
    if (targetBuildingId) {
      const { data: b } = await supabase.from('buildings').select('id,name,street_address').eq('id', targetBuildingId).maybeSingle();
      setBuilding(b);
    }
  }, [session, buildingId]);

  useEffect(() => { loadProfile(); }, [loadProfile]);

  useEffect(() => {
    const targetBid = buildingId || profile?.building_id;
    if (!targetBid) return;

    supabase.from('alerts').select('*').eq('building_id', targetBid)
      .order('created_at', { ascending: false }).limit(50)
      .then(({ data }) => setAlerts(data || []));

    const channel = supabase.channel(`alerts:${targetBid}`)
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'alerts', filter: `building_id=eq.${targetBid}` },
        (payload) => setAlerts((prev) => prev.some((a) => a.id === payload.new.id) ? prev : [payload.new, ...prev])
      ).subscribe();

    return () => { supabase.removeChannel(channel); };
  }, [profile?.building_id, buildingId]);

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30000);
    return () => clearInterval(t);
  }, []);

  async function handleSavePhone(e) {
    e.preventDefault();
    setSavingPhone(true);
    setPhoneMsg({ type: '', text: '' });
    try {
      const formatted = formatE164(phoneInput);
      const { error: err } = await supabase.rpc('save_sms_consent', { p_phone: formatted, p_consent: consent });
      if (err) throw err;
      setPhoneMsg({ type: 'success', text: 'Phone settings updated and locked securely.' });
      loadProfile();
    } catch (err) {
      setPhoneMsg({ type: 'error', text: err.message || 'Failed to register configurations.' });
    } finally {
      setSavingPhone(false);
    }
  }

  async function handleJoin(e) {
    e.preventDefault();
    setError('');
    const { error: err } = await supabase.from('users').update({ building_id: joinCode }).eq('id', session.user.id);
    if (err) return setError('Invalid building validation path.');
    loadProfile();
  }

  async function handleSubmit(e) {
    e.preventDefault();
    setSubmitting(true);
    setError('');
    const targetBid = buildingId || profile.building_id;
    const { error: err } = await supabase.from('alerts').insert({
      building_id: targetBid,
      reporter_id: session.user.id,
      incident_location: form.location.trim(),
      suspect_description: form.suspect.trim(),
    });
    setSubmitting(false);
    if (err) return setError(err.message || 'Could not send alert. Rate limits apply.');
    setForm({ location: '', suspect: '' });
    setShowForm(false);
  }

  async function enablePush() {
    setError('');
    if (!pushSupported) return setPushState('unsupported');
    setPushState('working');
    try {
      const permission = await Notification.requestPermission();
      if (permission !== 'granted') return setPushState('denied');
      const reg = await navigator.serviceWorker.register('/sw.js');
      await navigator.serviceWorker.ready;
      const existing = await reg.pushManager.getSubscription();
      const subscription = existing || await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY),
      });
      await supabase.from('users').update({ push_subscription: subscription.toJSON() }).eq('id', session.user.id);
      setPushState('enabled');
    } catch (e) {
      setError('Could not enable system notifications.');
      setPushState('idle');
    }
  }

  const sorted = useMemo(() => [...alerts].sort((a, b) => new Date(b.created_at) - new Date(a.created_at)), [alerts]);

  if (!session) {
    return (
      <Shell>
        <Header />
        <p className="text-center text-zinc-400 mt-20">Please sign in to monitor properties.</p>
        <button onClick={() => supabase.auth.signInWithOAuth({ provider: 'google' })} className="mt-6 w-full rounded-lg bg-zinc-800 py-2.5 font-bold border border-zinc-700 hover:bg-zinc-700 transition">
          Sign In with Google
        </button>
      </Shell>
    );
  }

  if (profile && !profile.building_id && !buildingId) {
    return (
      <Shell>
        <Header />
        <form onSubmit={handleJoin} className="mt-8 space-y-4">
          <h2 className="text-lg font-bold">Join your building</h2>
          <input value={joinCode} onChange={(e) => setJoinCode(e.target.value)} placeholder="Building validation code" className="w-full font-mono rounded-lg bg-zinc-950 border border-zinc-800 px-4 py-3 text-sm focus:border-red-800 focus:outline-none transition" />
          {error && <p className="text-sm text-red-400">{error}</p>}
          <button className="w-full rounded-lg bg-red-800 py-3 font-bold hover:bg-red-700 transition">Join Node</button>
        </form>
      </Shell>
    );
  }

  return (
    <Shell>
      <div className="flex justify-between items-center border-b border-zinc-800 pb-2 mb-4">
        <div>
          <h1 className="text-lg font-black tracking-tight text-zinc-100">FIND MY PACKAGE</h1>
          <p className="text-xs font-bold text-red-500 uppercase tracking-widest flex items-center gap-1.5">
            <span className="w-2 h-2 rounded-full bg-red-500 animate-pulse"></span> Live Radar Active
          </p>
        </div>
        <button onClick={() => setSettingsOpen(!settingsOpen)} className="text-xs bg-zinc-950 border border-zinc-800 px-2.5 py-1.5 rounded-lg text-zinc-400 hover:bg-zinc-800 transition">
          {settingsOpen ? 'Close' : '⚙️ SMS Setup'}
        </button>
      </div>

      {settingsOpen && (
        <form onSubmit={handleSavePhone} className="bg-zinc-950 border border-zinc-800 rounded-lg p-4 mb-4 space-y-3">
          <h3 className="text-xs font-bold text-zinc-300">Carrier Opt-In Profile</h3>
