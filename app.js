
const IDB_NAME = 'spool_media_db';
const IDB_STORE = 'media';
let idbPromise = null;

function idbOpen() {
  if (idbPromise) return idbPromise;
  idbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB_NAME, 1);
    req.onupgradeneeded = () => { req.result.createObjectStore(IDB_STORE); };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return idbPromise;
}
async function idbPut(key, blob) {
  const db = await idbOpen();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, 'readwrite');
    tx.objectStore(IDB_STORE).put(blob, key);
    tx.oncomplete = () => resolve(true);
    tx.onerror = () => reject(tx.error);
  });
}
async function idbGet(key) {
  if (!key) return null;
  const db = await idbOpen();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, 'readonly');
    const req = tx.objectStore(IDB_STORE).get(key);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  });
}

/* ---------------------------------------------------------------------- */
/* localStorage — structured data                                         */
/* ---------------------------------------------------------------------- */
const LS = { USERS: 'spool_users', SESSION: 'spool_session', VIDEOS: 'spool_videos', PURCHASES: 'spool_purchases', SEEDED: 'spool_seeded' };

function lsGet(key, fallback) {
  try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : fallback; }
  catch (e) { return fallback; }
}
function lsSet(key, val) { localStorage.setItem(key, JSON.stringify(val)); }

const getUsers = () => lsGet(LS.USERS, []);
const saveUsers = (u) => lsSet(LS.USERS, u);
const getVideos = () => lsGet(LS.VIDEOS, []);
const saveVideos = (v) => lsSet(LS.VIDEOS, v);
const getPurchases = () => lsGet(LS.PURCHASES, []);
const savePurchases = (p) => lsSet(LS.PURCHASES, p);
const getSessionUserId = () => lsGet(LS.SESSION, null);
const setSessionUserId = (id) => lsSet(LS.SESSION, id);

/* ---------------------------------------------------------------------- */
/* Utilities                                                               */
/* ---------------------------------------------------------------------- */
function uid(prefix) { return (prefix || 'id') + '_' + Math.random().toString(36).slice(2, 9) + Date.now().toString(36).slice(-4); }
function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function fmtPrice(n) { return '$' + Number(n).toFixed(2); }
function initialsOf(name) { return (name || '?').trim().split(/\s+/).map(w => w[0]).slice(0, 2).join('').toUpperCase(); }
function pad4(n) { return String(n).padStart(4, '0'); }
function timeAgo(iso) {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return mins + 'm ago';
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return hrs + 'h ago';
  const days = Math.floor(hrs / 24);
  if (days < 30) return days + 'd ago';
  return new Date(iso).toLocaleDateString();
}
function guessExt(mime, fallback) {
  if (!mime) return fallback;
  const part = mime.split('/')[1];
  if (!part) return fallback;
  return part.split('+')[0];
}
function slugify(s) { return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '').slice(0, 40) || 'spool-file'; }

let toastTimer;
function toast(msg) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 3200);
}
function showStatus(el, msg, ok) {
  el.textContent = msg;
  el.hidden = false;
  el.className = 'form-status ' + (ok ? 'ok' : 'err');
}

/* ---------------------------------------------------------------------- */
/* Auth                                                                    */
/* ---------------------------------------------------------------------- */
let currentUser = null;

function refreshCurrentUser() {
  const id = getSessionUserId();
  if (!id) { currentUser = null; return; }
  currentUser = getUsers().find(u => u.id === id) || null;
  if (!currentUser) setSessionUserId(null);
}

function signup(username, email, password) {
  username = (username || '').trim();
  email = (email || '').trim();
  const users = getUsers();
  if (username.length < 2) throw new Error('Username needs at least 2 characters.');
  if (!email.includes('@')) throw new Error('Enter a valid email address.');
  if (password.length < 4) throw new Error('Password needs at least 4 characters.');
  if (users.some(u => u.email.toLowerCase() === email.toLowerCase())) throw new Error('An account with this email already exists.');
  const user = { id: uid('u'), username, email, password, createdAt: new Date().toISOString() };
  users.push(user);
  saveUsers(users);
  setSessionUserId(user.id);
  currentUser = user;
  return user;
}
function login(email, password) {
  const users = getUsers();
  const user = users.find(u => u.email.toLowerCase() === String(email).trim().toLowerCase());
  if (!user || user.password !== password) throw new Error('Email or password is incorrect.');
  setSessionUserId(user.id);
  currentUser = user;
  return user;
}
function logout() { setSessionUserId(null); currentUser = null; }

