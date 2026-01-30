import { $, log, setHidden, SUPABASE_URL, SUPABASE_ANON_KEY } from './config.js';

// Supabase 클라이언트 (auth 불필요 — 공개 읽기 전용)
const supabase = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// ===== 상태 =====
let currentSort = "popular"; // "popular" | "recent"
let searchTimer = null;
let selectedContent = null;  // { id, type, title }

const DEFAULT_THUMB = "https://picsum.photos/seed/duo-default/600/400";

// ===== 데이터 로드 =====

async function loadPublicContents({ sort = "popular", q = "" } = {}) {
  let query = supabase
    .from("contents")
    .select("id, mode, title, description, thumbnail_url, category, tags, play_count, created_at")
    .eq("visibility", "public");

  if (q) {
    query = query.ilike("title", `%${q}%`);
  }

  if (sort === "recent") {
    query = query.order("created_at", { ascending: false });
  } else {
    query = query.order("play_count", { ascending: false })
                 .order("created_at", { ascending: false });
  }

  query = query.limit(50);

  const { data, error } = await query;
  if (error) throw error;
  return data || [];
}

// ===== 렌더링 =====

function formatDate(iso) {
  if (!iso) return "-";
  return iso.slice(0, 10);
}

function renderCards(list) {
  const grid = $("feedGrid");
  const status = $("feedStatus");

  if (!list || list.length === 0) {
    grid.innerHTML = "";
    status.textContent = "검색 결과가 없습니다.";
    setHidden(status, false);
    return;
  }

  setHidden(status, true);
  grid.innerHTML = list.map(c => {
    const thumb = c.thumbnail_url || DEFAULT_THUMB;
    const type = c.mode || "worldcup";
    const typeLabel = type === "quiz" ? "퀴즈" : "월드컵";
    const playCount = c.play_count || 0;
    const tagHtml = (c.tags || []).slice(0, 3).map(t =>
      `<span class="feed-tag">${t}</span>`
    ).join("");

    return `
      <div class="feed-card" data-id="${c.id}" data-type="${type}" data-title="${c.title.replace(/"/g, '&quot;')}">
        <div class="feed-thumb-wrap">
          <img class="feed-thumb" src="${thumb}" alt="${c.title}" loading="lazy"
               onerror="this.src='${DEFAULT_THUMB}'" />
          <span class="feed-type-badge ${type}">${typeLabel}</span>
        </div>
        <div class="feed-card-body">
          <div class="feed-card-title">${c.title}</div>
          <div class="feed-card-meta muted">
            <span>${playCount}회 플레이</span>
            <span>${formatDate(c.created_at)}</span>
          </div>
          ${tagHtml ? `<div class="feed-tags">${tagHtml}</div>` : ""}
          <button class="btn primary feed-start-btn">시작하기</button>
        </div>
      </div>`;
  }).join("");

  // 시작하기 버튼 이벤트
  grid.querySelectorAll(".feed-start-btn").forEach(btn => {
    btn.addEventListener("click", (e) => {
      const card = e.target.closest(".feed-card");
      openStartModal({
        id: card.dataset.id,
        type: card.dataset.type,
        title: card.dataset.title,
      });
    });
  });
}

// ===== 검색/정렬 =====

async function refreshFeed() {
  const q = $("searchInput")?.value.trim() || "";
  const status = $("feedStatus");
  status.textContent = "로딩 중…";
  setHidden(status, false);
  $("feedGrid").innerHTML = "";

  try {
    const list = await loadPublicContents({ sort: currentSort, q });
    renderCards(list);
  } catch (err) {
    status.textContent = `데이터 로드 실패: ${err.message}`;
    setHidden(status, false);
    console.error("[홈 피드 에러]", err);
  }
}

function setSort(sort) {
  currentSort = sort;
  $("sortPopular").classList.toggle("active", sort === "popular");
  $("sortRecent").classList.toggle("active", sort === "recent");
  refreshFeed();
}

$("sortPopular")?.addEventListener("click", () => setSort("popular"));
$("sortRecent")?.addEventListener("click", () => setSort("recent"));

$("searchInput")?.addEventListener("input", () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => refreshFeed(), 350);
});

// ===== 모달 =====

function openStartModal(content) {
  selectedContent = content;
  $("modalContentTitle").textContent = content.title;
  setHidden($("startModal"), false);
  document.body.style.overflow = "hidden";
}

function closeStartModal() {
  selectedContent = null;
  setHidden($("startModal"), true);
  document.body.style.overflow = "";
}

$("modalClose")?.addEventListener("click", closeStartModal);

$("startModal")?.addEventListener("click", (e) => {
  if (e.target === $("startModal")) closeStartModal();
});

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && selectedContent) closeStartModal();
});

// 솔로
$("btnSolo")?.addEventListener("click", () => {
  if (!selectedContent) return;
  const { id, type } = selectedContent;
  closeStartModal();
  window.location.href = `play.html?solo=1&contentId=${encodeURIComponent(id)}&mode=${encodeURIComponent(type)}`;
});

// 멀티
$("btnMulti")?.addEventListener("click", () => {
  if (!selectedContent) return;
  const { id, type } = selectedContent;
  closeStartModal();
  window.location.href = `room.html?contentId=${encodeURIComponent(id)}&mode=${encodeURIComponent(type)}`;
});

// ===== 초기화 =====

refreshFeed();
log("홈 페이지 준비 완료.");
