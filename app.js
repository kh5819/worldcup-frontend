// =========================
// 0) 설정값(여기만 바꾸면 됨)
// =========================
const BACKEND_URL = "https://worldcup-backend-leee.onrender.com";
 // 예: https://myapp.onrender.com
const SUPABASE_URL = "https://irqhgsusfzvytpgirwdo.supabase.co";
const SUPABASE_ANON_KEY = "sb_publishable_SgC1lwRsOQV03M8rB9W2fQ_jszyhcyh";
// =========================
// 1) 유틸/DOM
// =========================
const $ = (id) => document.getElementById(id);
const logEl = $("log");

function log(msg) {
  const t = new Date().toLocaleTimeString();
  logEl.textContent = `[${t}] ${msg}\n` + logEl.textContent;
}

function setHidden(el, hidden) {
  el.classList.toggle("hidden", !!hidden);
}

function safe(v, fallback="-") {
  return (v === undefined || v === null || v === "") ? fallback : String(v);
}

// =========================
// 2) Supabase Auth
// =========================
const supabase = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

let session = null;       // supabase session
let accessToken = null;   // JWT (for backend/socket)

// 저장된 세션 복구
async function restoreSession() {
  const { data } = await supabase.auth.getSession();
  session = data.session;
  accessToken = session?.access_token || null;
  refreshAuthUI();
}

async function signUp(email, password) {
  const { data, error } = await supabase.auth.signUp({ email, password });
  if (error) throw error;
  return data;
}

async function signIn(email, password) {
  const { data, error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) throw error;
  return data;
}

async function signOut() {
  await supabase.auth.signOut();
  session = null;
  accessToken = null;
  localStorage.removeItem("currentRoomId");
  refreshAuthUI();
}

function refreshAuthUI() {
  const isAuthed = !!accessToken;
  $("authState").textContent = isAuthed ? `로그인됨 ✅ (${session.user.email})` : "로그인 필요(멀티/제작)";
  setHidden($("btnLogout"), !isAuthed);
}

// auth events
supabase.auth.onAuthStateChange((_event, newSession) => {
  session = newSession;
  accessToken = session?.access_token || null;
  refreshAuthUI();
  log(`Auth changed: ${accessToken ? "SIGNED_IN" : "SIGNED_OUT"}`);
  // 로그인 상태 바뀌면 소켓은 끊고 다시 연결하는 게 안전
  disconnectSocket();
});

// =========================
// 3) Socket.IO 멀티
// =========================
let socket = null;
let currentRoomId = null;
let isHost = false;
let countdownInterval = null;

// 현재 매치 정보 (서버에서 수신)
let currentMatch = { A: "후보 A", B: "후보 B" };
let currentRoundIndex = 0;
let totalMatches = 0;

