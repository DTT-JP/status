/**
 * Status Page - Frontend Application
 * データ取得・SLA計算・DOM生成・遅延読み込みロジック
 *
 * データ取得優先順位 (human-docs.md準拠):
 *   ① GitHub Pages 公開URL (最優先)
 *   ② raw.githubusercontent.com (2分以上遅延時)
 *   ③ Cloudflare R2 CDN (さらに2分以上遅延時の最終手段)
 */

// ===========================================================================
// 設定 (書き換えやすいようにファイル先頭にまとめて配置)
// ===========================================================================

/** ① GitHub Pages の公開URL (最優先) */
const PAGES_PUBLIC_URL = "https://dtt-jp.github.io/status/";

/** ② raw.githubusercontent.com のURL */
const GITHUB_RAW_URL = "https://raw.githubusercontent.com/DTT-JP/status/main/";

/** ③ Cloudflare R2 パブリック公開URL (最終手段) */
const R2_PUBLIC_URL = "https://status-r2.example.com/";

/** フォールバック判定の遅延閾値 (ミリ秒) */
const STALE_THRESHOLD_MS = 120000; // 2分

/** 自動更新間隔 (ミリ秒) */
const AUTO_REFRESH_INTERVAL = 60000; // 1分

// ===========================================================================
// アプリケーション状態
// ===========================================================================
let currentConfig = null;
let currentStatusData = null;
let currentDataSource = "--";

// ===========================================================================
// 初期化
// ===========================================================================
document.addEventListener("DOMContentLoaded", async () => {
  await initApp();
  // 自動更新
  setInterval(async () => {
    await refreshStatus();
  }, AUTO_REFRESH_INTERVAL);
});

async function initApp() {
  try {
    // config.json はローカル（同一オリジン）から取得
    const configRes = await fetch(`config.json?t=${Date.now()}`);
    currentConfig = await configRes.json();

    // ステータスデータの取得
    await refreshStatus();

    // アクティブインシデントの読み込み
    await loadActiveIncidents();

    // 過去インシデント履歴のインデックス読み込み
    await loadIncidentHistory();
  } catch (err) {
    console.error("Init failed:", err);
    showError("ステータスの読み込みに失敗しました。");
  }
}

// ===========================================================================
// データ取得 (3段階フォールバック)
// ===========================================================================

/**
 * 3段階フォールバックでJSONファイルを取得する
 * ① 公開フォルダ → ② raw.githubusercontent → ③ R2
 * @param {string} filename 取得するファイル名
 * @returns {Promise<{data: any, source: string}>}
 */
async function fetchWithFallback(filename) {
  const sources = [
    { name: "GitHub Pages", url: PAGES_PUBLIC_URL },
    { name: "raw.githubusercontent", url: GITHUB_RAW_URL },
    { name: "R2 CDN", url: R2_PUBLIC_URL },
  ];

  for (let i = 0; i < sources.length; i++) {
    const source = sources[i];
    try {
      const res = await fetch(`${source.url}${filename}?t=${Date.now()}`);
      if (!res.ok) continue;

      const data = await res.json();

      // 最後のソース（R2）は遅延チェックなしで採用
      if (i === sources.length - 1) {
        return { data, source: source.name };
      }

      // updated_at がある場合、2分以内かチェック
      if (data.updated_at) {
        const delay = Date.now() - new Date(data.updated_at).getTime();
        if (delay <= STALE_THRESHOLD_MS) {
          return { data, source: source.name };
        }
        console.warn(
          `${source.name} data is stale (delay: ${Math.round(delay / 1000)}s). Trying next source...`
        );
        continue;
      }

      // updated_at がないファイルはそのまま採用
      return { data, source: source.name };
    } catch (e) {
      console.error(`Failed to fetch from ${source.name}:`, e);
    }
  }

  // 全ソース失敗時: R2から遅延チェックなしで強制取得
  try {
    const fallbackRes = await fetch(`${R2_PUBLIC_URL}${filename}`);
    const data = await fallbackRes.json();
    return { data, source: "R2 CDN (fallback)" };
  } catch (e) {
    throw new Error(`All sources failed for ${filename}`);
  }
}

// ===========================================================================
// ステータス更新
// ===========================================================================