/* ---------------------------------------------------------------------- */
/* Video / photo listings                                                 */
/* ---------------------------------------------------------------------- */
async function addVideo(meta, mediaFile, thumbFile) {
  const id = uid('v');
  const mediaKey = 'media_' + id;
  await idbPut(mediaKey, mediaFile);

  let thumbKey;
  if (meta.mediaType === 'image') {
    thumbKey = mediaKey;
  } else {
    thumbKey = 'thumb_' + id;
    await idbPut(thumbKey, thumbFile);
  }

  const video = {
    id,
    ownerId: currentUser.id,
    ownerName: currentUser.username,
    mediaType: meta.mediaType,
    title: meta.title,
    description: meta.description,
    details: meta.details || '',
    tags: meta.tags || [],
    category: meta.category,
    price: Number(meta.price) || 0,
    thumbKey,
    mediaKey,
    createdAt: new Date().toISOString(),
    views: 0
  };
  const videos = getVideos();
  videos.unshift(video);
  saveVideos(videos);
  return video;
}
function updateVideoViews(id) {
  const videos = getVideos();
  const v = videos.find(v => v.id === id);
  if (v) { v.views = (v.views || 0) + 1; saveVideos(videos); }
}
function hasPurchased(userId, videoId) {
  return getPurchases().some(p => p.userId === userId && p.videoId === videoId);
}
function purchaseVideo(video) {
  const purchases = getPurchases();
  const purchase = { id: uid('p'), userId: currentUser.id, videoId: video.id, purchasedAt: new Date().toISOString(), price: video.price };
  purchases.push(purchase);
  savePurchases(purchases);
  return purchase;
}
async function downloadPurchased(v) {
  const blob = await idbGet(v.mediaKey);
  if (!blob) { toast('Original file is unavailable for this demo listing.'); return; }
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  const ext = guessExt(blob.type, v.mediaType === 'video' ? 'mp4' : 'jpg');
  a.href = url;
  a.download = slugify(v.title) + '.' + ext;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

/* ---------------------------------------------------------------------- */
/* Seed demo listings on first run so the marketplace isn't empty          */
/* ---------------------------------------------------------------------- */
function placeholderSVG(category, title) {
  const palettes = {
    nature: ['#2f4a2f', '#7fae5b'], travel: ['#3a3320', '#c9a94d'], city: ['#1a2333', '#5f7fae'],
    business: ['#332318', '#c98d4d'], technology: ['#1c2a2a', '#4dc9b0'], people: ['#332222', '#c96b4d'],
    food: ['#332818', '#e0a24d'], animals: ['#2a2418', '#b0964d'], abstract: ['#241a33', '#a04dc9']
  };
  const pal = palettes[category] || ['#26261a', '#c9a94d'];
  const safe = String(title).replace(/[<>&]/g, '');
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="800" height="500" viewBox="0 0 800 500">' +
    '<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">' +
    '<stop offset="0" stop-color="' + pal[0] + '"/><stop offset="1" stop-color="' + pal[1] + '"/>' +
    '</linearGradient></defs>' +
    '<rect width="800" height="500" fill="url(#g)"/>' +
    '<text x="40" y="450" font-family="monospace" font-size="22" fill="#f1efe2" opacity="0.85">' + safe.slice(0, 44) + '</text>' +
    '<text x="40" y="60" font-family="monospace" font-size="16" fill="#f1efe2" opacity="0.6">' + category.toUpperCase() + '</text>' +
    '</svg>';
  return 'data:image/svg+xml;base64,' + btoa(svg);
}
async function seedIfEmpty() {
  if (localStorage.getItem(LS.SEEDED)) return;
  if (getVideos().length > 0) { localStorage.setItem(LS.SEEDED, '1'); return; }

  const demoUser = { id: uid('u'), username: 'demo_creator', email: 'demo@spool.local', password: 'demo1234', createdAt: new Date().toISOString() };
  const users = getUsers();
  users.push(demoUser);
  saveUsers(users);

  const seeds = [
    { category: 'nature', title: 'Misty pine forest at dawn', desc: 'Slow pass over fog-covered pines just after sunrise. Great for calm, meditative openers.', price: 6, tags: ['forest', 'fog', 'dawn'] },
    { category: 'travel', title: 'Cobblestone alley, old town', desc: 'A quiet tiled alleyway in the early morning light, no people in frame.', price: 4.5, tags: ['street', 'europe', 'old-town'] },
    { category: 'city', title: 'Rooftop skyline at blue hour', desc: 'Wide, stable shot of a city skyline just after sunset with lights coming on.', price: 7, tags: ['skyline', 'dusk', 'urban'] },
    { category: 'business', title: 'Team reviewing charts on a whiteboard', desc: 'Candid shot of a small team mid-planning session, natural office light.', price: 5, tags: ['meeting', 'startup', 'office'] },
    { category: 'food', title: 'Pour-over coffee close-up', desc: 'Macro shot of coffee blooming in a pour-over dripper, steam visible.', price: 3.5, tags: ['coffee', 'macro', 'cafe'] },
    { category: 'abstract', title: 'Ink dispersing in water', desc: 'Colored ink unfurling underwater against a plain black background.', price: 6.5, tags: ['ink', 'texture', 'background'] }
  ];

  const videos = getVideos();
  for (const s of seeds) {
    const id = uid('v');
    const dataUrl = placeholderSVG(s.category, s.title);
    const key = 'media_' + id;
    thumbUrlCache.set(key, dataUrl);
    videos.push({
      id, ownerId: demoUser.id, ownerName: demoUser.username, mediaType: 'image',
      category: s.category, title: s.title, description: s.desc, details: 'Sample listing · demo asset',
      tags: s.tags, price: s.price, thumbKey: key, mediaKey: key,
      createdAt: new Date(Date.now() - Math.random() * 1e10).toISOString(), views: Math.floor(Math.random() * 400)
    });
  }
  saveVideos(videos);
  localStorage.setItem(LS.SEEDED, '1');
}

/* ---------------------------------------------------------------------- */
/* Thumbnail loading (IndexedDB blobs -> <img> src), with a URL cache      */
/* ---------------------------------------------------------------------- */
const thumbUrlCache = new Map();
async function loadThumbnails() {
  const imgs = document.querySelectorAll('img[data-thumb]');
  for (const img of imgs) {
    const key = img.getAttribute('data-thumb');
    if (!key) continue;
    if (thumbUrlCache.has(key)) { img.src = thumbUrlCache.get(key); continue; }
    try {
      const blob = await idbGet(key);
      if (blob) { const url = URL.createObjectURL(blob); thumbUrlCache.set(key, url); img.src = url; }
    } catch (e) { /* ignore missing thumbnail */ }
  }
}

/* ---------------------------------------------------------------------- */
/* View switching                                                          */
/* ---------------------------------------------------------------------- */
const VIEW_NAMES = ['browse', 'upload', 'dashboard'];
function showView(name) {
  if ((name === 'upload' || name === 'dashboard') && !currentUser) { openAuthModal('login'); return; }
  VIEW_NAMES.forEach(v => { document.getElementById('view-' + v).hidden = v !== name; });
  document.querySelectorAll('.nav-link').forEach(btn => btn.classList.toggle('is-active', btn.dataset.nav === name));
  document.querySelector('.main-nav').classList.remove('mobile-open');
  if (name === 'dashboard') renderDashboard();
  window.scrollTo(0, 0);
}

function renderHeader() {
  document.querySelectorAll('.auth-only').forEach(el => { el.hidden = !currentUser; });
  const guestButtons = document.getElementById('guestButtons');
  const userChip = document.getElementById('userChip');
  if (currentUser) {
    guestButtons.hidden = true;
    userChip.hidden = false;
    document.getElementById('avatarInitials').textContent = initialsOf(currentUser.username);
    document.getElementById('userName').textContent = currentUser.username;
  } else {
    guestButtons.hidden = false;
    userChip.hidden = true;
  }
}

/* ---------------------------------------------------------------------- */
/* Browse grid: search + filters                                          */
/* ---------------------------------------------------------------------- */
const state = { search: '', category: 'all', type: 'all' };

function matchesFilters(v) {
  if (state.category !== 'all' && v.category !== state.category) return false;
  if (state.type !== 'all' && v.mediaType !== state.type) return false;
  if (state.search) {
    const hay = (v.title + ' ' + v.description + ' ' + v.ownerName + ' ' + (v.tags || []).join(' ')).toLowerCase();
    if (!hay.includes(state.search.toLowerCase())) return false;
  }
  return true;
}

function cardHTML(v) {
  const owned = currentUser && (v.ownerId === currentUser.id || hasPurchased(currentUser.id, v.id));
  return `
  <article class="card">
    <div class="card-media" data-open="${v.id}">
      <img data-thumb="${v.thumbKey}" alt="${escapeHtml(v.title)}">
      <div class="badge-row">
        <span class="type-badge">${v.mediaType === 'video' ? '&#9654; VIDEO' : 'PHOTO'}</span>
        ${owned ? '<span class="owned-badge">OWNED</span>' : '<span class="lock-badge">&#128274; LOCKED</span>'}
      </div>
    </div>
    <div class="card-body">
      <div class="card-top">
        <h3>${escapeHtml(v.title)}</h3>
        <span class="price-tag mono">${fmtPrice(v.price)}</span>
      </div>
      <p class="card-owner">by ${escapeHtml(v.ownerName)}</p>
      <div class="card-meta"><span>${v.views || 0} views</span><span>${escapeHtml(v.category)}</span></div>
      <button class="btn btn-block ${owned ? 'btn-owned' : 'btn-accent'}" data-open="${v.id}">${owned ? 'Download' : 'Purchase'}</button>
    </div>
  </article>`;
}

function renderBrowse() {
  const videos = getVideos().filter(matchesFilters);
  document.getElementById('resultCount').textContent = pad4(videos.length);
  document.getElementById('emptyState').hidden = videos.length > 0;
  document.getElementById('videoGrid').innerHTML = videos.map(cardHTML).join('');
  loadThumbnails();
}

/* ---------------------------------------------------------------------- */
/* Item detail modal (preview / buy / download)                           */
/* ---------------------------------------------------------------------- */
let modalObjectUrl = null;

async function openItemModal(id) {
  const v = getVideos().find(v => v.id === id);
  if (!v) return;
  updateVideoViews(id);
  renderBrowse();

  const isOwner = currentUser && currentUser.id === v.ownerId;
  const owned = currentUser && (isOwner || hasPurchased(currentUser.id, v.id));

  const content = document.getElementById('itemModalContent');
  content.innerHTML = `
    <div class="item-media" id="itemMediaWrap"><p style="color:var(--muted);padding:20px;">Loading preview&hellip;</p></div>
    <div class="item-title-row">
      <h2>${escapeHtml(v.title)}</h2>
      <span class="item-price mono">${fmtPrice(v.price)}</span>
    </div>
    <p class="item-owner">by ${escapeHtml(v.ownerName)} &middot; ${escapeHtml(v.category)} &middot; ${timeAgo(v.createdAt)}</p>
    <p class="item-desc">${escapeHtml(v.description)}</p>
    ${v.details ? `<p class="item-tc mono">${escapeHtml(v.details)}</p>` : ''}
    <div class="item-tags">${(v.tags || []).map(t => `<span>${escapeHtml(t)}</span>`).join('')}</div>
    <div class="item-actions" id="itemActions"></div>
  `;
  document.getElementById('itemModal').hidden = false;

  if (modalObjectUrl) { URL.revokeObjectURL(modalObjectUrl); modalObjectUrl = null; }
  const wrap = document.getElementById('itemMediaWrap');
  const key = owned ? v.mediaKey : (v.thumbKey || v.mediaKey);
  try {
    const blob = await idbGet(key);
    if (!blob) {
      wrap.innerHTML = '<p style="color:var(--muted);padding:20px;">Preview unavailable for this demo listing.</p>';
    } else {
      const url = URL.createObjectURL(blob);
      modalObjectUrl = url;
      const watermark = '<div class="watermark">' + '<span>PREVIEW · RawStream</span>'.repeat(6) + '</div>';
      if (owned && v.mediaType === 'video') {
        wrap.innerHTML = `<video src="${url}" controls autoplay></video>`;
      } else if (owned) {
        wrap.innerHTML = `<img src="${url}" alt="${escapeHtml(v.title)}">`;
      } else if (v.mediaType === 'video') {
        wrap.innerHTML = `<video src="${url}" controls muted controlsList="nodownload noremoteplayback" oncontextmenu="return false"></video>` + watermark;
      } else {
        wrap.innerHTML = `<img src="${url}" alt="${escapeHtml(v.title)}" style="filter:blur(7px) brightness(.75);" oncontextmenu="return false">` + watermark;
      }
    }
  } catch (e) {
    wrap.innerHTML = '<p style="color:var(--muted);padding:20px;">Could not load this preview.</p>';
  }

  const actions = document.getElementById('itemActions');
  if (isOwner) {
    actions.innerHTML = `<span class="form-status ok" style="display:inline-block;">This is your listing &mdash; buyers see a locked preview until they pay.</span>`;
  } else if (owned) {
    actions.innerHTML = `<button class="btn btn-accent" id="downloadBtn">Download full file</button>`;
    document.getElementById('downloadBtn').addEventListener('click', () => downloadPurchased(v));
  } else {
    actions.innerHTML = `<button class="btn btn-accent" id="buyBtn">Buy now &mdash; ${fmtPrice(v.price)}</button>`;
    document.getElementById('buyBtn').addEventListener('click', () => openCheckout(v));
  }
}

function openCheckout(v) {
  if (!currentUser) { openAuthModal('login'); return; }
  const content = document.getElementById('checkoutContent');
  content.innerHTML = `
    <p class="eyebrow">DEMO CHECKOUT</p>
    <h2>Buy &ldquo;${escapeHtml(v.title)}&rdquo;</h2>
    <p class="hero-sub small">Simulated purchase for demo purposes &mdash; no real payment is processed or collected.</p>
    <div class="checkout-summary">
      <div class="row"><span>Item</span><span>${escapeHtml(v.title)}</span></div>
      <div class="row"><span>Seller</span><span>${escapeHtml(v.ownerName)}</span></div>
      <div class="row total"><span>Total</span><span>${fmtPrice(v.price)}</span></div>
    </div>
    <button class="btn btn-accent btn-lg" id="confirmPurchaseBtn">Confirm purchase &mdash; ${fmtPrice(v.price)}</button>
    <p class="checkout-note">Unlocks the full-quality download immediately after confirming.</p>
  `;
  document.getElementById('checkoutModal').hidden = false;
  document.getElementById('confirmPurchaseBtn').addEventListener('click', () => {
    purchaseVideo(v);
    closeModal(document.getElementById('checkoutModal'));
    toast('Purchase complete — full file unlocked.');
    openItemModal(v.id);
  });
}

/* ---------------------------------------------------------------------- */
/* Modal open/close plumbing                                              */
/* ---------------------------------------------------------------------- */
function closeModal(overlay) {
  overlay.hidden = true;
  if (overlay.id === 'itemModal' && modalObjectUrl) { URL.revokeObjectURL(modalObjectUrl); modalObjectUrl = null; }
}
document.addEventListener('DOMContentLoaded', () => {
  document.querySelectorAll('.modal-overlay').forEach(overlay => {
    overlay.addEventListener('click', (e) => { if (e.target === overlay) closeModal(overlay); });
    const closeBtn = overlay.querySelector('[data-close]');
    if (closeBtn) closeBtn.addEventListener('click', () => closeModal(overlay));
  });
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') document.querySelectorAll('.modal-overlay').forEach(o => { if (!o.hidden) closeModal(o); });
});

function openAuthModal(tab) {
  switchAuthTab(tab || 'login');
  document.getElementById('authModal').hidden = false;
}
function switchAuthTab(tab) {
  document.querySelectorAll('[data-authtab]').forEach(b => b.classList.toggle('is-active', b.dataset.authtab === tab));
  document.getElementById('loginForm').hidden = tab !== 'login';
}

/* ---------------------------------------------------------------------- */
/* Global click delegation: navigation + grid open + filters              */
/* ---------------------------------------------------------------------- */
document.addEventListener('click', (e) => {
  const navBtn = e.target.closest('[data-nav]');
  if (navBtn) { showView(navBtn.dataset.nav); return; }
  const openBtn = e.target.closest('[data-open]');
  if (openBtn) { openItemModal(openBtn.dataset.open); return; }
});

document.getElementById('filterRow').addEventListener('click', (e) => {
  const catBtn = e.target.closest('.chip[data-cat]');
  if (catBtn) {
    document.querySelectorAll('.chip[data-cat]').forEach(b => b.classList.remove('is-active'));
    catBtn.classList.add('is-active');
    state.category = catBtn.dataset.cat;
    renderBrowse();
    return;
  }
  const typeBtn = e.target.closest('.chip[data-type]');
  if (typeBtn) {
    document.querySelectorAll('.chip[data-type]').forEach(b => b.classList.remove('is-active'));
    typeBtn.classList.add('is-active');
    state.type = typeBtn.dataset.type;
    renderBrowse();
  }
});

let searchDebounce;
document.getElementById('searchInput').addEventListener('input', (e) => {
  clearTimeout(searchDebounce);
  const val = e.target.value;
  searchDebounce = setTimeout(() => { state.search = val.trim(); renderBrowse(); }, 150);
});

document.getElementById('mobileMenuBtn').addEventListener('click', () => {
  document.querySelector('.main-nav').classList.toggle('mobile-open');
});

/* ---------------------------------------------------------------------- */
/* Auth forms                                                             */
/* ---------------------------------------------------------------------- */
document.getElementById('loginBtn').addEventListener('click', () => openAuthModal('login'));
document.getElementById('logoutBtn').addEventListener('click', () => {
  logout();
  renderHeader();
  showView('browse');
  renderBrowse();
  toast('Logged out.');
});

document.getElementById('loginForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const statusEl = document.getElementById('loginStatus');
  try {
    login(document.getElementById('li-email').value, document.getElementById('li-password').value);
    closeModal(document.getElementById('authModal'));
    renderHeader();
    renderBrowse();
    toast('Welcome back, ' + currentUser.username + '.');
    e.target.reset();
    statusEl.hidden = true;
  } catch (err) { showStatus(statusEl, err.message, false); }
});

