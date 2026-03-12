'use strict';
/* ============================================================
   红人视频统计看板 – app.js
   多工作表 · 多维度筛选 · YouTube 自动获取 · 回填导出
   ============================================================ */

// ============ COLUMN KEYWORD MAP ============
const COL_KMAP = {
  url:          ['上线链接', '链接', 'url', 'link', 'video link', 'videolink'],
  name:         ['频道名', '频道', 'channel', 'kol名', 'kol', '达人名', '达人'],
  responsible:  ['负责人', '负责', 'owner', 'responsible'],
  product:      ['产品', 'product', '品牌', 'brand'],
  platform:     ['平台', 'platform'],
  country:      ['国家', '地区', 'country', 'region', '市场'],
  month:        ['上线月份', '月份', 'month', '上线月'],
  views:        ['播放量', '播放', 'views', 'view count', 'view_count'],
  likes:        ['点赞量', '点赞数', '点赞', 'likes', 'like count', 'like_count'],
  comments_col: ['评论数', '评论', 'comments', 'comment count', 'comment_count'],
};

// ============ STOP WORDS ============
const STOP_WORDS = new Set([
  'the','a','an','is','it','this','that','in','on','at','to','of','and','or',
  'for','with','as','by','from','be','was','are','were','been','has','have',
  'had','do','does','did','but','not','no','so','if','my','me','i','we','you',
  'he','she','they','just','its','your','their','our','his','her',
  '我','的','了','是','在','有','和','就','不','人','都','一','这','中','大',
  '来','上','国','个','到','说','们','为','子','那','里','以','可','从','好',
]);

// ============ CHART COLORS ============
const COLORS = [
  '#6366f1','#f59e0b','#10b981','#ef4444','#3b82f6','#8b5cf6',
  '#ec4899','#14b8a6','#f97316','#84cc16','#06b6d4','#a855f7',
  '#64748b','#0ea5e9','#d946ef','#22c55e',
];
function cc(i, alpha) { return COLORS[i % COLORS.length] + (alpha || 'dd'); }

// ============ STATE ============
const state = {
  workbook:     null,
  fileName:     '',
  activeSheet:  '',
  colMap:       {},
  headerRowIdx: 0,
  sheetRawData: [],
  allRows:      [],
  filteredRows: [],
  fetchedMap:   {},
  filters:      { responsible: '', product: '', platform: '', country: '', month: '' },
  sortBy:       null,
  sortDir:      'desc',
  searchQ:      '',
  charts:       {},
  isFetching:   false,
};

