import { $, log, setHidden, safe, SUPABASE_URL, SUPABASE_ANON_KEY } from "./config.js";
import { restoreSession, signOut, onAuthChange, accessToken, session } from "./auth.js";
import { connectSocket, disconnectSocket } from "./socket.js";
import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js/+esm";

console.log("✅ room.js loaded", new Date().toISOString());

// ===== State =====
let isHost = false;
let currentRoomId = null;
let roomMode = "worldcup";
let socket = null;

// --- 월드컵 ---
let currentMatch = { A: "후보 A", B: "후보 B" };
let currentRoundIndex = 0;
let totalMatches = 0;
let countdownInterval = null;

// --- 퀴즈 ---
let currentQuizQuestion = null;
let quizSubmitted = false;
let quizCountdownInterval = null;
let pendingYouTube = null;
let ytPlayer = null;
let ytApiLoaded = false;
let ytApiLoadPromise = null;
let playbackTimer = null;

// =============================
// 공통 UI
// =============================
function showPhase(phase) {
  const isLobby = phase === "lobby";
  setHidden($("lobbyPanel"), !isLobby);
  setHidden($("worldcupSection"), roomMode === "quiz" || isLobby);
  setHidden($("quizSection"), roomMode !== "quiz" || isLobby);
}

function renderRoomState(room) {
  const players = room?.players || [];
  const myUserId = session?.user?.id;
  const hostId = room?.hostUserId;

  if (room?.mode) roomMode = room.mode;

  const list = $("playerList");
  if (list) {
    list.innerHTML = "";
    players.forEach((p) => {
      const li = document.createElement("li");
      const isMe = p.userId === myUserId;
      const isPlayerHost = p.userId === hostId;
      const statusIcon =
        p.status === "선택 완료" || p.status === "제출 완료" || p.status === "준비 완료"
          ? "✅"
          : p.status === "재접속 대기…"
          ? "🔄"
          : "⏳";
      let text = `${p.name} ${statusIcon}`;
      if (isPlayerHost) text += " (HOST)";
      if (isMe) li.innerHTML = `<b style="color:var(--primary)">${text}</b>`;
      else li.textContent = text;
      list.appendChild(li);
    });
  }

  const wcStatus = $("wcPlayerStatus");
  if (wcStatus) {
    wcStatus.innerHTML = "";
    players.forEach((p) => {
      const badge = document.createElement("span");
      const isMe = p.userId === myUserId;
      const isPlayerHost = p.userId === hostId;
      const icon = p.status === "선택 완료" ? "✅" : p.status === "재접속 대기…" ? "🔄" : "⏳";
      badge.className = "wc-badge" + (isMe ? " me" : "");
      badge.innerHTML = `${p.name} ${icon}` + (isPlayerHost ? '<span class="host-tag">HOST</span>' : "");
      wcStatus.appendChild(badge);
    });
  }

  const qStatus = $("quizPlayerStatus");
  if (qStatus) {
    qStatus.innerHTML = "";
    players.forEach((p) => {
      const badge = document.createElement("span");
      const isMe = p.userId === myUserId;
      const isPlayerHost = p.userId === hostId;
      let icon = "⏳";
      if (p.status === "제출 완료" || p.status === "선택 완료" || p.status === "준비 완료") icon = "✅";
      else if (p.status === "재접속 대기…") icon = "🔄";
      badge.className = "wc-badge" + (isMe ? " me" : "");
      badge.innerHTML =
        `${p.name} ${icon} <span class="muted" style="font-size:11px">${p.status}</span>` +
        (isPlayerHost ? '<span class="host-tag">HOST</span>' : "");
      qStatus.appendChild(badge);
    });
  }

  const ct = $("contentTitle");
  if (ct) ct.textContent = room?.content?.title || "-";

  if (hostId && myUserId) {
    isHost = hostId === myUserId;
    setHidden($("btnStartGame"), !isHost);
  }

  log(`room:state (${safe(room?.id)}) players=${players.length} mode=${room?.mode || "?"}`);
}
// =============================
// 월드컵 UI
// =============================
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
  const showable =
    media &&
    media.url &&
    (media.type === "image" || media.type === "gif" || media.type === "url");
  if (!showable) {
    imgEl.src = "";
    setHidden(imgEl, true);
    return;
  }
  imgEl.src = media.url;
  imgEl.onerror = () => {
    imgEl.src = "";
    setHidden(imgEl, true);
  };
  setHidden(imgEl, false);
}

function setupWorldcupRound() {
  $("worldcupTitle").textContent = `월드컵 — 라운드 ${currentRoundIndex}/${totalMatches}`;
  $("titleA").textContent = currentMatch.A;
  $("titleB").textContent = currentMatch.B;
  renderCandidateImg($("imgA"), currentMatch.mediaA);
  renderCandidateImg($("imgB"), currentMatch.mediaB);
  $("myPick").textContent = "-";
  $("roundState").textContent = "선택 대기";
  setHidden($("waitingPanel"), true);
  setHidden($("revealPanel"), true);
  setHidden($("btnNextRound"), true);
  setHidden($("guestWaitMsg"), true);
  $("btnNextRound").disabled = true;
  stopCountdown();
  setHidden($("timerPill"), true);
  $("btnChoiceA").disabled = false;
  $("btnChoiceB").disabled = false;
}

function commitPick(choice) {
  if (!socket?.connected || !currentRoomId) return;
  $("myPick").textContent = choice;
  $("roundState").textContent = "선택 완료";
  setHidden($("waitingPanel"), false);

  socket.emit("worldcup:commit", { roomId: currentRoomId, choice }, (res) => {
    if (!res?.ok) {
      log(`commit 실패: ${res?.error || "?"}`);
      return;
    }
    log(`commit 성공: ${choice}`);
    $("btnChoiceA").disabled = true;
    $("btnChoiceB").disabled = true;
  });
}