async function refreshStatus() {
  try {
    const { data, source } = await fetchWithFallback("status_minutely.json");
    currentStatusData = data;
    currentDataSource = source;

    hideLoading();
    renderGroups(currentConfig, currentStatusData);
    updateGlobalStatus(currentConfig, currentStatusData);
    updateMetaInfo(currentStatusData, source);
  } catch (err) {
    console.error("Status refresh failed:", err);
    hideLoading();
    showError("ステータスデータの取得に失敗しました。");
  }
}

// ===========================================================================
// SLA計算・色判定
// ===========================================================================

/**
 * 配列内の1の割合を計算してSLA(%)を返す
 */
function calculateSLA(statusArray) {
  if (!statusArray || statusArray.length === 0) return 0;
  const onlineCount = statusArray.filter((s) => s === 1).length;
  return (onlineCount / statusArray.length) * 100;
}

/**
 * SLA(%)に基づいて色クラス名を返す
 */
function getStatusColor(sla) {
  if (sla === 100) return "green";
  if (sla >= 90) return "yellow";
  return "red";
}

/**
 * 色に対応する表示テキスト
 */
function getStatusLabel(color) {
  switch (color) {
    case "green": return "稼働中";
    case "yellow": return "一部障害";
    case "red": return "停止中";
    default: return "不明";
  }
}

// ===========================================================================
// DOM描画: ステータスグループ
// ===========================================================================

function renderGroups(config, statusData) {
  if (!config || !statusData) return;

  const container = document.getElementById("groups-container");
  container.innerHTML = "";

  config.groups.forEach((group, groupIndex) => {
    let groupTotalSla = 0;

    const groupEl = document.createElement("div");
    groupEl.className = "status-group";
    groupEl.id = `group-${groupIndex}`;

    // サービス行を先に計算
    const servicesHTML = group.services
      .map((service) => {
        const history = statusData.data[service.internal_id] || [];
        const sla = calculateSLA(history);
        groupTotalSla += sla;
        const color = getStatusColor(sla);
        const label = getStatusLabel(color);

        return `
          <div class="service-item" id="service-${service.internal_id}">
            <span class="service-name">${escapeHTML(service.display_name)}</span>
            <div class="service-status-wrapper">
              <span class="service-sla">${sla.toFixed(2)}%</span>
              <span class="service-badge ${color}">${label}</span>
            </div>
          </div>`;
      })
      .join("");

    const avgSla =
      group.services.length > 0 ? groupTotalSla / group.services.length : 0;
    const groupColor = getStatusColor(avgSla);

    groupEl.innerHTML = `
      <div class="group-header" id="group-header-${groupIndex}" role="button" aria-expanded="false">
        <div class="group-header-left">
          <div class="group-color-bar ${groupColor}"></div>
          <span class="group-name">${escapeHTML(group.group_name)}</span>
        </div>
        <div class="group-header-right">
          <span class="group-sla">${avgSla.toFixed(2)}%</span>
          <span class="group-chevron">▼</span>
        </div>
      </div>
      <div class="group-services" id="group-services-${groupIndex}">
        ${servicesHTML}
      </div>`;

    // アコーディオン動作
    const header = groupEl.querySelector(".group-header");
    header.addEventListener("click", () => {
      const services = groupEl.querySelector(".group-services");
      const chevron = groupEl.querySelector(".group-chevron");
      const isOpen = services.classList.toggle("open");
      chevron.classList.toggle("open", isOpen);
      header.setAttribute("aria-expanded", isOpen.toString());
    });

    container.appendChild(groupEl);
  });
}

// ===========================================================================
// グローバルステータス更新
// ===========================================================================

function updateGlobalStatus(config, statusData) {
  if (!config || !statusData) return;

  const dot = document.getElementById("global-dot");
  const text = document.getElementById("global-status-text");

  // 全サービスのSLA平均
  let total = 0;
  let count = 0;
  config.groups.forEach((g) =>
    g.services.forEach((s) => {
      const history = statusData.data[s.internal_id] || [];
      total += calculateSLA(history);
      count++;
    })
  );
  const globalSla = count > 0 ? total / count : 0;
  const color = getStatusColor(globalSla);

  dot.className = `status-dot ${color}`;

  // オフラインサービスの検出
  const offlineServices = findOfflineServices(config, statusData);
  if (offlineServices.length > 0) {
    text.textContent = `${offlineServices.length}件のサービスに障害が発生中`;
    showOfflineAlert(offlineServices);
  } else if (color === "yellow") {
    text.textContent = "一部サービスで障害が検出されています";
  } else {
    text.textContent = "すべてのシステムは正常に稼働中";
  }
}