// ============ UTIL ============
function fmtNum(n) {
  if (n == null || n === '' || isNaN(+n)) return '—';
  n = Number(n);
  if (n >= 1e8) return (n / 1e8).toFixed(1) + '亿';
  if (n >= 1e4) return (n / 1e4).toFixed(1) + '万';
  return n.toLocaleString();
}
function fmtPct(v) {
  if (v == null || isNaN(v)) return '—';
  return (v * 100).toFixed(2) + '%';
}
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function escHtml(s) {
  return String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;')
    .replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
// 规范化链接：去空白、解码，便于识别平台
function normUrl(url) {
  if (typeof url !== 'string') return '';
  let u = url.trim().replace(/\s+/g, '');
  try {
    for (let i = 0; i < 3; i++) { u = decodeURIComponent(u); }
  } catch (_) {}
  return u;
}
function isYouTubeUrl(url) {
  const u = normUrl(url).toLowerCase();
  if (!u) return false;
  if (u.includes('youtube.com') || u.includes('youtu.be')) return true;
  return /youtube\.com|youtu\.be/.test(u);
}
function isTikTokUrl(url) {
  const u = normUrl(url).toLowerCase();
  return /tiktok\.com|vm\.tiktok\.com|vt\.tiktok\.com/.test(u);
}
function isInstagramUrl(url) {
  const u = normUrl(url).toLowerCase();
  return /instagram\.com|instagr\.am/.test(u);
}
function isFacebookUrl(url) {
  const u = normUrl(url).toLowerCase();
  return /facebook\.com|fb\.watch|fb\.com|fb\.me/.test(u);
}
function getPlatform(url) {
  if (isYouTubeUrl(url)) return 'youtube';
  if (isTikTokUrl(url)) return 'tiktok';
  if (isInstagramUrl(url)) return 'instagram';
  if (isFacebookUrl(url)) return 'facebook';
  return null;
}
function getApiKey() { return localStorage.getItem('youtube_api_key') || ''; }
function getMetaToken() { return localStorage.getItem('meta_token') || ''; }

// ============ COLUMN DETECTION ============
function findHeaderRow(rows) {
  for (let i = 0; i < Math.min(10, rows.length); i++) {
    let score = 0;
    for (const cell of rows[i]) {
      const h = String(cell ?? '').toLowerCase();
      if (h.includes('链接') || h.includes('url'))            score += 3;
      if (h.includes('负责人'))                                score += 2;
      if (h.includes('产品') || h.includes('product'))        score += 2;
      if (h.includes('平台') || h.includes('platform'))       score += 2;
      if (h.includes('国家') || h.includes('country'))        score += 2;
      if (h.includes('月份') || h.includes('month'))          score += 2;
      if (h.includes('播放') || h.includes('view'))           score += 2;
    }
    if (score >= 4) return i;
  }
  return 0;
}

function detectColumns(headerArr) {
  const map = {};
  headerArr.forEach((cell, ci) => {
    const h = String(cell ?? '').toLowerCase().trim();
    if (!h) return;
    for (const [field, keywords] of Object.entries(COL_KMAP)) {
      if (map[field] !== undefined) continue;
      for (const kw of keywords) {
        if (h.includes(kw.toLowerCase())) { map[field] = ci; break; }
      }
    }
  });
  return map;
}

// ============ PARSE SHEET ============
function parseSheet(sheetName) {
  if (!state.workbook) return;
  const ws = state.workbook.Sheets[sheetName];
  if (!ws) return;

  const raw = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });
  state.sheetRawData = raw;

  const hIdx = findHeaderRow(raw);
  state.headerRowIdx = hIdx;
  state.colMap = detectColumns(raw[hIdx] || []);

  const { url, name, responsible, product, platform, country, month,
          views, likes, comments_col } = state.colMap;

  state.allRows = [];
  for (let i = hIdx + 1; i < raw.length; i++) {
    const row = raw[i];
    const urlVal = normUrl(row[url]);
    if (!urlVal) continue;
    const fetchPlatform = getPlatform(urlVal);
    state.allRows.push({
      _rawIdx:       i,
      url:           urlVal,
      name:          String(row[name]        ?? '').trim(),
      responsible:   String(row[responsible] ?? '').trim(),
      product:       String(row[product]     ?? '').trim(),
      platform:      String(row[platform]    ?? '').trim(),
      country:       String(row[country]     ?? '').trim(),
      month:         String(row[month]       ?? '').trim(),
      views:         Number(row[views])      || 0,
      likes:         Number(row[likes])      || 0,
      comments:      Number(row[comments_col]) || 0,
      isYoutube:    isYouTubeUrl(urlVal),
      fetchPlatform, // 'youtube'|'tiktok'|'instagram'|'facebook'|null，用于自动获取数据
    });
  }
}

// ============ EFFECTIVE DATA (Excel + fetched merged) ============
function eff(row) {
  const f = state.fetchedMap[row.url];
  if (f && !f._error) {
    return { views: f.views || 0, likes: f.likes || 0, comments: f.comments_count || 0,
             title: f.title || row.name, thumbnail: f.thumbnail || '',
             hasFetched: true, fetchErr: null };
  }
  if (f && f._error) {
    return { views: row.views, likes: row.likes, comments: row.comments,
             title: row.name, thumbnail: '', hasFetched: true, fetchErr: f._error };
  }
  return { views: row.views, likes: row.likes, comments: row.comments,
           title: row.name, thumbnail: '', hasFetched: false, fetchErr: null };
}

// ============ FILTER ============
function applyFilters() {
  const { responsible, product, platform, country, month } = state.filters;
  const q = state.searchQ.toLowerCase();
  state.filteredRows = state.allRows.filter(r => {
    if (responsible && r.responsible !== responsible) return false;
    if (product    && r.product     !== product)     return false;
    if (platform   && r.platform    !== platform)    return false;
    if (country    && r.country     !== country)     return false;
    if (month      && r.month       !== month)       return false;
    if (q) {
      const s = (r.name + r.responsible + r.product + r.platform + r.country + r.url).toLowerCase();
      if (!s.includes(q)) return false;
    }
    return true;
  });
}

function populateFilterOptions() {
  const dims = ['responsible', 'product', 'platform', 'country', 'month'];
  const ids  = ['filterResponsible','filterProduct','filterPlatform','filterCountry','filterMonth'];
  dims.forEach((dim, di) => {
    const sel = document.getElementById(ids[di]);
    const cur = sel.value;
    const vals = [...new Set(state.allRows.map(r => r[dim]).filter(v => v))].sort((a, b) => {
      if (dim === 'month') {
        const na = parseInt(a); const nb = parseInt(b);
        if (!isNaN(na) && !isNaN(nb)) return na - nb;
      }
      return String(a).localeCompare(String(b), 'zh-CN');
    });
    sel.innerHTML = '<option value="">全部</option>' +
      vals.map(v => `<option value="${escHtml(v)}"${v === cur ? ' selected' : ''}>${escHtml(v)}</option>`).join('');
  });
}