function connectSocket() {
  if (!accessToken) {
    log("멀티는 로그인 필요");
    return;
  }
  if (socket?.connected) return;

  socket = window.io(BACKEND_URL, {
    transports: ["websocket"],
    auth: { accessToken }
  });

  socket.on("connect", () => {
    $("connState").textContent = "CONNECTED";
    log("Socket connected");
    startHeartbeat();
  });

  socket.on("disconnect", () => {
    $("connState").textContent = "DISCONNECTED";
    log("Socket disconnected");
    stopHeartbeat();
  });

  socket.on("connect_error", (err) => {
    $("connState").textContent = "ERROR";
    log(`Socket error: ${err?.message || err}`);
  });

  // 방 상태 브로드캐스트
  socket.on("room:state", (payload) => {
    renderRoomState(payload);
  });

  // 게임 시작
  socket.on("game:started", (payload) => {
    currentRoundIndex = payload?.roundIndex || 1;
    totalMatches = payload?.totalMatches || 0;
    currentMatch = payload?.match || currentMatch;
    log(`Game started. round=${currentRoundIndex}/${totalMatches}`);
    showWorldcupUI(true);
    setHidden($("finishedPanel"), true);
    setupWorldcupRound();
    if (payload?.timer?.enabled && payload.timer.sec > 0) {
      startCountdown(payload.timer.sec);
    }
  });

  // 다음 라운드 수신
  socket.on("worldcup:round", (payload) => {
    currentRoundIndex = payload?.roundIndex || currentRoundIndex + 1;
    totalMatches = payload?.totalMatches || totalMatches;
    currentMatch = payload?.match || currentMatch;
    log(`Round ${currentRoundIndex}/${totalMatches}: ${currentMatch.A} vs ${currentMatch.B}`);
    setHidden($("finishedPanel"), true);
    setupWorldcupRound();
    if (payload?.timer?.enabled && payload.timer.sec > 0) {
      startCountdown(payload.timer.sec);
    }
  });

  // 게임 종료
  socket.on("game:finished", (payload) => {
    log(`Game finished! Champion: ${payload?.champion}`);
    showWorldcupUI(true);
    setHidden($("revealPanel"), true);
    setHidden($("btnNextRound"), true);
    setHidden($("finishedPanel"), false);

    const scores = payload?.scores || [];
    let html = `<div class="champion">우승: <b>${payload?.champion || "?"}</b></div>`;
    html += `<table class="scoreTable"><tr><th>순위</th><th>닉네임</th><th>점수</th></tr>`;
    scores.forEach((s, i) => {
      html += `<tr><td>${i + 1}</td><td>${s.name}</td><td>${s.score}</td></tr>`;
    });
    html += `</table>`;
    $("finishedContent").innerHTML = html;
  });

  // --- 재접속 동기화 ---
  socket.on("room:sync", (payload) => {
    log(`room:sync → 방 복구: ${payload.roomId} phase=${payload.phase}`);
    currentRoomId = payload.roomId;
    isHost = payload.isHost;
    localStorage.setItem("currentRoomId", currentRoomId);
    $("currentRoom").textContent = currentRoomId;
    setHidden($("btnLeaveRoom"), false);

    currentRoundIndex = payload.roundIndex || 0;
    totalMatches = payload.totalMatches || 0;
    if (payload.currentMatch) currentMatch = payload.currentMatch;

    const phase = payload.phase;

    if (phase === "lobby") {
      showWorldcupUI(false);
      setHidden($("btnStartGame"), !isHost);
      return;
    }

    // playing / revealed / finished
    showWorldcupUI(true);
    setHidden($("btnStartGame"), true);
    setHidden($("finishedPanel"), true);

    if (phase === "playing") {
      setupWorldcupRound();
      if (payload.committed && payload.myChoice) {
        $("myPick").textContent = payload.myChoice;
        $("roundState").textContent = "선택 완료";
        $("btnChoiceA").disabled = true;
        $("btnChoiceB").disabled = true;
        setHidden($("waitingPanel"), false);
      }
      if (payload.timer?.enabled && payload.timer.remainingSec > 0) {
        startCountdown(payload.timer.remainingSec);
      }
    } else if (phase === "revealed") {
      setupWorldcupRound();
      if (payload.lastReveal) {
        revealWorldcup(payload.lastReveal);
      } else {
        $("roundState").textContent = "결과 공개";
        setHidden($("revealPanel"), false);
        $("revealText").textContent = "재접속 — 결과 공개 상태";
        if (isHost) {
          setHidden($("btnNextRound"), false);
          $("btnNextRound").textContent = "다음 라운드";
        }
      }
    } else if (phase === "finished") {
      setHidden($("revealPanel"), true);
      setHidden($("btnNextRound"), true);
      setHidden($("finishedPanel"), false);
      const scores = payload.scores || [];
      let html = `<div>게임 종료</div>`;
      html += `<table class="scoreTable"><tr><th>순위</th><th>닉네임</th><th>점수</th></tr>`;
      scores.forEach((s, i) => {
        html += `<tr><td>${i + 1}</td><td>${s.name}</td><td>${s.score}</td></tr>`;
      });
      html += `</table>`;
      $("finishedContent").innerHTML = html;
    }
  });

  // 퀴즈 상태/리빌(이번 MVP 화면에는 미포함)
  socket.on("quiz:status", (p) => log(`Quiz status updated: ${JSON.stringify(p)}`));
  socket.on("quiz:reveal", (p) => log(`Quiz reveal: ${JSON.stringify(p)}`));

  // (선택) 월드컵 결과 공개 이벤트를 따로 만들면 여기서 받기
  socket.on("worldcup:reveal", (p) => {
    // 서버가 보내는 reveal payload에 맞춰 표시
    revealWorldcup(p);
  });
}

