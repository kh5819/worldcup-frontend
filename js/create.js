import { $, log, setHidden } from "./config.js";
import { supabase, restoreSession, signIn, signUp, signOut, accessToken, session } from "./auth.js";

const MIN_CANDIDATES = 8;
const MAX_TAGS = 10;
const MAX_TAG_LEN = 20;

let candidateCount = 0;
let tags = [];
let saving = false;

// =============================
// Utils
// =============================
function normTag(s) {
  // 공백 정리 + 너무 긴 입력 방지
  return (s || "")
    .trim()
    .replace(/\s+/g, " ")
    .slice(0, MAX_TAG_LEN);
}

function isHttpUrl(s) {
  return typeof s === "string" && /^https?:\/\//i.test(s.trim());
}

function isYoutubeId(s) {
  return typeof s === "string" && /^[A-Za-z0-9_-]{11}$/.test(s.trim());
}

// =============================
// 태그 시스템
// =============================
function renderTags() {
  const container = $("tagContainer");
  if (!container) return;

  container.querySelectorAll(".tag-chip").forEach((el) => el.remove());
  const input = $("tagInput");
  if (!input) return;

  tags.forEach((tag, i) => {
    const chip = document.createElement("span");
    chip.className = "tag-chip";
    chip.innerHTML = `${tag} <span class="tag-x" data-idx="${i}">&times;</span>`;
    container.insertBefore(chip, input);
  });
}

function addTag(raw) {
  const t = normTag(raw);
  if (!t) return;
  if (tags.length >= MAX_TAGS) return;
  if (tags.includes(t)) return;

  tags.push(t);
  renderTags();
}

$("tagInput")?.addEventListener("keydown", (e) => {
  if (e.key === "Enter" || e.key === ",") {
    e.preventDefault();
    e.stopPropagation(); // ✅ 폼 submit 방지 확실
    addTag(e.target.value);
    e.target.value = "";
  }
});

$("tagContainer")?.addEventListener("click", (e) => {
  const x = e.target.closest(".tag-x");
  if (!x) return;
  tags.splice(Number(x.dataset.idx), 1);
  renderTags();
});

// =============================
// 썸네일 미리보기
// =============================
$("thumbnailFile")?.addEventListener("change", (e) => {
  const file = e.target.files?.[0];
  if (!file) {
    setHidden($("thumbnailPreview"), true);
    return;
  }

  const reader = new FileReader();
  reader.onload = () => {
    const img = $("thumbImg");
    if (img) img.src = reader.result;
    setHidden($("thumbnailPreview"), false);
  };
  reader.readAsDataURL(file);
});

// =============================
// 후보 입력 필드 (미디어 타입 확장)
// =============================
function renderCandidateRows(count) {
  const container = $("candidateList");
  if (!container) return;

  container.innerHTML = "";
  for (let i = 0; i < count; i++) {
    const div = document.createElement("div");
    div.className = "cand-row-v2";
    div.innerHTML =
      `<span class="num">${i + 1}</span>` +
      `<input data-cand="${i}" data-field="name" class="cand-name" placeholder="후보명 (필수)" />` +
      `<select data-cand="${i}" data-field="mediaType" class="cand-select">
        <option value="image">이미지</option>
        <option value="gif">GIF</option>
        <option value="youtube">유튜브</option>
        <option value="mp4">MP4</option>
        <option value="url">URL</option>
      </select>` +
      `<input data-cand="${i}" data-field="url" class="cand-url" placeholder="미디어 URL (선택)" />` +
      `<span class="cand-sec-wrap" data-cand="${i}" data-field="secWrap" style="display:none">` +
      `<input data-cand="${i}" data-field="startSec" type="number" min="0" class="cand-sec" placeholder="시작(초)" />` +
      `<input data-cand="${i}" data-field="durationSec" type="number" min="1" max="600" class="cand-sec" placeholder="길이(초)" />` +
      `</span>`;

    container.appendChild(div);

    const sel = div.querySelector(`select[data-cand="${i}"]`);
    sel?.addEventListener("change", () => toggleSecFields(i));
  }

  const cc = $("candCount");
  if (cc) cc.textContent = `현재 후보: ${count}개 (최소 ${MIN_CANDIDATES}개)`;
}