// ============ STATS ============
function updateStats() {
  const rows = state.filteredRows;
  let totalViews = 0, totalLikes = 0, totalComments = 0;
  rows.forEach(r => {
    const d = eff(r);
    totalViews    += d.views    || 0;
    totalLikes    += d.likes    || 0;
    totalComments += d.comments || 0;
  });
  const engRate = totalViews > 0 ? (totalLikes + totalComments) / totalViews : 0;

  document.getElementById('totalVideos').textContent    = rows.length.toLocaleString();
  document.getElementById('totalViews').textContent     = fmtNum(totalViews);
  document.getElementById('totalComments').textContent  = fmtNum(totalComments);
  document.getElementById('totalLikes').textContent     = fmtNum(totalLikes);
  document.getElementById('engagementRate').textContent = fmtPct(engRate);
}

// ============ CHART HELPERS ============
function destroyChart(id) {
  if (state.charts[id]) { state.charts[id].destroy(); delete state.charts[id]; }
}
const SCALE_GRID = { color: '#f1f5f9' };
const BASE_OPTS  = { animation: { duration: 250 }, plugins: { legend: { display: false } } };

// ============ CHART 1: VIEWS RANKING ============
function renderViewsChart() {
  destroyChart('views');
  const top = parseInt(document.getElementById('viewsChartTop').value) || 10;
  const rows = [...state.filteredRows]
    .map(r => ({ r, v: eff(r).views || 0 }))
    .filter(x => x.v > 0)
    .sort((a, b) => b.v - a.v)
    .slice(0, top === 999 ? undefined : top);

  const box = document.getElementById('viewsChartBox');
  box.style.minHeight = Math.max(280, rows.length * 34) + 'px';

  const ctx = document.getElementById('viewsChart').getContext('2d');
  state.charts.views = new Chart(ctx, {
    type: 'bar',
    data: {
      labels: rows.map(x => x.r.name || x.r.url.slice(-24)),
      datasets: [{ label: '播放量', data: rows.map(x => x.v),
        backgroundColor: '#6366f1cc', borderColor: '#6366f1',
        borderWidth: 1, borderRadius: 4 }],
    },
    options: { indexAxis: 'y', responsive: true, maintainAspectRatio: false, ...BASE_OPTS,
      scales: { x: { ticks: { callback: v => fmtNum(v) }, grid: SCALE_GRID },
                y: { ticks: { font: { size: 11 } } } } },
  });
}

// ============ CHART 2: RESPONSIBLE PERSON ============
function renderRespChart() {
  destroyChart('resp');
  const metric = document.getElementById('respMetric').value;
  const map = {};
  state.filteredRows.forEach(r => {
    const k = r.responsible || '未知';
    if (!map[k]) map[k] = { count: 0, views: 0 };
    map[k].count++;
    map[k].views += eff(r).views || 0;
  });
  const entries = Object.entries(map).sort((a, b) => b[1][metric] - a[1][metric]);
  const ctx = document.getElementById('respChart').getContext('2d');
  state.charts.resp = new Chart(ctx, {
    type: 'bar',
    data: {
      labels: entries.map(e => e[0]),
      datasets: [{ label: metric === 'count' ? '视频数' : '播放量',
        data: entries.map(e => e[1][metric]),
        backgroundColor: entries.map((_, i) => cc(i)),
        borderColor: entries.map((_, i) => COLORS[i % COLORS.length]),
        borderWidth: 1, borderRadius: 4 }],
    },
    options: { responsive: true, maintainAspectRatio: false, ...BASE_OPTS,
      scales: { y: { ticks: { callback: v => metric === 'views' ? fmtNum(v) : v }, grid: SCALE_GRID },
                x: { ticks: { font: { size: 11 } } } } },
  });
}

// ============ CHART 3: PRODUCT DISTRIBUTION ============
function renderProductChart() {
  destroyChart('product');
  const map = {};
  state.filteredRows.forEach(r => { const k = r.product || '未知'; map[k] = (map[k] || 0) + 1; });
  const entries = Object.entries(map).sort((a, b) => b[1] - a[1]);
  const ctx = document.getElementById('productChart').getContext('2d');
  state.charts.product = new Chart(ctx, {
    type: 'doughnut',
    data: { labels: entries.map(e => e[0]),
      datasets: [{ data: entries.map(e => e[1]),
        backgroundColor: entries.map((_, i) => cc(i)),
        borderColor: '#fff', borderWidth: 2 }] },
    options: { responsive: true, maintainAspectRatio: false, animation: { duration: 250 },
      plugins: { legend: { position: 'right', labels: { font: { size: 11 }, boxWidth: 12 } } } },
  });
}

