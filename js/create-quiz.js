import { $, log, setHidden } from './config.js';
import { supabase, restoreSession, signIn, signUp, signOut, accessToken, session } from './auth.js';
import { SUPABASE_URL } from './config.js';
const MIN_QUESTIONS = 3;
const MAX_TAGS = 10;
const MAX_TAG_LEN = 20;
let questionCount = 0;
let tags = [];

// ✅ (추가) 저장 중복 클릭 방지 플래그
let saving = false;


// ===== 태그 시스템 (create.js와 동일 패턴) =====

function renderTags() {
  const container = $("tagContainer");
  container.querySelectorAll(".tag-chip").forEach(el => el.remove());
  const input = $("tagInput");
  tags.forEach((tag, i) => {
    const chip = document.createElement("span");
    chip.className = "tag-chip";
    chip.innerHTML = `${tag} <span class="tag-x" data-idx="${i}">&times;</span>`;
    container.insertBefore(chip, input);
  });
}

function addTag(raw) {
  const t = raw.trim().slice(0, MAX_TAG_LEN);
  if (!t || tags.length >= MAX_TAGS || tags.includes(t)) return;
  tags.push(t);
  renderTags();
}

$("tagInput")?.addEventListener("keydown", (e) => {
  if (e.key === "Enter" || e.key === ",") {
    e.preventDefault();
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

// ===== 썸네일 미리보기 =====

$("thumbnailFile")?.addEventListener("change", (e) => {
  const file = e.target.files[0];
  if (!file) { setHidden($("thumbnailPreview"), true); return; }
  const reader = new FileReader();
  reader.onload = () => {
    $("thumbImg").src = reader.result;
    setHidden($("thumbnailPreview"), false);
  };
  reader.readAsDataURL(file);
});

// ===== 유튜브 URL 파싱 =====

function parseYoutubeUrl(input) {
  if (!input) return input;
  if (/^[A-Za-z0-9_-]{11}$/.test(input.trim())) return input.trim();
  try {
    const url = new URL(input);
    if (url.hostname.includes("youtu.be")) return url.pathname.slice(1);
    return url.searchParams.get("v") || input;
  } catch {
    return input;
  }
}

// ===== 썸네일 업로드 =====

async function uploadThumbnail(contentId) {
  const file = $("thumbnailFile")?.files?.[0];
  if (!file) return null;
  const userId = session.user.id;
  const ext = file.name.split(".").pop() || "jpg";
  const path = `${userId}/${contentId}.${ext}`;
  const { error } = await supabase.storage
    .from("thumbnails")
    .upload(path, file, { upsert: true, contentType: file.type });
  if (error) { log(`썸네일 업로드 실패: ${error.message}`); return null; }
  const { data } = supabase.storage.from("thumbnails").getPublicUrl(path);
  return data?.publicUrl || null;
}

// ===== 문제 입력 필드 =====

function renderQuestionRow(idx) {
  const div = document.createElement("div");
  div.className = "quiz-q-row";
  div.dataset.q = idx;

  div.innerHTML = `
    <div class="quiz-q-header">
      <span class="q-num">${idx + 1}</span>
      <select data-q="${idx}" data-field="type" class="input small quiz-q-type">
        <option value="mcq">객관식</option>
        <option value="short">주관식</option>
        <option value="audio_youtube">소리퀴즈(유튜브)</option>
      </select>
    </div>
    <input data-q="${idx}" data-field="prompt" class="input quiz-q-prompt" placeholder="문제 내용 (필수)" />

    <div data-q="${idx}" data-panel="mcq" class="quiz-q-panel">
      <div class="quiz-mcq-list">
        ${[0,1,2,3].map(ci => `
          <label class="quiz-mcq-option">
            <input type="radio" name="q${idx}_correct" value="${ci}" ${ci === 0 ? 'checked' : ''} />
            <input data-q="${idx}" data-choice="${ci}" class="input quiz-choice-input" placeholder="보기 ${ci + 1}" />
          </label>
        `).join('')}
      </div>
      <p class="muted" style="margin:4px 0 0;font-size:12px">라디오 버튼으로 정답을 선택하세요</p>
    </div>

    <div data-q="${idx}" data-panel="short" class="quiz-q-panel" style="display:none">
      <input data-q="${idx}" data-field="answer" class="input" placeholder="정답 (필수)" />
      <input data-q="${idx}" data-field="synonyms" class="input" placeholder="동의어 (쉼표 구분, 선택)" style="margin-top:6px" />
    </div>

    <div data-q="${idx}" data-panel="audio_youtube" class="quiz-q-panel" style="display:none">
      <input data-q="${idx}" data-field="youtubeUrl" class="input" placeholder="유튜브 URL (필수)" />
      <div class="row" style="margin-top:6px">
        <input data-q="${idx}" data-field="startSec" type="number" min="0" class="input small" placeholder="시작(초)" value="0" />
        <input data-q="${idx}" data-field="durationSec" type="number" min="1" max="600" class="input small" placeholder="길이(초)" value="10" />
      </div>
      <input data-q="${idx}" data-field="audioAnswer" class="input" placeholder="정답 (필수)" style="margin-top:6px" />
      <input data-q="${idx}" data-field="audioSynonyms" class="input" placeholder="동의어 (쉼표 구분, 선택)" style="margin-top:6px" />
    </div>
  `;

  const typeSelect = div.querySelector(`select[data-q="${idx}"]`);
  typeSelect.addEventListener("change", () => {
    const t = typeSelect.value;
    div.querySelector(`[data-panel="mcq"]`).style.display = t === "mcq" ? "" : "none";
    div.querySelector(`[data-panel="short"]`).style.display = t === "short" ? "" : "none";
    div.querySelector(`[data-panel="audio_youtube"]`).style.display = t === "audio_youtube" ? "" : "none";
  });

  return div;
}

function collectQuestionValues() {
  const vals = [];
  for (let i = 0; i < questionCount; i++) {
    const typeEl = document.querySelector(`select[data-q="${i}"][data-field="type"]`);
    const promptEl = document.querySelector(`input[data-q="${i}"][data-field="prompt"]`);
    const v = { type: typeEl?.value || "mcq", prompt: promptEl?.value || "" };

    if (v.type === "mcq") {
      v.choices = [];
      for (let ci = 0; ci < 4; ci++) {
        const el = document.querySelector(`input[data-q="${i}"][data-choice="${ci}"]`);
        v.choices.push(el?.value || "");
      }
      v.correctIdx = document.querySelector(`input[name="q${i}_correct"]:checked`)?.value || "0";
    } else if (v.type === "short") {
      v.answer = document.querySelector(`input[data-q="${i}"][data-field="answer"]`)?.value || "";
      v.synonyms = document.querySelector(`input[data-q="${i}"][data-field="synonyms"]`)?.value || "";
    } else if (v.type === "audio_youtube") {
      v.youtubeUrl = document.querySelector(`input[data-q="${i}"][data-field="youtubeUrl"]`)?.value || "";
      v.startSec = document.querySelector(`input[data-q="${i}"][data-field="startSec"]`)?.value || "0";
      v.durationSec = document.querySelector(`input[data-q="${i}"][data-field="durationSec"]`)?.value || "10";
      v.audioAnswer = document.querySelector(`input[data-q="${i}"][data-field="audioAnswer"]`)?.value || "";
      v.audioSynonyms = document.querySelector(`input[data-q="${i}"][data-field="audioSynonyms"]`)?.value || "";
    }
    vals.push(v);
  }
  return vals;
}

function restoreQuestionValues(vals) {
  vals.forEach((v, i) => {
    const typeEl = document.querySelector(`select[data-q="${i}"][data-field="type"]`);
    const promptEl = document.querySelector(`input[data-q="${i}"][data-field="prompt"]`);
    if (typeEl) {
      typeEl.value = v.type;
      typeEl.dispatchEvent(new Event("change"));
    }
    if (promptEl) promptEl.value = v.prompt;

    if (v.type === "mcq") {
      (v.choices || []).forEach((c, ci) => {
        const el = document.querySelector(`input[data-q="${i}"][data-choice="${ci}"]`);
        if (el) el.value = c;
      });
      const radio = document.querySelector(`input[name="q${i}_correct"][value="${v.correctIdx || 0}"]`);
      if (radio) radio.checked = true;
    } else if (v.type === "short") {
      const aEl = document.querySelector(`input[data-q="${i}"][data-field="answer"]`);
      const sEl = document.querySelector(`input[data-q="${i}"][data-field="synonyms"]`);
      if (aEl) aEl.value = v.answer || "";
      if (sEl) sEl.value = v.synonyms || "";
    } else if (v.type === "audio_youtube") {
      const fields = ["youtubeUrl", "startSec", "durationSec", "audioAnswer", "audioSynonyms"];
      fields.forEach(f => {
        const el = document.querySelector(`input[data-q="${i}"][data-field="${f}"]`);
        if (el) el.value = v[f] || "";
      });
    }
  });
}

function renderAllQuestions(count) {
  const container = $("questionList");
  container.innerHTML = "";
  for (let i = 0; i < count; i++) {
    container.appendChild(renderQuestionRow(i));
  }
  $("qCount").textContent = `현재 문제: ${count}개 (최소 ${MIN_QUESTIONS}개)`;
}

function setQuestionCount(newCount) {
  const oldVals = collectQuestionValues();
  questionCount = newCount;
  renderAllQuestions(questionCount);
  restoreQuestionValues(oldVals);
}

// 초기 3개
setQuestionCount(MIN_QUESTIONS);

$("btnAddQ")?.addEventListener("click", () => {
  setQuestionCount(questionCount + 1);
});

$("btnRemoveQ")?.addEventListener("click", () => {
  if (questionCount <= MIN_QUESTIONS) {
    $("createMsg").textContent = `최소 ${MIN_QUESTIONS}개 이상이어야 합니다.`;
    return;
  }
  setQuestionCount(questionCount - 1);
});

// ===== Auth UI =====

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

// ===== 저장 =====

$("btnSaveQuiz")?.addEventListener("click", async () => {
  const msg = $("createMsg");
  msg.textContent = "";

  // ✅ 중복 클릭 방지
  if (saving) return;
  saving = true;

  try {
    // ✅ 로그인 체크
    if (!accessToken || !session?.user) {
      msg.textContent = "로그인 후 이용하세요.";
      return;
    }

    const title = $("createTitle").value.trim();
    if (!title) { msg.textContent = "제목을 입력하세요."; return; }

    const description = $("createDesc").value.trim();
    const visibility = $("createVisibility").value;
    const category = $("createCategory").value || null;

    // ✅ 문제 수집 + 유효성 검사 (네 코드 그대로)
    const questions = [];
    for (let i = 0; i < questionCount; i++) {
      const typeEl = document.querySelector(`select[data-q="${i}"][data-field="type"]`);
      const promptEl = document.querySelector(`input[data-q="${i}"][data-field="prompt"]`);
      const type = typeEl?.value || "mcq";
      const prompt = promptEl?.value.trim() || "";

      if (!prompt) {
        msg.textContent = `문제 ${i + 1}번 내용이 비어 있습니다.`;
        promptEl?.focus();
        return;
      }

      const q = { type, prompt, sortOrder: i + 1 };

      if (type === "mcq") {
        const choices = [];
        for (let ci = 0; ci < 4; ci++) {
          const el = document.querySelector(`input[data-q="${i}"][data-choice="${ci}"]`);
          choices.push(el?.value.trim() || "");
        }
        const filledChoices = choices.filter(c => c.length > 0);
        if (filledChoices.length < 2) {
          msg.textContent = `문제 ${i + 1}번: 보기를 최소 2개 입력하세요.`;
          return;
        }
        const correctIdx = document.querySelector(`input[name="q${i}_correct"]:checked`)?.value || "0";
        if (!choices[Number(correctIdx)]) {
          msg.textContent = `문제 ${i + 1}번: 정답으로 선택된 보기가 비어 있습니다.`;
          return;
        }
        q.choices = choices;

        // ✅ (추천) 정답은 숫자로 저장
        q.answer = [Number(correctIdx)];

      } else if (type === "short") {
        const answer = document.querySelector(`input[data-q="${i}"][data-field="answer"]`)?.value.trim() || "";
        if (!answer) {
          msg.textContent = `문제 ${i + 1}번: 정답을 입력하세요.`;
          return;
        }
        const synRaw = document.querySelector(`input[data-q="${i}"][data-field="synonyms"]`)?.value.trim() || "";
        const synonyms = synRaw ? synRaw.split(",").map(s => s.trim()).filter(Boolean) : [];
        q.answer = [answer, ...synonyms];

      } else if (type === "audio_youtube") {
        const ytUrl = document.querySelector(`input[data-q="${i}"][data-field="youtubeUrl"]`)?.value.trim() || "";
        if (!ytUrl) {
          msg.textContent = `문제 ${i + 1}번: 유튜브 URL을 입력하세요.`;
          return;
        }
        const startSec = parseInt(document.querySelector(`input[data-q="${i}"][data-field="startSec"]`)?.value) || 0;
        const durationSec = parseInt(document.querySelector(`input[data-q="${i}"][data-field="durationSec"]`)?.value) || 10;
        if (startSec < 0) {
          msg.textContent = `문제 ${i + 1}번: 시작(초)은 0 이상이어야 합니다.`;
          return;
        }
        if (durationSec < 1 || durationSec > 600) {
          msg.textContent = `문제 ${i + 1}번: 길이(초)는 1~600 사이여야 합니다.`;
          return;
        }
        const audioAnswer = document.querySelector(`input[data-q="${i}"][data-field="audioAnswer"]`)?.value.trim() || "";
        if (!audioAnswer) {
          msg.textContent = `문제 ${i + 1}번: 정답을 입력하세요.`;
          return;
        }
        const audioSynRaw = document.querySelector(`input[data-q="${i}"][data-field="audioSynonyms"]`)?.value.trim() || "";
        const audioSyns = audioSynRaw ? audioSynRaw.split(",").map(s => s.trim()).filter(Boolean) : [];

        q.mediaType = "youtube";
        q.mediaUrl = parseYoutubeUrl(ytUrl);
        q.startSec = startSec;
        q.durationSec = durationSec;
        q.answer = [audioAnswer, ...audioSyns];
      }

      questions.push(q);
    }

    // ✅ UI 잠금
    $("btnSaveQuiz").disabled = true;
    msg.textContent = "저장 중…";

    // ✅ 1) contents insert
    const { data: content, error: cErr } = await supabase
      .from("contents")
      .insert({
        title,
        description: description || null,
        visibility,
        mode: "quiz",
        owner_id: session.user.id,
        category,
        tags: tags.length > 0 ? tags : null,
      })
      .select("id")
      .single();

    if (cErr || !content) throw new Error(cErr?.message || "contents insert 실패");
    const contentId = content.id;

    // ✅ 2) 썸네일 업로드
    msg.textContent = "썸네일 업로드 중…";
    const thumbnailUrl = await uploadThumbnail(contentId);
    if (thumbnailUrl) {
      await supabase.from("contents").update({ thumbnail_url: thumbnailUrl }).eq("id", contentId);
    }

    // ✅ 3) quiz_questions insert
    msg.textContent = "문제 저장 중…";

    const rows = questions.map(q => {
      const isAudio = q.type === "audio_youtube";
      const startSec = isAudio && Number.isFinite(+q.startSec) && +q.startSec >= 0 ? +q.startSec : 0;
      const durationSec = isAudio && Number.isFinite(+q.durationSec) && +q.durationSec >= 1 ? +q.durationSec : 10;

      return {
        content_id: contentId,
        sort_order: q.sortOrder,
        type: q.type,
        prompt: q.prompt,
        choices: q.type === "mcq" ? q.choices : null,
        answer: q.answer,
        media_type: isAudio ? (q.mediaType || "youtube") : null,
        media_url: isAudio ? (q.mediaUrl || null) : null,
        start_sec: startSec,
        duration_sec: durationSec,
      };
    });

    const { error: qErr } = await supabase.from("quiz_questions").insert(rows);
    if (qErr) throw new Error(qErr.message || "quiz_questions insert 실패");

    // ✅ 성공
    msg.textContent = "저장 완료!";
    $("createdId").textContent = contentId;
    setHidden($("createResult"), false);
    log(`퀴즈 저장 완료: ${contentId} (문제 ${questions.length}개, 태그 ${tags.length}개)`);
  } catch (e) {
    msg.textContent = `저장 실패: ${e.message}`;
    log(`퀴즈 저장 에러: ${e.message}`);
  } finally {
    $("btnSaveQuiz").disabled = false;
    saving = false; // ✅ 무조건 해제
  }
});


// ===== 결과 버튼 =====

$("btnCopyId")?.addEventListener("click", () => {
  const id = $("createdId").textContent;
  if (!id || id === "-") return;
  navigator.clipboard.writeText(id).then(() => {
    $("btnCopyId").textContent = "복사됨!";
    setTimeout(() => { $("btnCopyId").textContent = "복사"; }, 1500);
  }).catch(() => log("클립보드 복사 실패"));
});

$("btnSoloStart")?.addEventListener("click", () => {
  const id = $("createdId").textContent;
  if (!id || id === "-") return;
  window.location.href = `play.html?solo=1&type=quiz&id=${encodeURIComponent(id)}`;
});


$("btnMultiStart")?.addEventListener("click", () => {
  const id = $("createdId").textContent;
  if (!id || id === "-") return;
  window.location.href = `room.html?mode=quiz&contentId=${encodeURIComponent(id)}`;
});

// ===== 초기화 =====

await restoreSession();
log("퀴즈 제작 페이지 준비 완료.");
