export const BACKEND_URL = "https://worldcup-backend-leee.onrender.com";
export const SUPABASE_URL = "https://irqhgsusfzvytpgirwdo.supabase.co";
export const SUPABASE_ANON_KEY = "sb_publishable_SgC1lwRsOQV03M8rB9W2fQ_jszyhcyh";

export const $ = (id) => document.getElementById(id);

export function log(msg) {
  const t = new Date().toLocaleTimeString();
  const line = `[${t}] ${msg}`;
  console.log(line);
  const el = document.getElementById("log");
  if (el) el.textContent = line + "\n" + el.textContent;
}

export function setHidden(el, hidden) {
  if (!el) return;
  el.classList.toggle("hidden", !!hidden);
}

export function safe(v, fallback = "-") {
  return (v === undefined || v === null || v === "") ? fallback : String(v);
}