// ============ CHART 4: PLATFORM DISTRIBUTION ============
function renderPlatformChart() {
  destroyChart('platform');
  const map = {};
  state.filteredRows.forEach(r => { const k = r.platform || '未知'; map[k] = (map[k] || 0) + 1; });
  const entries = Object.entries(map).sort((a, b) => b[1] - a[1]);
  const platColor = k => {
    const l = String(k).toLowerCase();
    if (l.includes('youtube'))   return '#ff000099';
    if (l.includes('instagram')) return '#e1306c99';
    if (l.includes('tiktok'))    return '#69c9d099';
    if (l.includes('facebook'))  return '#1877f299';
    return cc(entries.findIndex(e => e[0] === k));
  };
  const ctx = document.getElementById('platformChart').getContext('2d');
  state.charts.platform = new Chart(ctx, {
    type: 'doughnut',
    data: { labels: entries.map(e => e[0]),
      datasets: [{ data: entries.map(e => e[1]),
        backgroundColor: entries.map(e => platColor(e[0])),
        borderColor: '#fff', borderWidth: 2 }] },
    options: { responsive: true, maintainAspectRatio: false, animation: { duration: 250 },
      plugins: { legend: { position: 'right', labels: { font: { size: 11 }, boxWidth: 12 } } } },
  });
}

// ============ CHART 5: MONTH TREND ============
function renderMonthChart() {
  destroyChart('month');
  const MO = ['1月','2月','3月','4月','5月','6月','7月','8月','9月','10月','11月','12月'];
  const map = {};
  state.filteredRows.forEach(r => {
    const k = r.month || '未知';
    if (!map[k]) map[k] = { count: 0 };
    map[k].count++;
  });
  const keys = Object.keys(map).sort((a, b) => {
    const ia = MO.indexOf(a); const ib = MO.indexOf(b);
    if (ia === -1 && ib === -1) return a.localeCompare(b);
    if (ia === -1) return 1; if (ib === -1) return -1;
    return ia - ib;
  });
  const ctx = document.getElementById('monthChart').getContext('2d');
  state.charts.month = new Chart(ctx, {
    type: 'bar',
    data: { labels: keys,
      datasets: [{ label: '视频数', data: keys.map(k => map[k].count),
        backgroundColor: '#6366f1cc', borderColor: '#6366f1',
        borderWidth: 1, borderRadius: 4 }] },
    options: { responsive: true, maintainAspectRatio: false, ...BASE_OPTS,
      scales: { y: { grid: SCALE_GRID, ticks: { precision: 0 } },
                x: { grid: { display: false } } } },
  });
}

// ============ CHART 6: COUNTRY ============
function renderCountryChart() {
  destroyChart('country');
  const metric = document.getElementById('countryMetric').value;
  const map = {};
  state.filteredRows.forEach(r => {
    const k = r.country || '未知';
    if (!map[k]) map[k] = { count: 0, views: 0 };
    map[k].count++;
    map[k].views += eff(r).views || 0;
  });
  const entries = Object.entries(map).sort((a, b) => b[1][metric] - a[1][metric]).slice(0, 15);
  const ctx = document.getElementById('countryChart').getContext('2d');
  state.charts.country = new Chart(ctx, {
    type: 'bar',
    data: { labels: entries.map(e => e[0]),
      datasets: [{ label: metric === 'count' ? '视频数' : '播放量',
        data: entries.map(e => e[1][metric]),
        backgroundColor: entries.map((_, i) => cc(i, 'cc')),
        borderColor: entries.map((_, i) => COLORS[i % COLORS.length]),
        borderWidth: 1, borderRadius: 4 }] },
    options: { responsive: true, maintainAspectRatio: false, ...BASE_OPTS,
      scales: { y: { ticks: { callback: v => metric === 'views' ? fmtNum(v) : v }, grid: SCALE_GRID },
                x: { ticks: { font: { size: 11 } } } } },
  });
}