function revealWorldcup(payload) {
  stopCountdown();
  setHidden($("timerPill"), true);
  setHidden($("waitingPanel"), true);
  setHidden($("revealPanel"), false);
  $("roundState").textContent = "결과 공개";

  const picks = payload?.picks || [];
  const percentA = payload?.percent?.A ?? 0;
  const percentB = payload?.percent?.B ?? 0;
  const winningCandidate = payload?.winningCandidate;
  const isTie = payload?.isTie;
  const scores = payload?.scores || [];
  const isLastRound = payload?.isLastRound;

  let html = "";
  html += `<div class="reveal-bar-wrap">
    <span class="reveal-bar-label"><b>${currentMatch.A}</b></span>
    <div class="reveal-bar"><div class="reveal-bar-fill a" style="width:${percentA}%"></div></div>
    <span class="reveal-bar-label">${percentA}%</span>
  </div>`;
  html += `<div class="reveal-bar-wrap">
    <span class="reveal-bar-label"><b>${currentMatch.B}</b></span>
    <div class="reveal-bar"><div class="reveal-bar-fill b" style="width:${percentB}%"></div></div>
    <span class="reveal-bar-label">${percentB}%</span>
  </div>`;

  if (isTie) html += `<div class="reveal-tie">동점 → 랜덤 진출</div>`;
  if (winningCandidate) html += `<div class="reveal-winner">진출: <b>${winningCandidate}</b></div>`;

  const pickLines = picks.map((p) => {
    if (p.choice === null) return `${p.name || p.userId.slice(0, 6)}: 패스`;
    return `${p.name || p.userId.slice(0, 6)}: ${p.choice === "A" ? currentMatch.A : currentMatch.B}`;
  });
  html += `<div class="muted" style="margin-top:6px">${pickLines.join(" | ")}</div>`;

  if (scores.length > 0) {
    html += `<table class="scoreTable"><tr><th>순위</th><th>닉네임</th><th>점수</th></tr>`;
    let rank = 1;
    scores.forEach((s, i) => {
      if (i > 0 && s.score < scores[i - 1].score) rank = i + 1;
      html += `<tr><td>${rank}</td><td>${s.name}</td><td>${s.score}</td></tr>`;
    });
    html += `</table>`;
  }

  $("revealText").innerHTML = html || "결과 데이터 없음";

  setHidden($("btnNextRound"), false);
  if (isHost) {
    $("btnNextRound").disabled = false;
    $("btnNextRound").textContent = isLastRound ? "최종 결과 보기" : "다음 라운드";
    setHidden($("guestWaitMsg"), true);
  } else {
    $("btnNextRound").disabled = true;
    $("btnNextRound").textContent = isLastRound ? "최종 결과 대기…" : "다음 라운드 대기…";
    setHidden($("guestWaitMsg"), false);
  }
}

function renderFinished(champion, scores) {
  let html = champion
    ? `<div class="champion">우승: <b>${champion}</b></div>`
    : `<div>게임 종료</div>`;
  html += `<table class="scoreTable"><tr><th>순위</th><th>닉네임</th><th>점수</th></tr>`;
  let rank = 1;
  scores.forEach((s, i) => {
    if (i > 0 && s.score < scores[i - 1].score) rank = i + 1;
    html += `<tr><td>${rank}</td><td>${s.name}</td><td>${s.score}</td></tr>`;
  });
  html += `</table>`;
  $("finishedContent").innerHTML = html;
}
// =============================
// 퀴즈 UI (멀티 공용)
// =============================
function startQuizCountdown(sec) {
  stopQuizCountdown();
  let remaining = sec;
  setHidden($("quizTimerPill"), false);
  $("quizTimerDisplay").textContent = `${remaining}초`;
  quizCountdownInterval = setInterval(() => {
    remaining--;
    if (remaining <= 0) {
      $("quizTimerDisplay").textContent = "시간 초과!";
      stopQuizCountdown();
    } else {
      $("quizTimerDisplay").textContent = `${remaining}초`;
    }
  }, 1000);
}

function stopQuizCountdown() {
  if (quizCountdownInterval) {
    clearInterval(quizCountdownInterval);
    quizCountdownInterval = null;
  }
}

function stopPlayback() {
  if (playbackTimer) {
    clearInterval(playbackTimer);
    playbackTimer = null;
  }
  if (ytPlayer) {
    try {
      ytPlayer.pauseVideo();
    } catch {}
  }
  pendingYouTube = null;
}

function resetQuizPanels() {
  setHidden($("quizQuestionPanel"), true);
  setHidden($("quizRevealPanel"), true);
  setHidden($("quizScoreboardPanel"), true);
  setHidden($("quizFinishedPanel"), true);
  setHidden($("btnQuizNext"), true);
  setHidden($("quizGuestWait"), true);
  setHidden($("quizSubmittedPanel"), true);
  setHidden($("quizTimerPill"), true);
  setHidden($("quizChoicesPanel"), true);
  setHidden($("quizShortPanel"), true);
  setHidden($("quizYoutubePanel"), true);

  stopQuizCountdown();
  stopPlayback();

  // UI 잔상 정리
  if ($("btnQuizPlay")) $("btnQuizPlay").textContent = "재생";
  if ($("quizShortInput")) $("quizShortInput").value = "";
  if ($("quizAudioInput")) $("quizAudioInput").value = "";
  if ($("quizPlaybackInfo")) $("quizPlaybackInfo").textContent = "";
  if ($("quizCountdown")) $("quizCountdown").textContent = "";
  if ($("quizMyAnswer")) $("quizMyAnswer").textContent = "-";
}

function renderQuizQuestion(payload) {
  resetQuizPanels();
  currentQuizQuestion = payload;
  quizSubmitted = false;

  $("quizProgress").textContent = `${payload.index + 1}/${payload.total}`;
  $("quizPhase").textContent = "문제 공개";
  $("quizPrompt").textContent = payload.prompt;
  setHidden($("quizQuestionPanel"), false);

  if (payload.type === "mcq") {
    renderMCQChoices(payload.choices, false);
    setHidden($("quizChoicesPanel"), false);
  } else if (payload.type === "short") {
    setHidden($("quizShortPanel"), false);
    $("quizShortInput").value = "";
    $("quizShortInput").disabled = true;
    $("btnQuizSubmitShort").disabled = true;
  } else if (payload.type === "audio_youtube") {
    setHidden($("quizYoutubePanel"), false);
    setHidden($("quizReadyWrap"), false);
    setHidden($("quizPlayWrap"), true);
    setHidden($("quizAudioAnswerPanel"), true);
    $("btnQuizReady").disabled = false;
    $("quizReadyCount").textContent = "";
  }
}