/**
 * 直近3分（配列先頭3つ）がすべて0なら停止中とみなす
 */
function findOfflineServices(config, statusData) {
  const offline = [];
  config.groups.forEach((group) => {
    group.services.forEach((service) => {
      const h = statusData.data[service.internal_id];
      if (h && h[0] === 0 && h[1] === 0 && h[2] === 0) {
        offline.push(service.display_name);
      }
    });
  });
  return offline;
}

function showOfflineAlert(services) {
  const section = document.getElementById("alert-section");
  const alert = document.getElementById("offline-alert");
  const list = document.getElementById("offline-services-list");

  section.style.display = "flex";
  alert.style.display = "flex";
  list.textContent = services.join("、");
}

// ===========================================================================
// インシデント
// ===========================================================================

async function loadActiveIncidents() {
  const container = document.getElementById("incident-container");
  const noIncidents = document.getElementById("no-incidents");

  try {
    const { data: incidents } = await fetchWithFallback("active_incidents.json");

    if (!Array.isArray(incidents) || incidents.length === 0) {
      noIncidents.style.display = "block";
      return;
    }

    noIncidents.style.display = "none";
    const section = document.getElementById("alert-section");
    section.style.display = "flex";

    incidents.forEach((incident) => {
      // 上部アラート表示
      const alertContainer = document.getElementById("incident-alert-container");
      const alertEl = document.createElement("div");
      alertEl.className = "alert-banner alert-incident";
      alertEl.innerHTML = `
        <div class="alert-icon">🔔</div>
        <div class="alert-body">
          <strong>${escapeHTML(incident.name)}</strong>
          <p>${escapeHTML(incident.status)} — 開始: ${formatTime(incident.started_at)}</p>
        </div>`;
      alertContainer.appendChild(alertEl);

      // 詳細セクション
      const el = document.createElement("div");
      el.className = "incident-item";
      el.id = `incident-${incident.incident_id}`;
      el.innerHTML = `
        <div class="incident-header">
          <span class="incident-name">${escapeHTML(incident.name)}</span>
          <span class="incident-status-badge ${incident.status}">${incident.status}</span>
        </div>
        <div class="incident-time">${formatTime(incident.started_at)}</div>
        <div class="incident-details" id="details-${incident.incident_id}"></div>`;

      el.addEventListener("click", async () => {
        const detailsEl = document.getElementById(`details-${incident.incident_id}`);
        if (!el.dataset.loaded) {
          try {
            const { data: detail } = await fetchWithFallback(
              `incidents/details/${incident.incident_id}.json`
            );
            renderIncidentDetails(detailsEl, detail);
            el.dataset.loaded = "true";
          } catch (e) {
            detailsEl.innerHTML = '<p style="color:var(--text-muted)">詳細の読み込みに失敗しました。</p>';
            el.dataset.loaded = "true";
          }
        }
        detailsEl.classList.toggle("open");
      });

      container.appendChild(el);
    });
  } catch (err) {
    console.warn("Active incidents load failed:", err);
  }
}

function renderIncidentDetails(container, detail) {
  if (!detail || !detail.updates || detail.updates.length === 0) {
    container.innerHTML = '<p style="color:var(--text-muted)">更新情報はありません。</p>';
    return;
  }

  container.innerHTML = detail.updates
    .map(
      (u) => `
      <div class="incident-update">
        <div class="incident-update-time">${formatTime(u.time)}</div>
        <div class="incident-update-message">${escapeHTML(u.message)}</div>
        <div class="incident-update-status" style="color:var(--color-${u.status === 'resolved' ? 'green' : u.status === 'investigating' ? 'red' : 'yellow'})">${u.status}</div>
      </div>`
    )
    .join("");
}

// ===========================================================================
// 過去インシデント履歴 (ツリー構造 / Lazy Loading)
// ===========================================================================