// ============ TABLE ============
function renderTable() {
  const MO = ['1月','2月','3月','4月','5月','6月','7月','8月','9月','10月','11月','12月'];
  const rows = [...state.filteredRows];

  if (state.sortBy) {
    rows.sort((a, b) => {
      let av = 0, bv = 0;
      if (state.sortBy === 'views')          { av = eff(a).views;    bv = eff(b).views; }
      else if (state.sortBy === 'likes')     { av = eff(a).likes;    bv = eff(b).likes; }
      else if (state.sortBy === 'comments_count') { av = eff(a).comments; bv = eff(b).comments; }
      else if (state.sortBy === 'month') {
        av = MO.indexOf(a.month); if (av === -1) av = 99;
        bv = MO.indexOf(b.month); if (bv === -1) bv = 99;
      }
      return state.sortDir === 'asc' ? av - bv : bv - av;
    });
  }

  const tbody = document.getElementById('tableBody');
  if (rows.length === 0) {
    tbody.innerHTML = '<tr><td colspan="13" style="text-align:center;padding:40px;color:var(--text-3)">暂无数据，请检查筛选条件</td></tr>';
    return;
  }

  tbody.innerHTML = rows.map((r, idx) => {
    const d = eff(r);
    const engRate = d.views > 0 ? (d.likes + d.comments) / d.views : 0;
    const engPct  = (engRate * 100).toFixed(2);
    const engBarW = Math.min(100, engRate * 5000);

    let statusBadge;
    if (r.fetchPlatform) {
      if (!d.hasFetched) {
        statusBadge = `<span class="status-badge badge-gray">待获取</span>`;
      } else if (d.fetchErr) {
        statusBadge = `<span class="status-badge status-err" title="${escHtml(d.fetchErr)}">✗ 失败</span>`;
      } else {
        // 区分完整获取 / 部分获取 / 无有效数据
        const f = state.fetchedMap[r.url];
        const hasViews      = f && (f.views > 0);
        const hasEngagement = f && (f.likes > 0 || f.comments_count > 0);
        if (hasViews) {
          statusBadge = `<span class="status-badge status-ok">✓ 已获取</span>`;
        } else if (hasEngagement) {
          statusBadge = `<span class="status-badge status-partial" title="仅获取到互动数据（点赞/评论），播放量平台不对外开放">◑ 仅互动数</span>`;
        } else {
          statusBadge = `<span class="status-badge status-nodata" title="未获取到有效数据，可能需要授权或该平台不支持">— 无数据</span>`;
        }
      }
    } else {
      statusBadge = `<span class="status-badge badge-gray">${escHtml(r.platform || '—')}</span>`;
    }

    const platStyle = (() => {
      const k = String(r.platform || '').toLowerCase();
      if (k.includes('youtube'))   return 'background:#fee2e2;color:#dc2626';
      if (k.includes('instagram')) return 'background:#fce7f3;color:#be185d';
      if (k.includes('tiktok'))    return 'background:#f0fdf4;color:#166534';
      return 'background:#f1f5f9;color:#64748b';
    })();

    const thumb = d.thumbnail
      ? `<img class="video-thumb" src="${escHtml(d.thumbnail)}" loading="lazy" onerror="this.style.display='none'" />`
      : `<div class="video-thumb-placeholder">▶</div>`;

    return `<tr>
      <td style="color:var(--text-3);font-size:12px">${idx + 1}</td>
      <td><div class="cell-video">${thumb}
        <a class="video-title-link" href="${escHtml(r.url)}" target="_blank" rel="noopener"
           title="${escHtml(d.title)}">${escHtml(d.title || r.name || r.url)}</a>
      </div></td>
      <td>${escHtml(r.responsible || '—')}</td>
      <td>${escHtml(r.product || '—')}</td>
      <td><span class="platform-badge" style="${platStyle}">${escHtml(r.platform || '—')}</span></td>
      <td>${escHtml(r.country || '—')}</td>
      <td>${escHtml(r.month || '—')}</td>
      <td class="num-highlight">${fmtNum(d.views)}</td>
      <td class="num-highlight">${fmtNum(d.likes)}</td>
      <td class="num-highlight">${fmtNum(d.comments)}</td>
      <td><div class="engagement-bar-wrap">
        <div class="engagement-bar"><div class="engagement-bar-fill" style="width:${engBarW}%"></div></div>
        <span style="font-size:12px;color:var(--text-2)">${engPct}%</span>
      </div></td>
      <td><a href="${escHtml(r.url)}" target="_blank" rel="noopener" class="template-link" style="font-size:12px">↗</a></td>
      <td>${statusBadge}</td>
    </tr>`;
  }).join('');
}

// ============ FULL DASHBOARD REFRESH ============
function refreshDashboard() {
  applyFilters();
  updateStats();
  renderViewsChart();
  renderRespChart();
  renderProductChart();
  renderPlatformChart();
  renderMonthChart();
  renderCountryChart();
  renderTable();
}