function renderMCQChoices(choices, enabled) {
  const container = $("quizChoices");
  container.innerHTML = "";
  (choices || []).forEach((label, i) => {
    const btn = document.createElement("button");
    btn.className = "quiz-choice";
    btn.textContent = label;
    btn.disabled = !enabled;
    if (enabled) btn.setAttribute("data-enabled", "1");
    btn.addEventListener("click", () => {
      if (quizSubmitted || !btn.getAttribute("data-enabled")) return;
      submitQuizAnswer(i);
      container.querySelectorAll(".quiz-choice").forEach((b) => {
        b.removeAttribute("data-enabled");
        b.disabled = true;
      });
      btn.classList.add("selected");
    });
    container.appendChild(btn);
  });
}

function enableMCQChoices() {
  const btns = $("quizChoices")?.querySelectorAll(".quiz-choice");
  if (!btns) return;
  btns.forEach((btn) => {
    btn.disabled = false;
    btn.setAttribute("data-enabled", "1");
  });
}

function handleQuizAnswering(payload) {
  $("quizPhase").textContent = "답변 중";
  if (payload.timer?.enabled) startQuizCountdown(payload.timer.sec);
  if (!currentQuizQuestion) return;

  if (currentQuizQuestion.type === "mcq") {
    enableMCQChoices();
  } else if (currentQuizQuestion.type === "short") {
    $("quizShortInput").disabled = false;
    $("btnQuizSubmitShort").disabled = false;
    $("quizShortInput").focus();
  } else if (currentQuizQuestion.type === "audio_youtube" && payload.youtube) {
    setHidden($("quizReadyWrap"), true);
    setHidden($("quizPlayWrap"), false);
    setHidden($("quizAudioAnswerPanel"), false);
    $("quizAudioInput").value = "";
    $("quizAudioInput").disabled = false;
    $("btnQuizSubmitAudio").disabled = false;
    handleYouTubeAnswering(payload.youtube);
  }
}

function submitQuizAnswer(answer) {
  if (quizSubmitted || !socket?.connected || !currentRoomId) return;
  quizSubmitted = true;

  socket.emit("quiz:submit", { roomId: currentRoomId, answer }, (res) => {
    if (!res?.ok) {
      log(`답변 제출 실패: ${res?.error || "?"}`);
      quizSubmitted = false;
      return;
    }
    log(`답변 제출 성공`);
  });

  let displayAnswer = answer;
  if (currentQuizQuestion?.type === "mcq" && currentQuizQuestion.choices) {
    displayAnswer = currentQuizQuestion.choices[answer] || answer;
  }
  $("quizMyAnswer").textContent = displayAnswer ?? "-";
  setHidden($("quizSubmittedPanel"), false);

  if (currentQuizQuestion?.type === "short") {
    $("quizShortInput").disabled = true;
    $("btnQuizSubmitShort").disabled = true;
  } else if (currentQuizQuestion?.type === "audio_youtube") {
    $("quizAudioInput").disabled = true;
    $("btnQuizSubmitAudio").disabled = true;
  }
}
function renderQuizReveal(payload) {
  resetQuizPanels();
  $("quizPhase").textContent = "정답 공개";
  $("quizProgress").textContent = `${payload.questionIndex + 1}/${payload.totalQuestions}`;
  setHidden($("quizRevealPanel"), false);

  const myUserId = session?.user?.id;
  const myResult = payload.results?.find((r) => r.userId === myUserId);

  let html = "";
  html += `<div style="font-size:16px;margin:8px 0">정답: <b>${payload.correctAnswer}</b></div>`;

  if (myResult) {
    if (myResult.isCorrect) {
      html += `<div class="quiz-correct-banner">정답! +1점</div>`;
    } else {
      const myAns =
        myResult.answer !== null && myResult.answer !== undefined
          ? payload.type === "mcq" && payload.choiceStats
            ? payload.choiceStats[myResult.answer]?.label || myResult.answer
            : myResult.answer
          : "미제출";
      html += `<div class="quiz-wrong-banner">오답 (내 답: ${myAns})</div>`;
    }
  }

  if (payload.choiceStats) {
    html += `<div style="margin-top:10px">`;
    payload.choiceStats.forEach((cs) => {
      const isCorrect = Number(payload.correctAnswerRaw?.[0]) === cs.index;
      html += `<div class="reveal-bar-wrap">
        <span class="reveal-bar-label">${isCorrect ? "✅ " : ""}${cs.label}</span>
        <div class="reveal-bar"><div class="reveal-bar-fill ${isCorrect ? "a" : "b"}" style="width:${cs.percent}%"></div></div>
        <span class="reveal-bar-label">${cs.percent}% (${cs.count}명)</span>
      </div>`;
    });
    html += `</div>`;
  }

  const lines = (payload.results || []).map((r) => {
    const icon = r.isCorrect ? "✅" : "❌";
    const ans =
      r.answer !== null && r.answer !== undefined
        ? payload.type === "mcq" && payload.choiceStats
          ? payload.choiceStats[r.answer]?.label || r.answer
          : r.answer
        : "미제출";
    return `${r.name} ${icon} ${ans}`;
  });
  html += `<div class="muted" style="margin-top:8px">${lines.join(" | ")}</div>`;

  $("quizRevealContent").innerHTML = html;
  updateQuizNextButton("reveal", payload.isLastQuestion);
}

function renderQuizScoreboard(payload) {
  $("quizPhase").textContent = "점수판";
  setHidden($("quizRevealPanel"), true);
  setHidden($("quizScoreboardPanel"), false);

  const scores = payload.scores || [];
  let html = `<table class="scoreTable"><tr><th>순위</th><th>닉네임</th><th>점수</th></tr>`;
  let rank = 1;
  scores.forEach((s, i) => {
    if (i > 0 && s.score < scores[i - 1].score) rank = i + 1;
    html += `<tr><td>${rank}</td><td>${s.name}</td><td>${s.score}</td></tr>`;
  });
  html += `</table>`;
  $("quizScoreboardContent").innerHTML = html;

  updateQuizNextButton("scoreboard", payload.isLastQuestion);
}

function renderQuizFinished(payload) {
  resetQuizPanels();
  $("quizPhase").textContent = "퀴즈 종료";
  setHidden($("quizFinishedPanel"), false);

  const scores = payload.scores || [];
  let html = `<table class="scoreTable"><tr><th>순위</th><th>닉네임</th><th>점수</th></tr>`;
  let rank = 1;
  scores.forEach((s, i) => {
    if (i > 0 && s.score < scores[i - 1].score) rank = i + 1;
    html += `<tr><td>${rank}</td><td>${s.name}</td><td>${s.score}</td></tr>`;
  });
  html += `</table>`;
  html += `<div class="muted" style="margin-top:6px">총 ${payload.totalQuestions}문제</div>`;
  $("quizFinishedContent").innerHTML = html;
}