function toggleSecFields(idx) {
  const sel = document.querySelector(`select[data-cand="${idx}"][data-field="mediaType"]`);
  const wrap = document.querySelector(`span[data-cand="${idx}"][data-field="secWrap"]`);
  if (!sel || !wrap) return;
  const show = sel.value === "youtube" || sel.value === "mp4";
  wrap.style.display = show ? "flex" : "none";
}

function collectCandidateValues() {
  const vals = [];
  for (let i = 0; i < candidateCount; i++) {
    vals.push({
      name: document.querySelector(`input[data-cand="${i}"][data-field="name"]`)?.value || "",
      url: document.querySelector(`input[data-cand="${i}"][data-field="url"]`)?.value || "",
      mediaType: document.querySelector(`select[data-cand="${i}"][data-field="mediaType"]`)?.value || "image",
      startSec: document.querySelector(`input[data-cand="${i}"][data-field="startSec"]`)?.value || "",
      durationSec: document.querySelector(`input[data-cand="${i}"][data-field="durationSec"]`)?.value || "",
    });
  }
  return vals;
}

function restoreCandidateValues(vals) {
  vals.forEach((v, i) => {
    const nameEl = document.querySelector(`input[data-cand="${i}"][data-field="name"]`);
    const urlEl = document.querySelector(`input[data-cand="${i}"][data-field="url"]`);
    const typeEl = document.querySelector(`select[data-cand="${i}"][data-field="mediaType"]`);
    const startEl = document.querySelector(`input[data-cand="${i}"][data-field="startSec"]`);
    const durEl = document.querySelector(`input[data-cand="${i}"][data-field="durationSec"]`);

    if (nameEl) nameEl.value = v.name;
    if (urlEl) urlEl.value = v.url;
    if (typeEl) typeEl.value = v.mediaType;
    if (startEl) startEl.value = v.startSec;
    if (durEl) durEl.value = v.durationSec;

    toggleSecFields(i);
  });
}

function setCandidateCount(newCount) {
  const oldVals = collectCandidateValues();
  candidateCount = newCount;
  renderCandidateRows(candidateCount);
  restoreCandidateValues(oldVals);
}

setCandidateCount(MIN_CANDIDATES);

$("btnAddCand")?.addEventListener("click", () => setCandidateCount(candidateCount + 1));

$("btnRemoveCand")?.addEventListener("click", () => {
  const msg = $("createMsg");
  if (candidateCount <= MIN_CANDIDATES) {
    if (msg) msg.textContent = `최소 ${MIN_CANDIDATES}개 이상이어야 합니다.`;
    return;
  }
  setCandidateCount(candidateCount - 1);
});

// =============================
// Auth UI
// =============================
$("btnSignUp")?.addEventListener("click", async () => {
  try {
    $("authMsg").textContent = "";
    await signUp($("email").value.trim(), $("password").value.trim());
    $("authMsg").textContent = "회원가입 요청 완료. 이메일 확인이 필요할 수 있음.";
  } catch (e) {
    $("authMsg").textContent = `회원가입 실패: ${e.message}`;
  }
});

$("btnSignIn")?.addEventListener("click", async () => {
  try {
    $("authMsg").textContent = "";
    await signIn($("email").value.trim(), $("password").value.trim());
    $("authMsg").textContent = "로그인 성공!";
  } catch (e) {
    $("authMsg").textContent = `로그인 실패: ${e.message}`;
  }
});

$("btnLogout")?.addEventListener("click", () => signOut());