// ============ LOAD SHEET ============
function loadSheet(sheetName) {
  state.activeSheet = sheetName;
  state.fetchedMap  = {};
  state.filters     = { responsible: '', product: '', platform: '', country: '', month: '' };
  state.searchQ     = '';
  state.sortBy      = null;

  parseSheet(sheetName);
  populateFilterOptions();

  ['filterResponsible','filterProduct','filterPlatform','filterCountry','filterMonth']
    .forEach(id => { document.getElementById(id).value = ''; });
  if (document.getElementById('tableSearch'))
    document.getElementById('tableSearch').value = '';

  document.getElementById('rowCount').textContent    = state.allRows.length + ' 条记录';
  document.getElementById('exportBtn').style.display = 'none';
  document.getElementById('filterBar').style.display = '';
  document.getElementById('dashboard').style.display = '';

  refreshDashboard();
}

// ============ FILE UPLOAD ============
function handleFile(file) {
  if (!file) return;
  const reader = new FileReader();
  reader.onload = e => {
    try {
      state.workbook = XLSX.read(e.target.result, { type: 'array', cellDates: true });
      state.fileName  = file.name;

      document.getElementById('fileNameBadge').textContent   = file.name;
      document.getElementById('resetBtn').style.display      = '';
      document.getElementById('uploadSection').style.display = 'none';

      const sheetSel = document.getElementById('sheetSelect');
      sheetSel.innerHTML = state.workbook.SheetNames
        .map(n => `<option value="${escHtml(n)}">${escHtml(n)}</option>`).join('');

      // Prefer latest-year sheet with "上线链接"
      const preferred =
        state.workbook.SheetNames.find(n => n.includes('上线链接') && n.includes('2026')) ||
        state.workbook.SheetNames.find(n => n.includes('上线链接')) ||
        state.workbook.SheetNames.find(n => n.includes('2026')) ||
        state.workbook.SheetNames[0];
      sheetSel.value = preferred;

      loadSheet(preferred);
    } catch (err) {
      alert('文件解析失败：' + err.message);
    }
  };
  reader.readAsArrayBuffer(file);
}

