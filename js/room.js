import { $, log, setHidden } from "./config.js";
import {
  restoreSession,
  signIn,
  signUp,
  signOut,
  onAuthChange,
  accessToken,
} from "./auth.js";
import { connectSocket, disconnectSocket } from "./socket.js";

/**
 * =========================================
 * Room Page Script (최종본)
 * - URL 규격 통일: ?id=CONTENT_ID (legacy: contentId도 허용)
 * - resume 복귀 시 roomId + id 함께 유지 (없으면 방어 처리)
 * - 로그인 상태 변화 시 소켓 정리
 * =========================================
 */

// ✅ Auth 변경 시 소켓 정리
onAuthChange(() => disconnectSocket());

// =============================
// URL 쿼리 파싱 (최종 규격: id)
// - legacy 호환: ?contentId=... 도 id로 인식
// =============================
const params = new URLSearchParams(window.location.search);
const qId = params.get("id") || params.get("contentId") || params.get("content_id");
const qMode = params.get("mode") || params.get("type");

// =============================
// 진행 중인 방 복귀 배너
// - currentRoomId + currentContentId 같이 저장해둔 경우 최적
// =============================
const savedRoomId = localStorage.getItem("currentRoomId");
const savedContentId = localStorage.getItem("currentContentId");

if (savedRoomId) {
  setHidden($("resumeBanner"), false);

  const goResume = () => {
    // ✅ id가 있으면 같이 붙여서 play에서 콘텐츠 로드 실패 방지
    const cid = savedContentId || qId;
    const qs = new URLSearchParams();
    qs.set("roomId", savedRoomId);
    if (cid) qs.set("id", cid);

    window.location.href = `play.html?${qs.toString()}`;
  };

  $("resumeBanner")?.addEventListener("click", goResume);
  $("btnResume")?.addEventListener("click", goResume);
}

// =============================
// URL 쿼리에서 id/mode 자동 채우기
// =============================
if (qId && $("contentId")) {
  $("contentId").value = qId;
  $("contentId").classList.add("glow");
  setTimeout(() => $("contentId").classList.remove("glow"), 1200);
}

if (qMode) {
  const radio = document.querySelector(`input[name="mode"][value="${qMode}"]`);
  if (radio) radio.checked = true;
}

// =============================
// Auth UI
// =============================
$("btnSignUp")?.addEventListener("click", async () => {
  try {
    if ($("authMsg")) $("authMsg").textContent = "";
    await signUp($("email").value.trim(), $("password").value.trim());
    if ($("authMsg")) $("authMsg").textContent = "회원가입 요청 완료. 이메일 확인이 필요할 수 있음.";
  } catch (e) {
    if ($("authMsg")) $("authMsg").textContent = `회원가입 실패: ${e.message}`;
  }
});

$("btnSignIn")?.addEventListener("click", async () => {
  try {
    if ($("authMsg")) $("authMsg").textContent = "";
    await signIn($("email").value.trim(), $("password").value.trim());
    if ($("authMsg")) $("authMsg").textContent = "로그인 성공!";
  } catch (e) {
    if ($("authMsg")) $("authMsg").textContent = `로그인 실패: ${e.message}`;
  }
});

$("btnLogout")?.addEventListener("click", () => signOut());

// =============================
// 공통: 로그인 체크
// =============================
function requireAuthOrMessage() {
  if (!accessToken) {
    log("로그인 필요");
    const el = $("roomMsg");
    if (el) el.textContent = "로그인 후 이용하세요";
    return false;
  }
  return true;
}

// =============================
// 방 생성
// =============================
$("btnCreateRoom")?.addEventListener("click", () => {
  if (!requireAuthOrMessage()) return;

  // ✅ 최종 규격: contentId 입력칸은 유지하되, URL 기준은 id로 통일
  const contentId = $("contentId")?.value?.trim();
  if (!contentId) {
    const el = $("roomMsg");
    if (el) el.textContent = "콘텐츠 ID를 입력하세요";
    return;
  }

  const hostName = $("hostName")?.value?.trim() || "host";
  const timerEnabled = $("timerEnabled")?.checked || false;
  const timerSec = Number($("timerSec")?.value || 45);
  const timeoutPolicy = document.querySelector('input[name="timeoutPolicy"]:checked')?.value || "RANDOM";
  const mode = document.querySelector('input[name="mode"]:checked')?.value || "worldcup";

  const sock = connectSocket();
  if (!sock) return;

  const doCreate = () => {
    sock.emit(
      "room:create",
      {
        hostName,
        mode,
        contentId, // ✅ 서버에는 그대로 contentId로 보냄 (백엔드 유지)
        timerEnabled,
        timerSec,
        timeoutPolicy,
        maxPlayers: 4,
      },
      (res) => {
        if (!res?.ok) {
          const el = $("roomMsg");
          if (el) el.textContent = `방 생성 실패: ${res?.error || "?"}`;
          log(`방 생성 실패: ${res?.error}`);
          return;
        }

        const roomId = res.roomId;

        // ✅ 복귀를 위해 둘 다 저장
        localStorage.setItem("currentRoomId", roomId);
        localStorage.setItem("currentContentId", contentId);

        log(`방 생성됨: ${roomId}`);

        // ✅ play로 이동: roomId + id(콘텐츠) 같이 전달
        const qs = new URLSearchParams();
        qs.set("roomId", roomId);
        qs.set("id", contentId);

        window.location.href = `play.html?${qs.toString()}`;
      }
    );
  };

  if (sock.connected) doCreate();
  else sock.once("connect", doCreate);
});

// =============================
// 방 입장
// =============================
$("btnJoinRoom")?.addEventListener("click", () => {
  if (!requireAuthOrMessage()) return;

  const roomId = $("roomId")?.value?.trim();
  if (!roomId) {
    const el = $("roomMsg");
    if (el) el.textContent = "방 코드를 입력하세요";
    return;
  }

  const name = $("joinName")?.value?.trim() || "player";
  const sock = connectSocket();
  if (!sock) return;

  const doJoin = () => {
    sock.emit("room:join", { roomId, name }, (res) => {
      if (!res?.ok) {
        const el = $("roomMsg");
        const errText =
          res?.error === "ROOM_NOT_FOUND"
            ? "방이 존재하지 않습니다. 방 코드를 확인하세요."
            : `입장 실패: ${res?.error || "알 수 없는 오류"}`;
        if (el) el.textContent = errText;
        log(`입장 실패: ${res?.error}`);
        return;
      }

      // ✅ 방 입장도 복귀 저장
      localStorage.setItem("currentRoomId", roomId);

      // ✅ contentId는 (1) 입력값 (2) URL의 id (3) 저장된 값 순으로 채움
      const contentId = $("contentId")?.value?.trim() || qId || savedContentId;
      if (contentId) localStorage.setItem("currentContentId", contentId);

      log(`방 입장: ${roomId}`);

      // ✅ play로 이동: roomId + id(가능하면) 같이 전달
      const qs = new URLSearchParams();
      qs.set("roomId", roomId);
      if (contentId) qs.set("id", contentId);

      window.location.href = `play.html?${qs.toString()}`;
    });
  };

  if (sock.connected) doJoin();
  else sock.once("connect", doJoin);
});

// =============================
// 초기화
// =============================
await restoreSession();
log("Room 페이지 준비 완료.");
