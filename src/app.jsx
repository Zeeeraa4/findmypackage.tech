import { useCallback, useEffect, useMemo, useState } from 'react';
import { HashRouter, Routes, Route, useParams } from 'react-router-dom';
import { supabase } from './lib/supabaseClient';

const VAPID_PUBLIC_KEY = import.meta.env.VITE_VAPID_PUBLIC_KEY;
const CONSENT_TEXT = 'I consent to receive high-urgency SMS alerts from Find My Package / Porch Pirate Alert regarding security incidents in my building. Message frequency varies. Msg & data rates may apply. Reply STOP to opt-out at any time.';

function urlBase64ToUint8Array(str) {
  const padding = '='.repeat((4 - (str.length % 4)) % 4);
  const base64 = (str + padding).replace(/-/g, '+').replace(/_/g, '/');
  return Uint8Array.from([...atob(base64)].map((c) => c.charCodeAt(0)));
}

function timeAgo(iso, now) {
  const s = Math.max(0, Math.floor((now - new Date(iso).getTime()) / 1000));
  if (s < 60) return 'just now';
  const m = Math.floor(s / 60);
  return m < 60 ? `${m}m ago` : `${Math.floor(m/60)}h ago`;
}

function Dashboard() {
  const { buildingId } = useParams();
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
    const bid = buildingId || p?.building_id;
    if (bid) {
      const { data: b } = await supabase.from('buildings').select('id,name,street_address').eq('id', bid).maybeSingle();
      setBuilding(b);
    }
  }, [session, buildingId]);

  useEffect(() => { loadProfile(); }, [loadProfile]);

  useEffect(() => {
    const bid = buildingId || profile?.building_id;
    if (!bid) return;
    supabase.from('alerts').select('*').eq('building_id', bid).order('created_at', { ascending: false }).then(({ data }) => setAlerts(data || []));
    const channel = supabase.channel(`alerts:${bid}`).on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'alerts', filter: `building_id=eq.${bid}` }, (payload) => {
      setAlerts((prev) => prev.some((a) => a.id === payload.new.id) ? prev : [payload.new, ...prev]);
    }).subscribe();
    return () => { supabase.removeChannel(channel); };
  }, [profile?.building_id, buildingId]);

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30000);
    return () => clearInterval(t);
  }, []);

  async function handleSavePhone(e) {
    e.preventDefault(); setSavingPhone(true); setPhoneMsg({ type: '', text: '' });
    try {
      await supabase.rpc('save_sms_consent', { p_phone: phoneInput.trim(), p_consent: consent });
      setPhoneMsg({ type: 'success', text: 'Phone settings secure.' }); loadProfile();
    } catch (err) { setPhoneMsg({ type: 'error', text: err.message }); } finally { setSavingPhone(false); }
  }

  async function handleJoin(e) {
    e.preventDefault(); setError('');
    const { error: err } = await supabase.from('users').update({ building_id: joinCode.trim() }).eq('id', session.user.id);
    if (err) return setError('Invalid code.'); loadProfile();
  }

  async function handleSubmit(e) {
    e.preventDefault(); setSubmitting(true); setError('');
    const bid = buildingId || profile.building_id;
    const { error: err } = await supabase.from('alerts').insert({ building_id: bid, reporter_id: session.user.id, incident_location: form.location.trim(), suspect_description: form.suspect.trim() });
    setSubmitting(false);
    if (err) return setError(err.message); setForm({ location: '', suspect: '' }); setShowForm(false);
  }

  async function enablePush() {
    if (!('serviceWorker' in navigator)) return;
    setPushState('working');
    try {
      const permission = await Notification.requestPermission();
      if (permission !== 'granted') return setPushState('denied');
      const reg = await navigator.serviceWorker.register('/sw.js');
      const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY) });
      await supabase.from('users').update({ push_subscription: sub.toJSON() }).eq('id', session.user.id);
      setPushState('enabled');
    } catch { setPushState('idle'); }
  }

  if (!session) {
    return (
      <div className="flex flex-col items-center justify-center min-h-screen bg-zinc-950 p-4">
        <h1 className="text-xl font-black mb-4">FIND MY PACKAGE</h1>
        <button onClick={() => supabase.auth.signInWithOAuth({ provider: 'google' })} className="bg-zinc-900 border border-zinc-800 px-6 py-3 rounded-xl hover:bg-zinc-800 transition font-bold">Sign In with Google</button>
      </div>
    );
  }

  if (profile && !profile.building_id && !buildingId) {
    return (
      <div className="max-w-md mx-auto p-6 bg-zinc-900 border border-zinc-800 rounded-xl mt-20">
        <form onSubmit={handleJoin} className="space-y-4">
          <h2 className="text-lg font-bold">Join Your Building Node</h2>
          <input value={joinCode} onChange={(e) => setJoinCode(e.target.value)} placeholder="Building security hash" className="w-full font-mono bg-zinc-950 border border-zinc-800 px-4 py-3 rounded-lg text-sm outline-none focus:border-red-800" />
          {error && <p className="text-xs text-red-400">{error}</p>}
          <button className="w-full bg-red-800 py-3 rounded-lg font-bold hover:bg-red-700">Link Complex</button>
        </form>
      </div>
    );
  }

  return (
    <div className="max-w-md mx-auto p-4 sm:p-6 bg-zinc-900 border border-zinc-800 rounded-xl shadow-2xl mt-6">
      <div className="flex justify-between items-center border-b border-zinc-800 pb-3 mb-4">
        <div>
          <h1 className="text-lg font-black tracking-tight">FIND MY PACKAGE</h1>
          <p className="text-xs font-bold text-red-500 uppercase tracking-widest flex items-center gap-1.5"><span className="w-2 h-2 rounded-full bg-red-500 animate-pulse"></span> Radar Live</p>
        </div>
        <button onClick={() => setSettingsOpen(!settingsOpen)} className="text-xs bg-zinc-950 border border-zinc-800 px-3 py-1.5 rounded-lg text-zinc-400">{settingsOpen ? 'Close' : '⚙️ Setup'}</button>
      </div>

      {settingsOpen && (
        <form onSubmit={handleSavePhone} className="bg-zinc-950 border border-zinc-800 rounded-lg p-4 mb-4 space-y-3">
          <h3 className="text-xs font-bold text-zinc-300">Carrier Compliance Profile</h3>
          <input type="tel" placeholder="+12065551234" value={phoneInput} onChange={(e) => setPhoneInput(e.target.value)} className="w-full bg-zinc-900 border border-zinc-800 rounded-lg px-3 py-2 text-xs font-mono outline-none text-zinc-100" />
          <label className="flex gap-2 items-start text-[10px] text-zinc-400 select-none">
            <input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} className="mt-0.5" />
            <span>{CONSENT_TEXT}</span>
          </label>
          {phoneMsg.text && <p className={`text-xs ${phoneMsg.type === 'success' ? 'text-green-400' : 'text-red-400'}`}>{phoneMsg.text}</p>}
          <button className="w-full bg-zinc-800 py-2 rounded text-xs font-bold hover:bg-zinc-700 transition">{savingPhone ? 'Locking...' : 'Save Phone Configuration'}</button>
        </form>
      )}

      <div className="bg-zinc-950 border border-zinc-800 rounded-lg p-3 text-xs mb-4">
        <p className="font-bold text-zinc-300">📍 Monitored Zone: {building?.name || 'Loading matrix…'}</p>
        <p className="text-zinc-500 mt-0.5">{building?.street_address}</p>
      </div>

      {pushState !== 'enabled' && (
        <div className="bg-zinc-950 border border-zinc-800 rounded-lg p-3 text-xs mb-4 flex justify-between items-center gap-4">
          <p className="text-zinc-400">Enable lock-screen alarms on this browser node.</p>
          <button onClick={enablePush} className="bg-red-950/40 border border-red-900 text-red-400 px-3 py-1.5 rounded font-bold hover:bg-red-900/20">{pushState === 'working' ? 'Sync...' : 'Activate'}</button>
        </div>
      )}

      <button onClick={() => setShowForm(!showForm)} className="w-full bg-red-800 hover:bg-red-700 text-white font-bold py-3 rounded-lg text-xs uppercase tracking-wider transition mb-4">{showForm ? 'Collapse Panel' : '🚨 Trigger Building Alert'}</button>

      {showForm && (
        <form onSubmit={handleSubmit} className="bg-zinc-950 border border-zinc-800 rounded-lg p-4 mb-4 space-y-3">
          <div>
            <label className="block text-[10px] text-zinc-400 font-bold uppercase tracking-wider mb-1">Incident Location</label>
            <input type="text" required placeholder="e.g. Building C Lobby, Mailroom Floor" value={form.location} onChange={(e) => setForm({ ...form, location: e.target.value })} className="w-full bg-zinc-900 border border-zinc-800 rounded px-2.5 py-2 text-xs outline-none" />
          </div>
          <div>
