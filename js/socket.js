import { $, log, BACKEND_URL } from './config.js';
import { accessToken } from './auth.js';

let socket = null;
let hb = null;

export function getSocket() { return socket; }

export function connectSocket() {
  if (!accessToken) {
    log("소켓 연결: 로그인 필요");
    return null;
  }
  if (socket?.connected) return socket;

  // 기존 소켓 정리
  if (socket) {
    try { socket.disconnect(); } catch {}
    socket = null;
  }

  socket = window.io(BACKEND_URL, {
    transports: ["polling", "websocket"],
    upgrade: true,
    auth: { accessToken },
    reconnection: true,
    reconnectionAttempts: Infinity,
    reconnectionDelay: 500,
    timeout: 20000,
  });

  socket.on("connect", () => {
    const el = $("connState");
    if (el) el.textContent = "CONNECTED";
    log("Socket connected");
    startHeartbeat();
  });

  socket.on("disconnect", () => {
    const el = $("connState");
    if (el) el.textContent = "DISCONNECTED";
    log("Socket disconnected");
    stopHeartbeat();
  });

  socket.on("connect_error", (err) => {
    const el = $("connState");
    if (el) el.textContent = "ERROR";
    log(`Socket error: ${err?.message || err}`);
  });

  return socket;
}

export function disconnectSocket() {
  if (!socket) return;
  try { socket.disconnect(); } catch {}
  socket = null;
  const el = $("connState");
  if (el) el.textContent = "DISCONNECTED";
  stopHeartbeat();
}

function startHeartbeat() {
  stopHeartbeat();
  hb = setInterval(() => {
    if (socket?.connected) {
      const rid = localStorage.getItem("currentRoomId");
      if (rid) socket.emit("room:ping", { roomId: rid });
    }
  }, 3000);
}

function stopHeartbeat() {
  if (hb) clearInterval(hb);
  hb = null;
}