async function loadIncidentHistory() {
  const container = document.getElementById("history-container");

  try {
    const { data: index } = await fetchWithFallback("incidents/index.json");

    if (!index || !Array.isArray(index.years) || index.years.length === 0) {
      container.innerHTML = '<p class="no-incidents">過去のインシデントはありません。</p>';
      return;
    }

    container.innerHTML = "";

    index.years.forEach((year) => {
      const yearEl = document.createElement("div");
      yearEl.className = "history-year";
      yearEl.innerHTML = `
        <div class="history-year-header">
          <span>${year}年</span>
          <span class="group-chevron">▼</span>
        </div>
        <div class="history-children" id="history-year-${year}"></div>`;

      const yearHeader = yearEl.querySelector(".history-year-header");
      let yearLoaded = false;

      yearHeader.addEventListener("click", async () => {
        const children = yearEl.querySelector(".history-children");
        const chevron = yearEl.querySelector(".group-chevron");
        const isOpen = children.classList.toggle("open");
        chevron.classList.toggle("open", isOpen);

        if (!yearLoaded && isOpen) {
          yearLoaded = true;
          await loadYearMonths(year, children);
        }
      });

      container.appendChild(yearEl);
    });
  } catch {
    container.innerHTML = '<p class="no-incidents">過去のインシデント履歴はありません。</p>';
  }
}

async function loadYearMonths(year, container) {
  try {
    const { data: yearData } = await fetchWithFallback(`incidents/${year}/index.json`);

    if (!yearData || !Array.isArray(yearData.months) || yearData.months.length === 0) {
      container.innerHTML = '<p class="no-incidents">この年のインシデントはありません。</p>';
      return;
    }

    container.innerHTML = "";

    yearData.months.forEach((monthInfo) => {
      const monthEl = document.createElement("div");
      monthEl.className = "history-month";
      monthEl.innerHTML = `
        <div class="history-month-header">
          <span>${monthInfo.month}月</span>
          <span class="history-count">${monthInfo.total_issues || 0}件</span>
        </div>
        <div class="history-children" id="history-month-${year}-${monthInfo.month}"></div>`;

      const monthHeader = monthEl.querySelector(".history-month-header");
      let monthLoaded = false;

      monthHeader.addEventListener("click", async (e) => {
        e.stopPropagation();
        const children = monthEl.querySelector(".history-children");
        const isOpen = children.classList.toggle("open");

        if (!monthLoaded && isOpen) {
          monthLoaded = true;
          await loadMonthIncidents(year, monthInfo.month, children);
        }
      });

      container.appendChild(monthEl);
    });
  } catch {
    container.innerHTML = '<p class="no-incidents">読み込みに失敗しました。</p>';
  }
}

async function loadMonthIncidents(year, month, container) {
  const monthStr = String(month).padStart(2, "0");
  try {
    const { data: monthData } = await fetchWithFallback(`incidents/${year}/${monthStr}.json`);

    if (!monthData || !Array.isArray(monthData.days) || monthData.days.length === 0) {
      container.innerHTML = '<p class="no-incidents">この月のインシデントはありません。</p>';
      return;
    }

    container.innerHTML = monthData.days
      .map((day) => `<div class="incident-item" style="cursor:default;"><span class="incident-name">${day}</span></div>`)
      .join("");
  } catch {
    container.innerHTML = '<p class="no-incidents">読み込みに失敗しました。</p>';
  }
}

// ===========================================================================
// ユーティリティ
// ===========================================================================

function hideLoading() {
  const spinner = document.getElementById("loading-spinner");
  if (spinner) spinner.style.display = "none";
}

function showError(message) {
  const container = document.getElementById("groups-container");
  container.innerHTML = `<div class="alert-banner alert-offline"><div class="alert-icon">⚠</div><div class="alert-body"><strong>エラー</strong><p>${escapeHTML(message)}</p></div></div>`;
}

function updateMetaInfo(statusData, source) {
  const lastUpdated = document.getElementById("last-updated");
  const dataSource = document.getElementById("data-source");

  if (statusData && statusData.updated_at) {
    lastUpdated.textContent = formatTime(statusData.updated_at);
  }
  dataSource.textContent = source;
}

function formatTime(isoString) {
  if (!isoString) return "--";
  try {
    const d = new Date(isoString);
    return d.toLocaleString("ja-JP", {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
  } catch {
    return isoString;
  }
}

function escapeHTML(str) {
  if (!str) return "";
  const div = document.createElement("div");
  div.appendChild(document.createTextNode(str));
  return div.innerHTML;
}