function updateQuizNextButton(phase, isLastQuestion) {
  setHidden($("btnQuizNext"), false);
  if (isHost) {
    $("btnQuizNext").disabled = false;
    if (phase === "reveal") {
      $("btnQuizNext").textContent = "점수판 보기";
    } else if (phase === "scoreboard") {
      $("btnQuizNext").textContent = isLastQuestion ? "최종 결과 보기" : "다음 문제";
    }
    setHidden($("quizGuestWait"), true);
  } else {
    $("btnQuizNext").disabled = true;
    $("btnQuizNext").textContent = "호스트 대기…";
    setHidden($("quizGuestWait"), false);
  }
}

// ===== YouTube IFrame API =====
function loadYouTubeAPI() {
  if (ytApiLoaded || (window.YT && window.YT.Player)) {
    ytApiLoaded = true;
    return Promise.resolve();
  }
  if (ytApiLoadPromise) return ytApiLoadPromise;

  ytApiLoadPromise = new Promise((resolve) => {
    window.onYouTubeIframeAPIReady = () => {
      ytApiLoaded = true;
      resolve();
    };
    const tag = document.createElement("script");
    tag.src = "https://www.youtube.com/iframe_api";
    document.head.appendChild(tag);
  });
  return ytApiLoadPromise;
}

function createYTPlayer(videoId) {
  return new Promise((resolve) => {
    if (ytPlayer) {
      try {
        ytPlayer.destroy();
      } catch {}
      ytPlayer = null;
    }
    const wrap = $("ytPlayerWrap");
    if (wrap) wrap.innerHTML = '<div id="ytPlayerContainer"></div>';

    ytPlayer = new YT.Player("ytPlayerContainer", {
      height: "1",
      width: "1",
      videoId,
      playerVars: { autoplay: 0, controls: 0, modestbranding: 1 },
      events: { onReady: () => resolve(ytPlayer) },
    });
  });
}

async function handleYouTubeAnswering(youtube) {
  pendingYouTube = youtube;
  const { startAt } = youtube;

  await loadYouTubeAPI();
  await createYTPlayer(youtube.videoId);

  const countdownEl = $("quizCountdown");
  const updateCountdown = () => {
    const left = Math.max(0, Math.ceil((startAt - Date.now()) / 1000));
    countdownEl.textContent = left > 0 ? `${left}` : "시작!";
  };

  updateCountdown();
  const cdInterval = setInterval(() => {
    const left = Math.ceil((startAt - Date.now()) / 1000);
    if (left <= 0) {
      clearInterval(cdInterval);
      countdownEl.textContent = "시작!";
      setTimeout(() => {
        countdownEl.textContent = "";
      }, 1000);
    } else {
      countdownEl.textContent = `${left}`;
    }
  }, 300);

  setHidden($("btnQuizPlay"), false);
  $("btnQuizPlay").disabled = false;
  $("btnQuizPlay").textContent = "재생";
}
// =============================
// 솔로 모드
// =============================
function normalizeAnswerArray(answer) {
  if (Array.isArray(answer)) return answer;
  if (answer === null || answer === undefined) return [];
  return [answer];
}

function extractSoloVideoId(input) {
  if (!input) return null;
  const s = String(input).trim();
  if (/^[A-Za-z0-9_-]{11}$/.test(s)) return s;

  try {
    const url = new URL(s);
    const host = url.hostname.replace("www.", "");
    if (host === "youtu.be") return url.pathname.split("/")[1] || null;

    const v = url.searchParams.get("v");
    if (v) return v;

    const parts = url.pathname.split("/").filter(Boolean);
    const shortsIdx = parts.indexOf("shorts");
    if (shortsIdx >= 0 && parts[shortsIdx + 1]) return parts[shortsIdx + 1];

    const embedIdx = parts.indexOf("embed");
    if (embedIdx >= 0 && parts[embedIdx + 1]) return parts[embedIdx + 1];

    return null;
  } catch {
    return s;
  }
}

function soloCheckAnswer(q, userAnswer) {
  if (userAnswer === null || userAnswer === undefined) return false;
  const ansArr = normalizeAnswerArray(q.answer);

  if (q.type === "mcq") {
    const correctIdx = ansArr.length > 0 ? Number(ansArr[0]) : NaN;
    return Number(userAnswer) === correctIdx;
  }

  const norm = String(userAnswer).trim().toLowerCase().replace(/\s+/g, "");
  return ansArr.some((ans) => String(ans).trim().toLowerCase().replace(/\s+/g, "") === norm);
}

function renderSoloMCQ(choices) {
  const container = $("quizChoices");
  container.innerHTML = "";
  (choices || []).forEach((label, i) => {
    const btn = document.createElement("button");
    btn.className = "quiz-choice";
    btn.textContent = label;
    btn.disabled = true;
    btn.dataset.idx = i;
    container.appendChild(btn);
  });
}

function soloWaitAnswer(type, timerSec) {
  const sec = Number(timerSec);
  const safeSec = Number.isFinite(sec) && sec > 0 ? sec : 30;

  return new Promise((resolve) => {
    let done = false;
    const cleanups = [];

    const finish = (answer) => {
      if (done) return;
      done = true;
      clearTimeout(tid);
      cleanups.forEach((fn) => {
        try {
          fn();
        } catch {}
      });
      resolve(answer);
    };

    const tid = setTimeout(() => finish(null), safeSec * 1000);

    if (type === "mcq") {
      const handler = (e) => {
        const btn = e.target.closest(".quiz-choice");
        if (!btn || btn.disabled || !btn.getAttribute("data-enabled")) return;

        $("quizChoices")?.querySelectorAll(".quiz-choice").forEach((b) => {
          b.removeAttribute("data-enabled");
          b.disabled = true;
        });

        btn.classList.add("selected");
        finish(Number(btn.dataset.idx));
      };

      $("quizChoices")?.addEventListener("click", handler);
      cleanups.push(() => $("quizChoices")?.removeEventListener("click", handler));

    } else if (type === "short") {
      const onSubmit = () => {
        const val = $("quizShortInput")?.value?.trim();
        if (val) finish(val);
      };
      const onKey = (e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          onSubmit();
        }
      };

      $("btnQuizSubmitShort")?.addEventListener("click", onSubmit);
      $("quizShortInput")?.addEventListener("keydown", onKey);

      cleanups.push(() => {
        $("btnQuizSubmitShort")?.removeEventListener("click", onSubmit);
        $("quizShortInput")?.removeEventListener("keydown", onKey);
      });

    } else if (type === "audio_youtube") {
      const onSubmit = () => {
        const val = $("quizAudioInput")?.value?.trim();
        if (val) finish(val);
      };
      const onKey = (e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          onSubmit();
        }
      };

      $("btnQuizSubmitAudio")?.addEventListener("click", onSubmit);
      $("quizAudioInput")?.addEventListener("keydown", onKey);

      cleanups.push(() => {
        $("btnQuizSubmitAudio")?.removeEventListener("click", onSubmit);
        $("quizAudioInput")?.removeEventListener("keydown", onKey);
      });
    }
  });
}