// ============ FETCH VIDEO DATA（多平台） ============
// YouTube：批量 API（50 个 / 次），大幅节省配额
// TikTok：服务端爬取（受 TikTok Bot 检测影响，成功率不稳定）
// Instagram / Facebook：oEmbed 只能取标题/封面，播放/点赞/评论数需创作者自行提供
async function fetchVideoData() {
  const rowsToFetch = state.allRows.filter(r => r.fetchPlatform);
  if (rowsToFetch.length === 0) {
    alert('当前工作表中没有可自动获取的链接（YouTube / TikTok / Instagram / Facebook）');
    return;
  }
  const apiKey      = getApiKey();
  const needsYT     = rowsToFetch.some(r => r.fetchPlatform === 'youtube');
  if (needsYT && !apiKey) {
    document.getElementById('settingsModal').style.display = 'flex';
    return;
  }

  state.isFetching = true;
  document.getElementById('fetchBtn').disabled           = true;
  document.getElementById('progressSection').style.display = '';
  document.getElementById('progressLog').innerHTML       = '';

  const ytRows    = rowsToFetch.filter(r => r.fetchPlatform === 'youtube');
  const otherRows = rowsToFetch.filter(r => r.fetchPlatform !== 'youtube');
  const total     = rowsToFetch.length;
  let   done      = 0;
  const metaToken = getMetaToken();

  const EMPTY = { views: 0, likes: 0, comments_count: 0, recent_comments: [] };

  function addLog(msg, type) {
    const el = document.getElementById('progressLog');
    const d  = document.createElement('div');
    d.className = 'log-item';
    d.innerHTML = `<span class="log-dot ${type}"></span><span>${escHtml(msg)}</span>`;
    el.prepend(d);
  }
  function setProgress(n) {
    document.getElementById('progressCount').textContent = `${n} / ${total}`;
    document.getElementById('progressFill').style.width  = (n / total * 100) + '%';
    document.getElementById('progressSub').textContent   = `已完成 ${n} 个，共 ${total} 个`;
  }
  setProgress(0);

  // ─── YouTube：批量请求（每批 50 个，只需 ceil(N/50) 次 API 调用）───
  if (ytRows.length > 0) {
    const BATCH = 50;
    const nBatch = Math.ceil(ytRows.length / BATCH);
    addLog(`YouTube 共 ${ytRows.length} 个视频，分 ${nBatch} 批获取（批量模式，节省配额）`, 'loading');

    for (let b = 0; b < ytRows.length; b += BATCH) {
      const batch = ytRows.slice(b, b + BATCH);
      addLog(`第 ${Math.floor(b / BATCH) + 1} / ${nBatch} 批（${batch.length} 个）请求中…`, 'loading');
      try {
        const resp = await fetch('/api/batch-youtube', {
          method:  'POST',
          headers: { 'Content-Type': 'application/json' },
          body:    JSON.stringify({ urls: batch.map(r => r.url), youtube_key: apiKey }),
        });
        const data = await resp.json();

        if (data.success && data.results) {
          for (const row of batch) {
            const r = data.results[row.url];
            if (r && r.success !== false) {
              state.fetchedMap[row.url] = r;
              addLog(`✓ ${row.name || r.title}  播放: ${fmtNum(r.views)}  点赞: ${fmtNum(r.likes)}`, 'success');
            } else {
              const errMsg = r?._error || '未知错误';
              state.fetchedMap[row.url] = { _error: errMsg, ...EMPTY };
              addLog(`✗ ${row.name || row.url}: ${errMsg}`, 'error');
            }
            done++; setProgress(done);
          }
        } else {
          // 整批失败（如配额耗尽）
          const errMsg = data.error || 'API 请求失败';
          addLog(`✗ 批次失败：${errMsg}`, 'error');
          for (const row of batch) {
            state.fetchedMap[row.url] = { _error: errMsg, ...EMPTY };
            done++; setProgress(done);
          }
        }
      } catch (err) {
        addLog(`✗ 网络错误：${err.message}`, 'error');
        for (const row of batch) {
          state.fetchedMap[row.url] = { _error: err.message, ...EMPTY };
          done++; setProgress(done);
        }
      }
      if (b + BATCH < ytRows.length) await sleep(400);
    }
  }

  // ─── 其他平台：逐条请求 ───
  for (const row of otherRows) {
    const platMap  = { tiktok: 'TikTok', instagram: 'Instagram', facebook: 'Facebook' };
    const platLabel = platMap[row.fetchPlatform] || row.fetchPlatform;

    addLog(`[${platLabel}] 获取: ${row.name || row.url}`, 'loading');

    const params = new URLSearchParams({ url: row.url });
    if (apiKey)    params.set('youtube_key', apiKey);
    if (metaToken) params.set('meta_token', metaToken);

    try {
      const res  = await fetch(`/api/video-info?${params.toString()}`);
      const data = await res.json();
      if (data.success) {
        state.fetchedMap[row.url] = data;
        const viewsStr = data.views ? `  播放: ${fmtNum(data.views)}` : '（播放量不可获取）';
        addLog(`✓ [${platLabel}] ${row.name || data.title}${viewsStr}`, 'success');
      } else {
        state.fetchedMap[row.url] = { _error: data.error, ...EMPTY };
        addLog(`✗ [${platLabel}] ${row.name || row.url}: ${data.error}`, 'error');
      }
    } catch (err) {
      state.fetchedMap[row.url] = { _error: err.message, ...EMPTY };
      addLog(`✗ [${platLabel}] ${row.name || row.url}: 网络错误`, 'error');
    }
    done++; setProgress(done);
    if (done < total) await sleep(800);
  }

  state.isFetching = false;
  document.getElementById('fetchBtn').disabled       = false;
  document.getElementById('exportBtn').style.display = '';
  refreshDashboard();
}