function disconnectSocket() {
  if (!socket) return;
  try { socket.disconnect(); } catch {}
  socket = null;
  $("connState").textContent = "DISCONNECTED";
  stopHeartbeat();
}

// heartbeat: 재접속 유예/lastSeen 업데이트용
let hb = null;
function startHeartbeat() {
  stopHeartbeat();
  hb = setInterval(() => {
    if (socket?.connected && currentRoomId) {
      socket.emit("room:ping", { roomId: currentRoomId });
    }
  }, 3000);
}
function stopHeartbeat() {
  if (hb) clearInterval(hb);
  hb = null;
}

// =========================
// 4) UI 이벤트
// =========================
$("btnSignUp").addEventListener("click", async () => {
  try {
    $("authMsg").textContent = "";
    const email = $("email").value.trim();
    const pw = $("password").value.trim();
    await signUp(email, pw);
    $("authMsg").textContent = "회원가입 요청 완료. 이메일 확인이 필요할 수 있음.";
  } catch (e) {
    $("authMsg").textContent = `회원가입 실패: ${e.message}`;
  }
});

$("btnSignIn").addEventListener("click", async () => {
  try {
    $("authMsg").textContent = "";
    const email = $("email").value.trim();
    const pw = $("password").value.trim();
    await signIn(email, pw);
    $("authMsg").textContent = "로그인 성공!";
  } catch (e) {
    $("authMsg").textContent = `로그인 실패: ${e.message}`;
  }
});

$("btnLogout").addEventListener("click", async () => {
  await signOut();
});

$("btnCreateRoom").addEventListener("click", () => {
  if (!accessToken) return log("로그인 필요");
  connectSocket();

  const hostName = $("hostName").value.trim() || "host";
  const timerEnabled = $("timerEnabled").checked;
  const timerSec = Number($("timerSec").value || 45);

  const contentId = $("contentId").value.trim();
  if (!contentId) return log("콘텐츠 ID를 입력하세요");

  socket.emit("room:create", {
    hostName,
    mode: "worldcup",
    contentId,
    timerEnabled,
    timerSec,
    maxPlayers: 4
  }, (res) => {
    if (!res?.ok) return log(`방 생성 실패: ${res?.error || "?"}`);
    currentRoomId = res.roomId;
    isHost = true;
    localStorage.setItem("currentRoomId", currentRoomId);
    $("currentRoom").textContent = currentRoomId;
    setHidden($("btnLeaveRoom"), false);
    setHidden($("btnStartGame"), false);
    $("roomId").value = currentRoomId;
    log(`방 생성됨: ${currentRoomId}`);
  });
});

$("btnJoinRoom").addEventListener("click", () => {
  if (!accessToken) return log("로그인 필요");
  connectSocket();

  const roomId = $("roomId").value.trim();
  const name = $("joinName").value.trim() || "player";

  socket.emit("room:join", { roomId, name }, (res) => {
    if (!res?.ok) return log(`입장 실패: ${res?.error || "?"}`);
    currentRoomId = roomId;
    isHost = false;
    localStorage.setItem("currentRoomId", currentRoomId);
    $("currentRoom").textContent = currentRoomId;
    setHidden($("btnLeaveRoom"), false);
    setHidden($("btnStartGame"), true);
    log(`방 입장 성공: ${roomId}`);
  });
});