async function setupSoloYouTube(q) {
  const videoId = extractSoloVideoId(q.media_url);
  if (!videoId) return;

  try {
    await loadYouTubeAPI();
    await createYTPlayer(videoId);
  } catch (err) {
    log(`유튜브 로드 실패: ${err?.message || err}`);
    return;
  }

  const btnPlay = $("btnQuizPlay");
  if (!btnPlay) return;

  btnPlay.onclick = null;
  btnPlay.disabled = false;
  btnPlay.textContent = "재생";
  setHidden($("quizPlaybackInfo"), true);

  btnPlay.onclick = () => {
    btnPlay.disabled = true;
    btnPlay.textContent = "재생 중…";

    try {
      ytPlayer?.seekTo(Number(q.start_sec) || 0, true);
      ytPlayer?.playVideo();
    } catch {}

    const dur = Number(q.duration_sec) > 0 ? Number(q.duration_sec) : 10;

    setHidden($("quizPlaybackInfo"), false);
    let left = dur;
    $("quizPlaybackInfo").textContent = `재생 중… ${left}초 남음`;

    if (playbackTimer) {
      clearInterval(playbackTimer);
      playbackTimer = null;
    }

    playbackTimer = setInterval(() => {
      left--;
      if (left <= 0) {
        clearInterval(playbackTimer);
        playbackTimer = null;
        try {
          ytPlayer?.pauseVideo();
        } catch {}
        $("quizPlaybackInfo").textContent = "재생 종료";
        btnPlay.textContent = "재생 완료";
      } else {
        $("quizPlaybackInfo").textContent = `재생 중… ${left}초 남음`;
      }
    }, 1000);
  };
}

async function soloQuiz(questions, title) {
  roomMode = "quiz";
  showPhase("playing");
  $("quizTitle").textContent = `솔로 — ${title || "퀴즈"}`;
  setHidden($("quizPlayerStatus"), true);

  let score = 0;
  const totalQ = questions.length;
  const SOLO_TIMER_SEC = 30;

  for (let idx = 0; idx < totalQ; idx++) {
    const q = questions[idx];
    const qtype = q.type;

    // SHOW
    resetQuizPanels();
    $("quizProgress").textContent = `${idx + 1}/${totalQ}`;
    $("quizPhase").textContent = "문제 공개";
    $("quizPrompt").textContent = q.prompt;
    setHidden($("quizQuestionPanel"), false);

    if (qtype === "mcq") {
      renderSoloMCQ(q.choices);
      setHidden($("quizChoicesPanel"), false);
    } else if (qtype === "short") {
      setHidden($("quizShortPanel"), false);
      $("quizShortInput").disabled = true;
      $("btnQuizSubmitShort").disabled = true;
    } else if (qtype === "audio_youtube") {
      setHidden($("quizYoutubePanel"), false);
      setHidden($("quizReadyWrap"), true);
      setHidden($("quizPlayWrap"), false);
      setHidden($("quizAudioAnswerPanel"), false);
      $("quizAudioInput").disabled = true;
      $("btnQuizSubmitAudio").disabled = true;
      setHidden($("btnQuizPlay"), false);
      $("btnQuizPlay").disabled = true;
      $("btnQuizPlay").textContent = "재생";
      setHidden($("quizPlaybackInfo"), true);
    }

    await new Promise((r) => setTimeout(r, 1500));

    // ANSWERING
    $("quizPhase").textContent = "답변 중";

    let timerSec = SOLO_TIMER_SEC;
    if (qtype === "audio_youtube") {
      const extra = Number(q.duration_sec) > 0 ? Number(q.duration_sec) : 10;
      timerSec = SOLO_TIMER_SEC + extra;
    }
    startQuizCountdown(timerSec);

    if (qtype === "mcq") {
      $("quizChoices")?.querySelectorAll(".quiz-choice").forEach((b) => {
        b.disabled = false;
        b.setAttribute("data-enabled", "1");
      });
    } else if (qtype === "short") {
      $("quizShortInput").disabled = false;
      $("btnQuizSubmitShort").disabled = false;
      $("quizShortInput").focus();
    } else if (qtype === "audio_youtube") {
      $("btnQuizPlay").disabled = false;
      $("quizAudioInput").disabled = false;
      $("btnQuizSubmitAudio").disabled = false;
      await setupSoloYouTube(q);
    }

    // Wait for answer or timeout
    const userAnswer = await soloWaitAnswer(qtype, timerSec);
    stopQuizCountdown();

    // Disable all inputs
    if (qtype === "mcq") {
      $("quizChoices")?.querySelectorAll(".quiz-choice").forEach((b) => {
        b.disabled = true;
        b.removeAttribute("data-enabled");
      });
    } else if (qtype === "short") {
      $("quizShortInput").disabled = true;
      $("btnQuizSubmitShort").disabled = true;
    } else if (qtype === "audio_youtube") {
      stopPlayback();
      $("quizAudioInput").disabled = true;
      $("btnQuizSubmitAudio").disabled = true;
      $("btnQuizPlay").disabled = true;
    }

    // Show submitted
    if (userAnswer !== null && userAnswer !== undefined) {
      const displayAns = qtype === "mcq" ? (q.choices?.[userAnswer] ?? userAnswer) : userAnswer;
      $("quizMyAnswer").textContent = displayAns;
      setHidden($("quizSubmittedPanel"), false);
    } else {
      $("quizMyAnswer").textContent = "-";
      setHidden($("quizSubmittedPanel"), true);
    }

    await new Promise((r) => setTimeout(r, 800));

    // === REVEAL PHASE ===
    const isCorrect = soloCheckAnswer(q, userAnswer);
    if (isCorrect) score++;

    resetQuizPanels();
    $("quizPhase").textContent = "정답 공개";
    $("quizProgress").textContent = `${idx + 1}/${totalQ}`;
    setHidden($("quizRevealPanel"), false);

    // ✅ 정답 표시(배열/문자 혼용 방어)
    const ansArr = normalizeAnswerArray(q.answer);
    const correctDisplay =
      qtype === "mcq"
        ? (q.choices?.[Number(ansArr?.[0])] ?? ansArr?.[0] ?? "-")
        : (ansArr?.[0] ?? "-");

    let revealHtml = `<div style="font-size:16px;margin:8px 0">정답: <b>${correctDisplay}</b></div>`;

    if (isCorrect) {
      revealHtml += `<div class="quiz-correct-banner">정답! (${score}/${idx + 1})</div>`;
    } else {
      let myAns;
      if (userAnswer === null || userAnswer === undefined) {
        myAns = "미제출";
      } else if (qtype === "mcq") {
        myAns = q.choices?.[userAnswer] ?? userAnswer;
      } else {
        myAns = userAnswer;
      }
      revealHtml += `<div class="quiz-wrong-banner">오답 (내 답: ${myAns})</div>`;
    }

    $("quizRevealContent").innerHTML = revealHtml;

    // Next button
    setHidden($("btnQuizNext"), false);
    $("btnQuizNext").disabled = false;
    $("btnQuizNext").textContent = idx < totalQ - 1 ? "다음 문제" : "최종 결과";
    setHidden($("quizGuestWait"), true);

    await new Promise((resolve) => {
      const handler = () => {
        $("btnQuizNext").removeEventListener("click", handler);
        resolve();
      };
      $("btnQuizNext").addEventListener("click", handler);
    });
  }

  // === FINISHED ===
  resetQuizPanels();
  $("quizPhase").textContent = "퀴즈 종료";
  setHidden($("quizFinishedPanel"), false);

  const pct = totalQ > 0 ? Math.round((score / totalQ) * 100) : 0;
  $("quizFinishedContent").innerHTML = `
    <div style="font-size:20px;margin:12px 0">최종 점수: <b>${score}</b> / ${totalQ}</div>
    <div class="muted">정답률: ${pct}%</div>
    <div style="margin-top:16px">
      <a href="./index.html" class="btn primary">홈으로</a>
    </div>
  `;

  log(`솔로 퀴즈 종료: ${score}/${totalQ} (${pct}%)`);
}
// =============================
// 솔로 월드컵
// =============================
function soloWorldcupRoundsFromContent(content) {
  // content.candidates: [{title, media_url, media_type}] 형태도 있고 그냥 문자열 배열일 수도 있어서 방어
  const raw = content?.candidates || [];
  const list = raw
    .map((c) => {
      if (typeof c === "string") return { title: c, media: null };
      const title = c?.title ?? c?.name ?? "-";
      const media =
        c?.media_url
          ? { url: c.media_url, type: c.media_type || "image" }
          : c?.media?.url
          ? c.media
          : null;
      return { title, media };
    })
    .filter((x) => x && x.title);

  // 최소 2개 보장
  if (list.length < 2) {
    return [
      { title: "후보 A", media: null },
      { title: "후보 B", media: null },
    ];
  }
  return list;
}

