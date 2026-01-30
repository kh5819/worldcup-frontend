import { $, setHidden, log, SUPABASE_URL, SUPABASE_ANON_KEY } from './config.js';

export const supabase = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

export let session = null;
export let accessToken = null;

export async function restoreSession() {
  const { data } = await supabase.auth.getSession();
  session = data.session;
  accessToken = session?.access_token || null;
  refreshAuthUI();
}

export async function signIn(email, password) {
  const { data, error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) throw error;
  return data;
}

export async function signUp(email, password) {
  const { data, error } = await supabase.auth.signUp({ email, password });
  if (error) throw error;
  return data;
}

export async function signOut() {
  await supabase.auth.signOut();
  session = null;
  accessToken = null;
  localStorage.removeItem("currentRoomId");
  refreshAuthUI();
}

export function refreshAuthUI() {
  const el = $("authState");
  if (!el) return;
  const isAuthed = !!accessToken;
  el.textContent = isAuthed ? `로그인됨 (${session?.user?.email || ""})` : "로그인 필요";
  const btn = $("btnLogout");
  if (btn) setHidden(btn, !isAuthed);
}

// Auth state change — 페이지별 콜백 등록 가능
let _authChangeCb = null;
export function onAuthChange(cb) { _authChangeCb = cb; }

supabase.auth.onAuthStateChange((_event, newSession) => {
  session = newSession;
  accessToken = session?.access_token || null;
  refreshAuthUI();
  log(`Auth: ${accessToken ? "SIGNED_IN" : "SIGNED_OUT"}`);
  if (_authChangeCb) _authChangeCb(accessToken);
});