/* ---------------------------------------------------------------------- */
/* Upload form                                                            */
/* ---------------------------------------------------------------------- */
const mediaTypeSelect = document.getElementById('f-mediaType');
const thumbFieldWrap = document.getElementById('thumbFieldWrap');
const thumbFileInput = document.getElementById('f-thumbFile');
function syncThumbFieldVisibility() {
  const isImage = mediaTypeSelect.value === 'image';
  thumbFieldWrap.style.display = isImage ? 'none' : 'flex';
  thumbFileInput.required = !isImage;
}
mediaTypeSelect.addEventListener('change', syncThumbFieldVisibility);

document.getElementById('uploadForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const statusEl = document.getElementById('uploadStatus');
  statusEl.hidden = true;

  const mediaType = mediaTypeSelect.value;
  const mediaFile = document.getElementById('f-mediaFile').files[0];
  const thumbFile = thumbFileInput.files[0];

  if (!mediaFile) { showStatus(statusEl, 'Choose the video or photo file you want to sell.', false); return; }
  if (mediaType === 'video' && !thumbFile) { showStatus(statusEl, 'Add a cover thumbnail for your video.', false); return; }

  const meta = {
    mediaType,
    category: document.getElementById('f-category').value,
    title: document.getElementById('f-title').value.trim(),
    description: document.getElementById('f-desc').value.trim(),
    details: document.getElementById('f-details').value.trim(),
    tags: document.getElementById('f-tags').value.split(',').map(t => t.trim()).filter(Boolean).slice(0, 10),
    price: document.getElementById('f-price').value
  };

  try {
    await addVideo(meta, mediaFile, thumbFile);
    e.target.reset();
    syncThumbFieldVisibility();
    showStatus(statusEl, 'Listing published — it is now live in Browse.', true);
    renderBrowse();
  } catch (err) {
    showStatus(statusEl, err.message || 'Something went wrong publishing this listing.', false);
  }
});