function soloPickWinner(choice, match) {
  // choice: "A" | "B"
  return choice === "A" ? match.A : match.B;
}

async function soloWorldcup(content) {
  roomMode = "worldcup";
  showPhase("playing");

  const title = content?.title || "이상형월드컵";
  $("contentTitle").textContent = title;

  setHidden($("quizSection"), true);
  setHidden($("worldcupSection"), false);
  setHidden($("wcPlayerStatus"), true);
  setHidden($("playerList"), true);

  // 후보 준비
  let candidates = soloWorldcupRoundsFromContent(content);

  // 라운드 방식: 간단 토너먼트 (짝 만들고 승자만 다음 라운드로)
  let round = 1;
  while (candidates.length > 1) {
    const next = [];
    totalMatches = Math.ceil(candidates.length / 2);
    currentRoundIndex = 0;

    for (let i = 0; i < candidates.length; i += 2) {
      currentRoundIndex++;

      const A = candidates[i];
      const B = candidates[i + 1] || null;

      // 홀수면 자동 진출
      if (!B) {
        next.push(A);
        continue;
      }

      // 매치 세팅
      currentMatch = {
        A: A.title,
        B: B.title,
        mediaA: A.media,
        mediaB: B.media,
      };

      setupWorldcupRound();
      $("worldcupTitle").textContent = `솔로 — ${title} (라운드 ${round} / 매치 ${currentRoundIndex}/${totalMatches})`;

      // 선택 활성화
      $("btnChoiceA").disabled = false;
      $("btnChoiceB").disabled = false;

      // 타이머 (솔로는 30초)
      const SOLO_WC_SEC = 30;
      startCountdown(SOLO_WC_SEC);

      const choice = await new Promise((resolve) => {
        let done = false;
        const cleanup = [];

        const finish = (c) => {
          if (done) return;
          done = true;
          cleanup.forEach((fn) => {
            try {
              fn();
            } catch {}
          });
          resolve(c);
        };

        const onA = () => finish("A");
        const onB = () => finish("B");

        $("btnChoiceA")?.addEventListener("click", onA);
        $("btnChoiceB")?.addEventListener("click", onB);
        cleanup.push(() => $("btnChoiceA")?.removeEventListener("click", onA));
        cleanup.push(() => $("btnChoiceB")?.removeEventListener("click", onB));

        const tid = setTimeout(() => finish(null), SOLO_WC_SEC * 1000);
        cleanup.push(() => clearTimeout(tid));
      });

      stopCountdown();
      setHidden($("timerPill"), true);

      // 시간초과면 랜덤
      const finalChoice = choice || (Math.random() < 0.5 ? "A" : "B");

      // 결과 UI
      $("myPick").textContent = finalChoice;
      $("roundState").textContent = "결과 공개";

      const winner = soloPickWinner(finalChoice, { A: A, B: B });
      const winnerTitle = winner.title;

      setHidden($("waitingPanel"), true);
      setHidden($("revealPanel"), false);

      // 간단 퍼센트(솔로라 100:0)
      const percentA = finalChoice === "A" ? 100 : 0;
      const percentB = 100 - percentA;

      $("revealText").innerHTML = `
        <div class="reveal-bar-wrap">
          <span class="reveal-bar-label"><b>${currentMatch.A}</b></span>
          <div class="reveal-bar"><div class="reveal-bar-fill a" style="width:${percentA}%"></div></div>
          <span class="reveal-bar-label">${percentA}%</span>
        </div>
        <div class="reveal-bar-wrap">
          <span class="reveal-bar-label"><b>${currentMatch.B}</b></span>
          <div class="reveal-bar"><div class="reveal-bar-fill b" style="width:${percentB}%"></div></div>
          <span class="reveal-bar-label">${percentB}%</span>
        </div>
        ${choice ? "" : `<div class="reveal-tie">시간 초과 → 랜덤 선택</div>`}
        <div class="reveal-winner">진출: <b>${winnerTitle}</b></div>
      `;

      // 다음
      setHidden($("btnNextRound"), false);
      $("btnNextRound").disabled = false;
      $("btnNextRound").textContent = "다음";

      await new Promise((resolve) => {
        const handler = () => {
          $("btnNextRound")?.removeEventListener("click", handler);
          resolve();
        };
        $("btnNextRound")?.addEventListener("click", handler);
      });

      next.push(winner);
    }

    candidates = next;
    round++;
  }

  // 최종 결과
  const champ = candidates[0]?.title || "-";
  setHidden($("worldcupSection"), false);
  setHidden($("revealPanel"), true);
  setHidden($("waitingPanel"), true);
  setHidden($("btnNextRound"), true);
  stopCountdown();
  setHidden($("timerPill"), true);

  $("finishedContent").innerHTML = `
    <div class="champion">우승: <b>${champ}</b></div>
    <div style="margin-top:16px">
      <a href="./index.html" class="btn primary">홈으로</a>
    </div>
  `;
  log(`솔로 월드컵 종료: ${champ}`);
}