$("btnLeaveRoom").addEventListener("click", () => {
  if (!socket?.connected || !currentRoomId) return;

  socket.emit("room:leave", { roomId: currentRoomId }, () => {
    log("방 나감");
    localStorage.removeItem("currentRoomId");
    currentRoomId = null;
    isHost = false;
    $("currentRoom").textContent = "-";
    setHidden($("btnLeaveRoom"), true);
    setHidden($("btnStartGame"), true);
    showWorldcupUI(false);
  });
});

$("btnStartGame").addEventListener("click", () => {
  if (!isHost) return log("호스트만 시작 가능");
  if (!socket?.connected || !currentRoomId) return;

  socket.emit("game:start", { roomId: currentRoomId }, (res) => {
    if (!res?.ok) log(`시작 실패: ${res?.error || "?"}`);
  });
});

// =========================
// 5) 방 상태 렌더
// =========================
function renderRoomState(room) {
  // room shape은 백엔드 publicRoomState()에 맞춰야 함
  // 여기서는 가장 단순하게 players 목록만 표시
  const list = $("playerList");
  list.innerHTML = "";

  const players = room?.players || [];
  players.forEach((p) => {
    const li = document.createElement("li");
    li.textContent = `${p.name} (${p.userId.slice(0, 6)}) — ${p.status || "in-room"}`;
    list.appendChild(li);
  });

  // 콘텐츠 제목 표시
  $("contentTitle").textContent = room?.content?.title || "-";

  // 호스트 버튼 처리
  if (room?.hostUserId && session?.user?.id) {
    isHost = (room.hostUserId === session.user.id);
    setHidden($("btnStartGame"), !isHost);
  }

  log(`room:state (${safe(room?.id)}) players=${players.length}`);
}

// =========================
// 6) 월드컵(동시선택) UI 로직 (데모)
// =========================
function showWorldcupUI(show) {
  setHidden($("worldcupSection"), !show);
}

function startCountdown(sec) {
  stopCountdown();
  let remaining = sec;
  setHidden($("timerPill"), false);
  $("timerDisplay").textContent = `${remaining}초`;

  countdownInterval = setInterval(() => {
    remaining--;
    if (remaining <= 0) {
      $("timerDisplay").textContent = "시간 초과!";
      stopCountdown();
    } else {
      $("timerDisplay").textContent = `${remaining}초`;
    }
  }, 1000);
}

function stopCountdown() {
  if (countdownInterval) {
    clearInterval(countdownInterval);
    countdownInterval = null;
  }
}

function renderCandidateImg(imgEl, media) {
  const showable = media && media.url
    && (media.type === "image" || media.type === "gif" || media.type === "url");
  if (!showable) {
    imgEl.src = "";
    setHidden(imgEl, true);
    return;
  }
  imgEl.src = media.url;
  imgEl.onerror = () => { imgEl.src = ""; setHidden(imgEl, true); };
  setHidden(imgEl, false);
}

function setupWorldcupRound() {
  $("worldcupTitle").textContent = `월드컵 멀티(동시선택) — 라운드 ${currentRoundIndex}/${totalMatches}`;
  $("titleA").textContent = currentMatch.A;
  $("titleB").textContent = currentMatch.B;

  // 미디어 렌더링
  renderCandidateImg($("imgA"), currentMatch.mediaA);
  renderCandidateImg($("imgB"), currentMatch.mediaB);

  $("myPick").textContent = "-";
  $("roundState").textContent = "선택 대기";
  setHidden($("waitingPanel"), true);
  setHidden($("revealPanel"), true);
  setHidden($("btnNextRound"), true);
  stopCountdown();
  setHidden($("timerPill"), true);

  // 선택 버튼 활성화
  $("btnChoiceA").disabled = false;
  $("btnChoiceB").disabled = false;
}