// =============================
// 유튜브 URL → videoId 파싱 (강화판)
// =============================
function parseYoutubeUrl(input) {
  if (!input) return input;
  const s = input.trim();
  if (isYoutubeId(s)) return s;

  try {
    const url = new URL(s);
    const host = url.hostname.replace("www.", "");

    if (host === "youtu.be") return url.pathname.split("/")[1] || s;

    const v = url.searchParams.get("v");
    if (v) return v;

    const parts = url.pathname.split("/").filter(Boolean);
    const shortsIdx = parts.indexOf("shorts");
    if (shortsIdx >= 0 && parts[shortsIdx + 1]) return parts[shortsIdx + 1];

    const embedIdx = parts.indexOf("embed");
    if (embedIdx >= 0 && parts[embedIdx + 1]) return parts[embedIdx + 1];

    return s;
  } catch {
    return s;
  }
}

// =============================
// 썸네일 업로드 (Supabase Storage)
// =============================
async function uploadThumbnail(contentId) {
  const file = $("thumbnailFile")?.files?.[0];
  if (!file) return null;

  const userId = session?.user?.id;
  if (!userId) return null;

  const ext = file.name.split(".").pop() || "jpg";
  const path = `${userId}/${contentId}.${ext}`;

  const { error } = await supabase.storage
    .from("thumbnails")
    .upload(path, file, { upsert: true, contentType: file.type });

  if (error) {
    log(`썸네일 업로드 실패: ${error.message}`);
    return null;
  }

  const { data } = supabase.storage.from("thumbnails").getPublicUrl(path);
  return data?.publicUrl || null;
}