// =============================
// 솔로 진입 (URL 파라미터 기반)
// - ?solo=1&type=quiz&id=uuid
// - ?solo=1&type=worldcup&id=uuid
// =============================
function getParam(name) {

  const url = new URL(location.href);
  return url.searchParams.get(name);
}

async function fetchContentById(contentId) {
  // ✅ Supabase로 contents 단건 조회 (테이블명/컬럼명은 네 프로젝트에 맞춰 조정)
  // 여기서는: contents(id, type, title, payload/json 등) 형태를 가정
  const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

  // payload 컬럼명: content_data / data / payload 등 프로젝트마다 달라서
  // 아래는 가장 흔한 payload 라는 이름으로 가정하고, 없으면 row 전체를 content로 처리
  const { data, error } = await supabase.from("contents").select("*").eq("id", contentId).single();
  if (error) throw error;
  return data;
}

function extractQuizQuestionsFromContent(row) {
  // row 안에 questions가 어디에 있든 방어
  const payload = row?.payload || row?.data || row?.content_data || row;
  const questions = payload?.questions || row?.questions || [];
  return Array.isArray(questions) ? questions : [];
}

async function initSoloIfNeeded() {
  const solo = getParam("solo");
  if (solo !== "1") return false;

  const type = getParam("type") || "quiz";

  // ✅ 핵심: id + legacy contentId 둘 다 허용
  const contentId = getParam("id") || getParam("contentId") || getParam("content_id");

  if (!contentId) {
    log("솔로 모드: id/contentId 파라미터 없음");
    return true; // solo=1인데 콘텐츠가 없으니 여기서 종료
  }

  try {
    const row = await fetchContentById(contentId);
    const contentTitle = row?.title || "콘텐츠";

    if (type === "worldcup") {
      await soloWorldcup(row);
    } else {
      const qs = extractQuizQuestionsFromContent(row);
      await soloQuiz(qs, contentTitle);
    }
  } catch (e) {
    log(`솔로 로드 실패: ${e?.message || e}`);
    alert("솔로 콘텐츠 로드 실패 😭");
  }

  return true; // solo 처리했으니 멀티로 가지 않게 true 반환
}

// =============================
// 멀티(소켓) 이벤트 핸들러
// =============================
function bindSocketHandlers(sock) {
  // 방 상태 업데이트
  sock.on("room:state", (room) => {
    renderRoomState(room);

    // 모드 반영 & UI phase 유지
    if (room?.mode) roomMode = room.mode;
    const phase = room?.phase || "lobby";
    showPhase(phase);
  });

  // 월드컵: 라운드 시작(매치 정보)
  sock.on("worldcup:round", (payload) => {
    if (!payload) return;

    currentMatch = payload.match || currentMatch;
    currentRoundIndex = payload.roundIndex ?? currentRoundIndex;
    totalMatches = payload.totalMatches ?? totalMatches;

    showPhase("playing");
    setupWorldcupRound();

    // 타이머
    if (payload.timer?.enabled) startCountdown(payload.timer.sec);
  });

  // 월드컵: 결과 공개
  sock.on("worldcup:reveal", (payload) => {
    showPhase("playing");
    revealWorldcup(payload);
  });

  // 월드컵: 최종 종료(우승/점수)
  sock.on("worldcup:finished", (payload) => {
    showPhase("playing");
    renderFinished(payload?.champion, payload?.scores || []);
  });

  // 퀴즈: 문제 공개
  sock.on("quiz:question", (payload) => {
    roomMode = "quiz";
    showPhase("playing");
    renderQuizQuestion(payload);
  });

  // 퀴즈: 답변 시작(타이머 + mcq enable + youtube startAt 세팅)
  sock.on("quiz:answering", (payload) => {
    roomMode = "quiz";
    showPhase("playing");
    handleQuizAnswering(payload);
  });

  // 퀴즈: 정답 공개
  sock.on("quiz:reveal", (payload) => {
    roomMode = "quiz";
    showPhase("playing");
    renderQuizReveal(payload);
  });

  // 퀴즈: 점수판
  sock.on("quiz:scoreboard", (payload) => {
    roomMode = "quiz";
    showPhase("playing");
    renderQuizScoreboard(payload);
  });

  // 퀴즈: 종료
  sock.on("quiz:finished", (payload) => {
    roomMode = "quiz";
    showPhase("playing");
    renderQuizFinished(payload);
  });

  // 서버 로그/알림용(있으면)
  sock.on("server:log", (msg) => log(`[server] ${msg}`));

  // 재접속/끊김 표시
  sock.on("disconnect", () => {
    log("socket disconnected");
  });
  sock.on("connect", () => {
    log("socket connected");
  });
}