function commitPick(choice) {
  if (!socket?.connected || !currentRoomId) return;
  $("myPick").textContent = choice;
  $("roundState").textContent = "선택 완료";
  setHidden($("waitingPanel"), false);

  // ✅ 동시선택(Commit): 서버에 내 선택 제출. (상대에게는 "상태"만 보여주는 게 핵심)
  socket.emit("worldcup:commit", { roomId: currentRoomId, choice }, (res) => {
    if (!res?.ok) {
      log(`commit 실패: ${res?.error || "?"}`);
      return;
    }
    log(`commit 성공: ${choice}`);

    // 버튼 비활성화(재선택 방지)
    $("btnChoiceA").disabled = true;
    $("btnChoiceB").disabled = true;

    // 서버가 전원 commit 확인 후 worldcup:reveal 보내주면 revealWorldcup가 실행됨
  });
}

$("btnChoiceA").addEventListener("click", () => commitPick("A"));
$("btnChoiceB").addEventListener("click", () => commitPick("B"));

// 서버가 reveal을 보내준다고 가정하고 표시
function revealWorldcup(payload) {
  stopCountdown();
  setHidden($("timerPill"), true);
  setHidden($("waitingPanel"), true);
  setHidden($("revealPanel"), false);
  $("roundState").textContent = "결과 공개";

  const picks = payload?.picks || [];
  const percentA = payload?.percent?.A ?? null;
  const percentB = payload?.percent?.B ?? null;
  const roundWinner = payload?.roundWinner;
  const winningCandidate = payload?.winningCandidate;
  const scores = payload?.scores || [];
  const isLastRound = payload?.isLastRound;

  let html = "";
  // 득표율
  if (percentA !== null && percentB !== null) {
    html += `<div><b>${currentMatch.A}</b> ${percentA}% vs <b>${currentMatch.B}</b> ${percentB}%</div>`;
  }
  // 승리 후보
  if (winningCandidate) {
    html += `<div>이번 라운드 승리: <b>${winningCandidate}</b>${roundWinner ? "" : " (동점→랜덤)"}</div>`;
  }
  // 개인별 선택
  const pickLines = picks.map(p => `${p.name || p.userId.slice(0,6)}: ${p.choice === "A" ? currentMatch.A : currentMatch.B}`);
  html += `<div class="muted">${pickLines.join(" | ")}</div>`;
  // 현재 점수
  if (scores.length > 0) {
    html += `<div style="margin-top:4px">점수: ${scores.map(s => `${s.name} ${s.score}점`).join(", ")}</div>`;
  }

  $("revealText").innerHTML = html || "결과 데이터 없음";

  // 호스트에게만 다음 라운드 버튼 표시
  if (isHost) {
    setHidden($("btnNextRound"), false);
    $("btnNextRound").textContent = isLastRound ? "최종 결과 보기" : "다음 라운드";
  } else {
    setHidden($("btnNextRound"), true);
  }
}

// 다음 라운드 버튼 → 서버 요청
$("btnNextRound").addEventListener("click", () => {
  if (!isHost) return log("호스트만 다음 라운드 진행 가능");
  if (!socket?.connected || !currentRoomId) return;

  socket.emit("worldcup:nextRound", { roomId: currentRoomId }, (res) => {
    if (!res?.ok) log(`다음 라운드 실패: ${res?.error || "?"}`);
  });
});

// =========================
// 7) 시작
// =========================
await restoreSession();
log("Ready. 로그인 후 멀티 기능 사용 가능.");

// 재접속 복구: 이전 방이 있으면 자동 소켓 연결 → 서버가 room:sync 전송
const savedRoomId = localStorage.getItem("currentRoomId");
if (savedRoomId && accessToken) {
  currentRoomId = savedRoomId;
  $("currentRoom").textContent = currentRoomId;
  connectSocket();
  log(`이전 방(${savedRoomId}) 재접속 시도…`);
}