// =============================
// 저장
// =============================
$("btnSaveContent")?.addEventListener("click", async () => {
  const msg = $("createMsg");
  if (msg) msg.textContent = "";

  // ✅ 중복 클릭 방지
  if (saving) return;
  saving = true;

  if (!accessToken || !session?.user) {
    if (msg) msg.textContent = "로그인 후 이용하세요.";
    saving = false;
    return;
  }

  const title = $("createTitle").value.trim();
  if (!title) {
    if (msg) msg.textContent = "제목을 입력하세요.";
    saving = false;
    return;
  }

  const description = $("createDesc").value.trim();
  const visibility = $("createVisibility").value;
  const category = $("createCategory").value || null;

  const candidates = [];

  for (let i = 0; i < candidateCount; i++) {
    const nameEl = document.querySelector(`input[data-cand="${i}"][data-field="name"]`);
    const urlEl = document.querySelector(`input[data-cand="${i}"][data-field="url"]`);
    const typeEl = document.querySelector(`select[data-cand="${i}"][data-field="mediaType"]`);
    const startEl = document.querySelector(`input[data-cand="${i}"][data-field="startSec"]`);
    const durEl = document.querySelector(`input[data-cand="${i}"][data-field="durationSec"]`);

    const name = nameEl?.value?.trim() || "";
    const rawUrl = urlEl?.value?.trim() || "";
    const mediaType = typeEl?.value || "image";
    const startSec = startEl?.value ? parseInt(startEl.value, 10) : null;
    const durationSec = durEl?.value ? parseInt(durEl.value, 10) : null;

    if (!name) {
      if (msg) msg.textContent = `후보 ${i + 1}번 이름이 비어 있습니다.`;
      nameEl?.focus();
      saving = false;
      return;
    }

    // 타입별 필수 URL
    if ((mediaType === "youtube" || mediaType === "mp4" || mediaType === "url") && !rawUrl) {
      if (msg) msg.textContent = `후보 ${i + 1}번: ${mediaType.toUpperCase()}는 URL이 필수입니다.`;
      urlEl?.focus();
      saving = false;
      return;
    }

    // ✅ youtube: videoId(11자리) 검증
    let finalUrl = rawUrl;
    if (mediaType === "youtube") {
      const vid = parseYoutubeUrl(rawUrl);
      if (!isYoutubeId(vid)) {
        if (msg) msg.textContent = `후보 ${i + 1}번: 유효한 유튜브 링크(또는 11자리 videoId)가 아닙니다.`;
        urlEl?.focus();
        saving = false;
        return;
      }
      finalUrl = vid;
    } else {
      // youtube 제외: http(s) 체크 (url/mp4/gif/image 등 URL 넣는 타입)
      if (finalUrl && !isHttpUrl(finalUrl)) {
        if (msg) msg.textContent = `후보 ${i + 1}번 URL이 http(s)로 시작하지 않습니다.`;
        urlEl?.focus();
        saving = false;
        return;
      }
    }

    // ✅ start/duration 기본 검증
    if (startSec !== null && startSec < 0) {
      if (msg) msg.textContent = `후보 ${i + 1}번: 시작(초)은 0 이상이어야 합니다.`;
      saving = false;
      return;
    }
    if (durationSec !== null && (durationSec < 1 || durationSec > 600)) {
      if (msg) msg.textContent = `후보 ${i + 1}번: 길이(초)는 1~600 사이여야 합니다.`;
      saving = false;
      return;
    }

    // ✅ youtube/mp4: start+duration 쌍 입력 강제 (둘 다 or 둘 다 X)
    const needClip = mediaType === "youtube" || mediaType === "mp4";
    if (needClip) {
      const hasStart = startSec !== null;
      const hasDur = durationSec !== null;
      if (hasStart !== hasDur) {
        if (msg) msg.textContent = `후보 ${i + 1}번: 시작(초)과 길이(초)는 둘 다 입력하거나 둘 다 비워야 합니다.`;
        saving = false;
        return;
      }
    }

    candidates.push({
      name,
      url: finalUrl,
      mediaType,
      startSec,
      durationSec,
    });
  }

  // UI 잠금
  $("btnSaveContent").disabled = true;
  if (msg) msg.textContent = "저장 중…";

  try {
    const { data: content, error: cErr } = await supabase
      .from("contents")
      .insert({
        title,
        description: description || null,
        visibility,
        mode: "worldcup",
        owner_id: session.user.id,
        category,
        tags: tags.length > 0 ? tags : null,
      })
      .select("id")
      .single();

    if (cErr || !content) throw new Error(cErr?.message || "contents insert 실패");

    const contentId = content.id;

    if (msg) msg.textContent = "썸네일 업로드 중…";
    const thumbnailUrl = await uploadThumbnail(contentId);
    if (thumbnailUrl) {
      await supabase.from("contents").update({ thumbnail_url: thumbnailUrl }).eq("id", contentId);
    }

    if (msg) msg.textContent = "후보 저장 중…";
    const rows = candidates.map((c, i) => ({
      content_id: contentId,
      name: c.name,
      media_type: c.mediaType,
      media_url: c.url || `https://picsum.photos/seed/${contentId}-${i}/600/400`,
      start_sec: c.startSec,
      duration_sec: c.durationSec,
      sort_order: i + 1,
    }));

    const { error: rErr } = await supabase.from("worldcup_candidates").insert(rows);
    if (rErr) throw new Error(rErr.message || "candidates insert 실패");

    if (msg) msg.textContent = "저장 완료! 🎉";
    const createdId = $("createdId");
    if (createdId) createdId.textContent = contentId;
    setHidden($("createResult"), false);

    log(`✅ 콘텐츠 저장 완료: ${contentId} / 후보=${candidates.length} / 태그=${tags.length}`);
  } catch (e) {
    if (msg) msg.textContent = `저장 실패: ${e.message}`;
    log(`❌ 제작 저장 에러: ${e.message}`);
  } finally {
    $("btnSaveContent").disabled = false;
    saving = false;
  }
});

// =============================
// 복사 버튼
// =============================
$("btnCopyId")?.addEventListener("click", () => {
  const id = $("createdId")?.textContent;
  if (!id || id === "-") return;

  navigator.clipboard
    .writeText(id)
    .then(() => {
      $("btnCopyId").textContent = "복사됨! ✅";
      setTimeout(() => {
        $("btnCopyId").textContent = "복사";
      }, 1500);
    })
    .catch(() => log("클립보드 복사 실패"));
});

// =============================
// 바로 방 만들기
// =============================
$("btnUseId")?.addEventListener("click", () => {
  const id = $("createdId")?.textContent;
  if (!id || id === "-") return;
  window.location.href = `room.html?id=${encodeURIComponent(id)}`;
});

// =============================
// 초기화
// =============================
await restoreSession();
log("✨ Create 페이지 준비 완료!");