// =============================
// 버튼 바인딩 (멀티 공용)
// =============================
function bindUIActions() {
  // 월드컵 선택
  $("btnChoiceA")?.addEventListener("click", () => commitPick("A"));
  $("btnChoiceB")?.addEventListener("click", () => commitPick("B"));

  // 월드컵 다음 라운드(호스트만 활성)
  $("btnNextRound")?.addEventListener("click", () => {
    if (!socket?.connected || !currentRoomId) return;
    if (!isHost) return;

    socket.emit("worldcup:next", { roomId: currentRoomId }, (res) => {
      if (!res?.ok) log(`next 실패: ${res?.error || "?"}`);
    });
  });

  // 퀴즈: 다음(호스트만)
  $("btnQuizNext")?.addEventListener("click", () => {
    if (!socket?.connected || !currentRoomId) return;
    if (!isHost) return;

    socket.emit("quiz:next", { roomId: currentRoomId }, (res) => {
      if (!res?.ok) log(`quiz next 실패: ${res?.error || "?"}`);
    });
  });

  // 퀴즈: short 제출
  $("btnQuizSubmitShort")?.addEventListener("click", () => {
    const val = $("quizShortInput")?.value?.trim();
    if (!val) return;
    submitQuizAnswer(val);
  });
  $("quizShortInput")?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      $("btnQuizSubmitShort")?.click();
    }
  });

  // 퀴즈: 오디오 제출
  $("btnQuizSubmitAudio")?.addEventListener("click", () => {
    const val = $("quizAudioInput")?.value?.trim();
    if (!val) return;
    submitQuizAnswer(val);
  });
  $("quizAudioInput")?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      $("btnQuizSubmitAudio")?.click();
    }
  });

  // 유튜브 퀴즈(멀티): Ready 버튼 → 서버에 ready
  $("btnQuizReady")?.addEventListener("click", () => {
    if (!socket?.connected || !currentRoomId) return;
    socket.emit("quiz:ready", { roomId: currentRoomId }, (res) => {
      if (!res?.ok) log(`ready 실패: ${res?.error || "?"}`);
    });
    $("btnQuizReady").disabled = true;
  });

  // 유튜브 퀴즈(멀티): Play 버튼 (서버 startAt에 맞춰 재생)
  $("btnQuizPlay")?.addEventListener("click", () => {
    if (!pendingYouTube || !ytPlayer) return;

    const startAt = pendingYouTube.startAt;
    const offsetSec = Number(pendingYouTube.offsetSec) || 0;
    const durSec = Number(pendingYouTube.durationSec) || 10;

    // startAt 시각에 맞춰 play
    const now = Date.now();
    const delay = Math.max(0, startAt - now);

    $("btnQuizPlay").disabled = true;
    $("btnQuizPlay").textContent = "재생 대기…";

    setTimeout(() => {
      try {
        ytPlayer.seekTo(offsetSec, true);
        ytPlayer.playVideo();
      } catch {}

      $("btnQuizPlay").textContent = "재생 중…";

      // durSec 후 정지
      if (playbackTimer) clearInterval(playbackTimer);
      let left = durSec;
      $("quizPlaybackInfo").textContent = `재생 중… ${left}초 남음`;
      setHidden($("quizPlaybackInfo"), false);

      playbackTimer = setInterval(() => {
        left--;
        if (left <= 0) {
          clearInterval(playbackTimer);
          playbackTimer = null;
          try {
            ytPlayer.pauseVideo();
          } catch {}
          $("quizPlaybackInfo").textContent = "재생 종료";
          $("btnQuizPlay").textContent = "재생 완료";
        } else {
          $("quizPlaybackInfo").textContent = `재생 중… ${left}초 남음`;
        }
      }, 1000);
    }, delay);
  });

  // 로그아웃
  $("btnLogout")?.addEventListener("click", async () => {
    try {
      await signOut();
    } catch {}
    location.href = "./index.html";
  });
}

// =============================
// 멀티: room 연결/입장
// =============================
async function joinRoomFromURLIfAny() {
  const url = new URL(location.href);
  const roomId = url.searchParams.get("roomId");
  if (!roomId) return;

  currentRoomId = roomId;

  // room.html 들어오면 자동 join
  if (!socket?.connected) return;
  socket.emit("room:join", { roomId }, (res) => {
    if (!res?.ok) {
      log(`room join 실패: ${res?.error || "?"}`);
      alert("방 입장 실패 😭");
      return;
    }
    log(`room join ok: ${roomId}`);
  });
}

// =============================
// 게임 시작(호스트)
// =============================
function bindStartGameButton() {
  $("btnStartGame")?.addEventListener("click", () => {
    if (!socket?.connected || !currentRoomId) return;
    if (!isHost) return;

    socket.emit("game:start", { roomId: currentRoomId }, (res) => {
      if (!res?.ok) log(`start 실패: ${res?.error || "?"}`);
    });
  });
}

// =============================
// 부팅(엔트리)
// - 1) 세션 복구
// - 2) 솔로면 solo 실행 후 종료
// - 3) 멀티면 소켓 연결 + 핸들러 + URL room join
// =============================
async function boot() {
  console.log("✅ boot start");

  // 기본 UI
  showPhase("lobby");
  bindUIActions();
  bindStartGameButton();

  // 세션 복구(로그인)
  try {
    await restoreSession();
  } catch (e) {
    log(`restoreSession 실패: ${e?.message || e}`);
  }

  // ✅ SOLO 분기(있으면 여기서 끝)
  const isSolo = await initSoloIfNeeded();
  if (isSolo) return;

  // 멀티: 소켓 연결
  try {
    socket = await connectSocket();
    bindSocketHandlers(socket);
  } catch (e) {
    log(`socket connect 실패: ${e?.message || e}`);
    alert("서버 연결 실패 😭");
    return;
  }

  // URL에 roomId 있으면 자동 join
  await joinRoomFromURLIfAny();

  // auth 변화 감지(로그아웃/세션 만료 등)
  onAuthChange(() => {
    // accessToken 변경되면 소켓 재연결이 필요할 수 있음 (서버가 JWT 검증하면)
    log("auth change detected");
  });
}

window.addEventListener("DOMContentLoaded", boot);