// ============ EXPORT – write back into original workbook ============
function exportFilledWorkbook() {
  if (!state.workbook) return;

  const ws = state.workbook.Sheets[state.activeSheet];
  const { views: viewsC, likes: likesC, comments_col: commentsC } = state.colMap;

  let filled = 0;
  state.allRows.forEach(row => {
    const f = state.fetchedMap[row.url];
    if (!f || f._error) return;
    const r = row._rawIdx;
    const put = (c, val) => {
      if (c === undefined) return;
      ws[XLSX.utils.encode_cell({ r, c })] = { t: 'n', v: val };
    };
    put(viewsC,    f.views         || 0);
    put(likesC,    f.likes         || 0);
    put(commentsC, f.comments_count || 0);
    filled++;
  });

  if (filled === 0) {
    alert('没有已获取的数据可填充，请先点击「获取 YouTube 数据」');
    return;
  }

  const out  = XLSX.write(state.workbook, { bookType: 'xlsx', type: 'array' });
  const blob = new Blob([out], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href     = url;
  a.download = state.fileName.replace(/\.[^.]+$/, '') + '_已填充.xlsx';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// ============ SETTINGS MODAL ============
function initSettings() {
  const k = getApiKey();
  if (k) document.getElementById('youtubeApiKey').value = k;
  const mt = getMetaToken();
  const metaInput = document.getElementById('metaToken');
  if (metaInput) metaInput.value = mt || '';

  const closeModal = () => { document.getElementById('settingsModal').style.display = 'none'; };

  document.getElementById('settingsBtn').addEventListener('click', () => {
    document.getElementById('youtubeApiKey').value = getApiKey();
    if (metaInput) metaInput.value = getMetaToken() || '';
    document.getElementById('settingsModal').style.display = 'flex';
  });
  document.getElementById('settingsClose').addEventListener('click', closeModal);
  document.getElementById('settingsCancel').addEventListener('click', closeModal);
  document.getElementById('settingsModal').addEventListener('click', e => {
    if (e.target === document.getElementById('settingsModal')) closeModal();
  });
  document.getElementById('settingsSave').addEventListener('click', () => {
    const v = document.getElementById('youtubeApiKey').value.trim();
    if (v) localStorage.setItem('youtube_api_key', v);
    const metaVal = metaInput ? document.getElementById('metaToken').value.trim() : '';
    if (metaVal) localStorage.setItem('meta_token', metaVal);
    else localStorage.removeItem('meta_token');
    closeModal();
  });
}

// ============ INIT ============
document.addEventListener('DOMContentLoaded', () => {
  initSettings();

  // Upload
  const zone  = document.getElementById('uploadZone');
  const input = document.getElementById('fileInput');

  document.getElementById('uploadClick').addEventListener('click', e => {
    e.stopPropagation(); input.click();
  });
  zone.addEventListener('click', () => input.click());
  input.addEventListener('change', () => { if (input.files[0]) handleFile(input.files[0]); });
  zone.addEventListener('dragover', e => { e.preventDefault(); zone.classList.add('drag-over'); });
  zone.addEventListener('dragleave', () => zone.classList.remove('drag-over'));
  zone.addEventListener('drop', e => {
    e.preventDefault(); zone.classList.remove('drag-over');
    handleFile(e.dataTransfer.files[0]);
  });

  // Reset / re-upload
  document.getElementById('resetBtn').addEventListener('click', () => {
    Object.values(state.charts).forEach(c => c.destroy());
    Object.assign(state, {
      workbook: null, fileName: '', activeSheet: '', colMap: {},
      sheetRawData: [], allRows: [], filteredRows: [], fetchedMap: {},
      filters: { responsible: '', product: '', platform: '', country: '', month: '' },
      sortBy: null, sortDir: 'desc', searchQ: '', charts: {}, isFetching: false,
    });
    ['uploadSection'].forEach(id => { document.getElementById(id).style.display = ''; });
    ['filterBar','progressSection','dashboard'].forEach(id => { document.getElementById(id).style.display = 'none'; });
    document.getElementById('resetBtn').style.display = 'none';
    input.value = '';
  });

  // Sheet selector
  document.getElementById('sheetSelect').addEventListener('change', e => loadSheet(e.target.value));

  // Dimension filters
  const filterMap = {
    filterResponsible: 'responsible',
    filterProduct:     'product',
    filterPlatform:    'platform',
    filterCountry:     'country',
    filterMonth:       'month',
  };
  Object.entries(filterMap).forEach(([id, dim]) => {
    document.getElementById(id).addEventListener('change', e => {
      state.filters[dim] = e.target.value;
      refreshDashboard();
    });
  });

  document.getElementById('resetFilters').addEventListener('click', () => {
    state.filters = { responsible: '', product: '', platform: '', country: '', month: '' };
    Object.keys(filterMap).forEach(id => { document.getElementById(id).value = ''; });
    refreshDashboard();
  });

  // Chart controls
  document.getElementById('viewsChartTop').addEventListener('change', renderViewsChart);
  document.getElementById('respMetric').addEventListener('change', renderRespChart);
  document.getElementById('countryMetric').addEventListener('change', renderCountryChart);

  // Table sort
  document.querySelectorAll('.th-sort').forEach(th => {
    th.addEventListener('click', () => {
      const col = th.dataset.sort;
      if (state.sortBy === col) state.sortDir = state.sortDir === 'desc' ? 'asc' : 'desc';
      else { state.sortBy = col; state.sortDir = 'desc'; }
      renderTable();
    });
  });

  // Table search
  document.getElementById('tableSearch').addEventListener('input', e => {
    state.searchQ = e.target.value;
    applyFilters();
    renderTable();
  });

  // Action buttons
  document.getElementById('fetchBtn').addEventListener('click', fetchVideoData);
  document.getElementById('exportBtn').addEventListener('click', exportFilledWorkbook);
});