/* ---------------------------------------------------------------------- */
/* Dashboard                                                              */
/* ---------------------------------------------------------------------- */
document.querySelector('.dash-tabs').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-tab]');
  if (!btn) return;
  document.querySelectorAll('.dash-tabs .tab').forEach(b => b.classList.toggle('is-active', b === btn));
  const map = { uploads: 'dashUploads', purchases: 'dashPurchases', profile: 'dashProfile' };
  Object.keys(map).forEach(name => { document.getElementById(map[name]).hidden = name !== btn.dataset.tab; });
});

function renderDashboard() {
  if (!currentUser) return;
  renderDashUploads();
  renderDashPurchases();
  renderDashProfile();
}

function renderDashUploads() {
  const mine = getVideos().filter(v => v.ownerId === currentUser.id);
  const purchases = getPurchases();
  const totalSales = mine.reduce((sum, v) => sum + purchases.filter(p => p.videoId === v.id).length, 0);
  const totalViews = mine.reduce((sum, v) => sum + (v.views || 0), 0);
  const revenue = mine.reduce((sum, v) => sum + purchases.filter(p => p.videoId === v.id).length * v.price, 0);

  const panel = document.getElementById('dashUploads');
  const rows = mine.length === 0
    ? `<p style="color:var(--muted)">You haven&rsquo;t listed anything yet. <button class="link-btn" data-nav="upload">List your first clip</button>.</p>`
    : mine.map(v => {
      const sales = purchases.filter(p => p.videoId === v.id).length;
      return `
      <div class="list-row">
        <img class="list-thumb" data-thumb="${v.thumbKey}" data-open="${v.id}" alt="">
        <div class="list-info">
          <h4>${escapeHtml(v.title)}</h4>
          <p>${escapeHtml(v.category)} &middot; ${v.views || 0} views &middot; ${sales} sold &middot; listed ${timeAgo(v.createdAt)}</p>
        </div>
        <div class="list-actions">
          <span class="list-price mono">${fmtPrice(v.price)}</span>
          <button class="btn btn-ghost" data-open="${v.id}">View</button>
        </div>
      </div>`;
    }).join('');

  panel.innerHTML = `
    <div class="stat-row">
      <div class="stat-card"><span class="stat-num mono">${pad4(mine.length)}</span><span class="stat-label">Listings</span></div>
      <div class="stat-card"><span class="stat-num mono">${pad4(totalViews)}</span><span class="stat-label">Total views</span></div>
      <div class="stat-card"><span class="stat-num mono">${pad4(totalSales)}</span><span class="stat-label">Total sales</span></div>
      <div class="stat-card"><span class="stat-num mono">${fmtPrice(revenue)}</span><span class="stat-label">Revenue</span></div>
    </div>
    ${rows}
  `;
  loadThumbnails();
}

function renderDashPurchases() {
  const mine = getPurchases().filter(p => p.userId === currentUser.id).sort((a, b) => new Date(b.purchasedAt) - new Date(a.purchasedAt));
  const videos = getVideos();
  const panel = document.getElementById('dashPurchases');

  if (mine.length === 0) {
    panel.innerHTML = `<p style="color:var(--muted)">No purchases yet. <button class="link-btn" data-nav="browse">Browse the marketplace</button>.</p>`;
    return;
  }

  panel.innerHTML = mine.map(p => {
    const v = videos.find(v => v.id === p.videoId);
    if (!v) return '';
    return `
    <div class="list-row">
      <img class="list-thumb" data-thumb="${v.thumbKey}" data-open="${v.id}" alt="">
      <div class="list-info">
        <h4>${escapeHtml(v.title)}</h4>
        <p>by ${escapeHtml(v.ownerName)} &middot; bought ${timeAgo(p.purchasedAt)} for ${fmtPrice(p.price)}</p>
      </div>
      <div class="list-actions">
        <button class="btn btn-accent" data-download="${v.id}">Download</button>
      </div>
    </div>`;
  }).join('');

  loadThumbnails();
  panel.querySelectorAll('[data-download]').forEach(btn => {
    btn.addEventListener('click', () => {
      const v = videos.find(v => v.id === btn.dataset.download);
      if (v) downloadPurchased(v);
    });
  });
}

function renderDashProfile() {
  const panel = document.getElementById('dashProfile');
  panel.innerHTML = `
    <div class="profile-card">
      <div class="profile-avatar">${initialsOf(currentUser.username)}</div>
      <div class="profile-row"><span>Username</span><span>${escapeHtml(currentUser.username)}</span></div>
      <div class="profile-row"><span>Email</span><span>${escapeHtml(currentUser.email)}</span></div>
      <div class="profile-row"><span>Member since</span><span>${new Date(currentUser.createdAt).toLocaleDateString()}</span></div>
    </div>
  `;
}

/* ---------------------------------------------------------------------- */
/* Init                                                                    */
/* ---------------------------------------------------------------------- */
async function init() {
  refreshCurrentUser();
  await seedIfEmpty();
  syncThumbFieldVisibility();
  renderHeader();
  renderBrowse();
  showView('browse');
}
init();
