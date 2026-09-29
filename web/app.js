const $ = selector => document.querySelector(selector);
const audio = $('#audio');
const navItems = [
  ['Home', 'home'], ['Songs', 'songs'], ['Artists', 'artists'],
  ['Albums', 'albums'], ['Liked', 'heart'], ['Playlists', 'playlists'],
];
const state = {
  token: '', remote: false, webAuthenticated: true, status: null, tracks: [], channel: '', channelId: null, revision: -1,
  channels: [], channelsFetched: false, collections: null, page: 'Home', query: '',
  group: null, currentId: null, playQueue: [], modal: null, limit: 100,
  loadingLibrary: false, busy: false, notice: '',
};
let saveTail = Promise.resolve();

const esc = value => String(value ?? '').replace(/[&<>"']/g, ch =>
  ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[ch]));
const icon = name => `<svg class="icon" aria-hidden="true"><use href="#i-${name}"></use></svg>`;
const duration = seconds => {
  const n = Math.max(0, Math.floor(Number(seconds) || 0));
  return `${Math.floor(n / 60)}:${String(n % 60).padStart(2, '0')}`;
};
const titleOf = t => t?.title || 'Untitled';
const artistOf = t => t?.artist || 'Unknown artist';
const idOf = t => String(t.messageId);
const currentTrack = () => state.tracks.find(t => idOf(t) === state.currentId);
const liked = id => state.collections?.favorites.includes(String(id)) ?? false;
const albumOf = t => state.collections?.albumOverrides?.[idOf(t)] || 'Unsorted tracks';
const urlFor = path => state.remote ? path : `${path}?token=${encodeURIComponent(state.token)}`;
function art(t, size = 48, round = false) {
  const letter = t ? esc(titleOf(t).slice(0, 1).toUpperCase()) : icon('songs');
  const image = t ? `<img loading="lazy" src="${urlFor(`/artwork/${t.messageId}`)}" alt="">` : '';
  return `<div class="art${round ? ' round' : ''}" style="width:${size}px;height:${size}px"><span class="placeholder">${letter}</span>${image}</div>`;
}
function button(action, label, iconName, extra = '') {
  return `<button class="icon-btn ${extra}" data-action="${action}" aria-label="${esc(label)}" title="${esc(label)}">${icon(iconName)}</button>`;
}
async function api(path, data) {
  const response = await fetch(urlFor(path), {
    method: data === undefined ? 'GET' : 'POST',
    headers: data === undefined ? undefined : {'Content-Type': 'application/json'},
    body: data === undefined ? undefined : JSON.stringify(data),
  });
  const result = await response.json();
  if (!response.ok) {
    const error = new Error(result.error || `Request failed (${response.status})`);
    error.status = response.status;
    throw error;
  }
  return result;
}
function errorMessage(error) {
  state.notice = error?.message || String(error);
  renderNotice();
}
function renderNotice() {
  const notice = $('#notice');
  notice.hidden = !state.notice;
  notice.textContent = state.notice;
}
function renderStatus() {
  const online = state.status?.online;
  $('#sidebar-dot').classList.toggle('online', Boolean(online));
  $('#sidebar-status').textContent = online ? 'Telegram connected' :
    state.status?.authenticated ? 'Telegram reconnecting' : 'Sign in to Telegram';
  $('#web-signout').hidden = !(state.remote && state.webAuthenticated);
}
async function loadChannels() {
  state.channels = (await api('/channels')).channels;
  state.channelsFetched = true;
  render();
}
async function loadLibrary() {
  if (state.loadingLibrary) return;
  state.loadingLibrary = true;
  try {
    const library = await api('/library');
    const changed = library.channelId !== state.channelId;
    state.tracks = library.tracks || [];
    state.channel = library.channel;
    state.channelId = library.channelId;
    state.revision = library.catalogRevision;
    if (changed || !state.collections) {
      const saved = await api('/collections');
      state.collections = {channelId: state.channelId, ...saved};
      if (changed) { audio.pause(); audio.removeAttribute('src'); state.currentId = null; state.playQueue = []; }
    }
    render();
  } finally { state.loadingLibrary = false; }
}
async function refreshStatus(force = false) {
  if ((!state.remote && !state.token) || (state.remote && !state.webAuthenticated)) return;
  try {
    const previous = state.status;
    const status = await api('/status');
    state.status = status;
    renderStatus();
    if (status.authenticated && status.selected) {
      if (force || status.catalogRevision !== state.revision) await loadLibrary();
      else if (!previous?.selected) render();
    } else if (status.authenticated && !status.selected) {
      if (!state.channelsFetched) await loadChannels();
      else if (previous?.selected) render();
    } else if (!previous || previous.step !== status.step || previous.authenticated !== status.authenticated) {
      render();
    }
  } catch (error) {
    if (state.remote && error.status === 401) {
      state.webAuthenticated = false; state.status = null;
      audio.pause(); render();
    } else errorMessage(error);
  }
}
function nav() {
  const markup = navItems.map(([name, symbol]) =>
    `<button class="nav-button${state.page === name ? ' active' : ''}" data-action="page" data-page="${name}">${icon(symbol)}<span>${name}</span></button>`).join('');
  $('#side-nav').innerHTML = markup;
  $('#mobile-nav').innerHTML = markup;
}
function heading(kicker, title, subtitle = '', action = '') {
  return `<div class="page-heading"><div><div class="eyebrow">${esc(kicker)}</div><h1 class="page-title">${esc(title)}</h1><p class="page-subtitle">${esc(subtitle)}</p></div>${action}</div>`;
}
function trackRow(t, index) {
  const id = idOf(t);
  return `<div class="track-row${state.currentId === id ? ' active' : ''}">
    <span class="track-number">${index + 1}</span>${art(t)}
    <div class="track-copy"><button class="track-title" data-action="play" data-id="${id}">${esc(titleOf(t))}</button><div class="track-artist">${esc(artistOf(t))}</div></div>
    <span class="track-album">${esc(albumOf(t))}</span>
    ${button('like', liked(id) ? 'Unlike' : 'Like', 'heart', liked(id) ? 'liked' : '').replace('data-action="like"', `data-action="like" data-id="${id}"`)}
    ${button('add', 'Add to playlist', 'plus').replace('data-action="add"', `data-action="add" data-id="${id}"`)}
    <span class="track-duration">${duration(t.durationSeconds)}</span></div>`;
}
function trackList(items) {
  if (!items.length) return '<div class="empty">No songs here yet.</div>';
  const shown = items.slice(0, state.limit);
  return `<div class="list-header"><span></span><span></span><span>Title</span><span>Album</span><span>Time</span></div>
    <div class="track-list">${shown.map(trackRow).join('')}</div>
    ${items.length > shown.length ? `<button class="pill dark" data-action="more">Show more · ${items.length - shown.length} remaining</button>` : ''}`;
}
function groupsBy(kind) {
  const map = new Map();
  state.tracks.forEach(t => {
    const name = kind === 'Artists' ? artistOf(t) : albumOf(t);
    if (!map.has(name)) map.set(name, []);
    map.get(name).push(t);
  });
  return [...map].sort((a, b) => a[0].localeCompare(b[0]));
}
function groupCards(groups, kind, limit = Infinity) {
  if (!groups.length) return '<div class="empty">Nothing to browse yet.</div>';
  return `<div class="group-grid">${groups.slice(0, limit).map(([name, songs]) =>
    `<button class="group-card" data-action="group" data-kind="${kind}" data-name="${esc(name)}">${art(songs[0], 160, kind === 'Artists')}<strong>${esc(name)}</strong><span>${songs.length} ${songs.length === 1 ? 'song' : 'songs'}</span></button>`).join('')}</div>`;
}
function filterTracks(items) {
  const q = state.query.trim().toLowerCase();
  return q ? items.filter(t => `${titleOf(t)} ${artistOf(t)} ${albumOf(t)}`.toLowerCase().includes(q)) : items;
}
function home() {
  const featured = state.tracks[0];
  const hero = `<div class="hero"><div class="hero-copy"><div class="eyebrow">YOUR CHANNEL</div><h2 class="hero-title">Your music, on your terms.</h2><p>${esc(state.channel)} · ${state.tracks.length} songs ready to browse</p>
    <button class="pill" data-action="play-first">${icon('play')} Listen now</button></div><div class="hero-cover">${art(featured, 255)}</div></div>`;
  const quick = `<div class="section-head"><h2>Your library</h2></div><div class="quick-grid">
    ${[['Liked', state.collections?.favorites.length || 0, state.tracks.find(t => liked(idOf(t)))],
      ['Songs', state.tracks.length, state.tracks[0]], ['Playlists', state.collections?.playlists.length || 0, state.tracks[1]]]
      .map(([name, count, t]) => `<button class="quick-card" data-action="page" data-page="${name}">${art(t, 56)}<div><strong>${name === 'Songs' ? 'All songs' : name === 'Liked' ? 'Liked songs' : name}</strong><span>${count} ${name === 'Playlists' ? 'playlists' : 'songs'}</span></div></button>`).join('')}</div>`;
  return `${heading('Welcome back', 'Home', `Listening from ${state.channel}`)}${hero}${quick}
    <div class="section-head"><h2>Recently added</h2><button class="text-link" data-action="page" data-page="Songs">View all</button></div>${trackList(state.tracks.slice(0, 8))}
    <div class="section-head"><h2>Artists</h2><button class="text-link" data-action="page" data-page="Artists">View all</button></div>${groupCards(groupsBy('Artists'), 'Artists', 6)}`;
}
function playlistPage() {
  const playlists = state.collections?.playlists || [];
  return `${heading('Your library', 'Playlists', `${playlists.length} saved playlists`)}
    <div class="toolbar"><input id="playlist-name" maxlength="60" placeholder="New playlist name" aria-label="New playlist name"><button class="pill dark" data-action="create-playlist">${icon('plus')} Create</button></div>
    ${playlists.length ? `<div class="group-grid">${playlists.map((p, i) => `<button class="group-card" data-action="playlist" data-index="${i}">${art(state.tracks.find(t => p.trackIds.includes(idOf(t))), 160)}<strong>${esc(p.name)}</strong><span>${p.trackIds.length} songs</span></button>`).join('')}</div>` : '<div class="empty">Create a playlist to keep your favorites together.</div>'}`;
}
function content() {
  if (state.remote && !state.webAuthenticated) return webLogin();
  if (!state.status) return '<div class="loading">Connecting to your music…</div>';
  if (!state.status.authenticated) return setup();
  if (!state.status.selected) return channelsPage();
  if (state.group) {
    const songs = state.group.tracks;
    return `${heading(state.group.kind, state.group.name, `${songs.length} songs`, '<button class="small-button" data-action="back">Back</button>')}${trackList(filterTracks(songs))}`;
  }
  if (state.page === 'Home') return home();
  if (state.page === 'Songs') return `${heading('Your channel', 'All songs', `${state.tracks.length} tracks · ${state.channel}`)}${trackList(filterTracks(state.tracks))}`;
  if (state.page === 'Liked') {
    const songs = state.tracks.filter(t => liked(idOf(t)));
    return `${heading('Your library', 'Liked songs', `${songs.length} tracks`)}${trackList(filterTracks(songs))}`;
  }
  if (state.page === 'Artists' || state.page === 'Albums') {
    const groups = groupsBy(state.page).filter(([name]) => name.toLowerCase().includes(state.query.toLowerCase()));
    return `${heading('Browse', state.page, `${groups.length} ${state.page.toLowerCase()}`)}${groupCards(groups, state.page)}`;
  }
  return playlistPage();
}
function webLogin() {
  return `<div class="setup"><img class="setup-logo" src="/web/logo.png" alt=""><div class="eyebrow">PRIVATE WEB PLAYER</div>
    <h1>Your music, anywhere.</h1><p>Enter the sharing password set on the Windows computer hosting Telopotify.</p>
    <form id="web-login-form"><input id="web-password" type="password" placeholder="Sharing password" aria-label="Sharing password" autocomplete="current-password" required><button class="pill" type="submit">Unlock</button></form></div>`;
}
function setup() {
  const step = state.status.step;
  const prompt = {phone: 'Phone number with country code', code: 'Telegram login code',
    password: 'Two-step password', email: 'Email address', emailCode: 'Email verification code'}[step];
  return `<div class="setup"><img class="setup-logo" src="/web/logo.png" alt=""><div class="eyebrow">WELCOME TO TELOPOTIFY</div>
    <h1>Your music starts here.</h1><p>${state.remote ? 'Sign in through the private Telopotify service on the Windows PC.' : 'Sign in to Telegram on this computer.'} Your session stays on that computer and songs stream as needed.</p>
    ${prompt ? `<form id="auth-form"><input id="auth-value" ${step === 'password' ? 'type="password"' : 'type="text"'} placeholder="${prompt}" aria-label="${prompt}" autocomplete="off" required><button class="pill" type="submit">Continue</button></form>` : `<p>Connecting to Telegram…</p><button class="pill dark" data-action="reconnect">Retry connection</button>`}
    ${state.status.error ? `<p class="setup-error">${esc(state.status.error)}</p>` : ''}</div>`;
}
function channelsPage() {
  return `<div class="setup"><img class="setup-logo" src="/web/logo.png" alt=""><div class="eyebrow">ONE MORE STEP</div><h1>Choose your channel.</h1>
    <p>Select the channel that contains your music. Indexing reads song details without downloading all the audio.</p>
    ${state.busy ? '<div class="loading">Indexing your songs…</div>' : state.channels.map(c =>
      `<button class="channel-choice" data-action="channel" data-index="${c.index}"><div class="art"><span class="placeholder">${esc(c.title.slice(0, 1))}</span></div><strong>${esc(c.title)}</strong>${icon('chevron')}</button>`).join('') || '<div class="loading">Looking for your channels…</div>'}
    <button class="text-link" data-action="channels-refresh">Refresh channels</button></div>`;
}
function renderPlayer() {
  const t = currentTrack();
  const playing = t && !audio.paused;
  $('#player').innerHTML = `<div class="player-track">${art(t, 51)}<div class="track-copy"><button class="title-button" data-action="now">${esc(t ? titleOf(t) : 'Nothing playing')}</button><p>${esc(t ? artistOf(t) : 'Choose a song to start listening')}</p></div>${t ? button('like', liked(state.currentId) ? 'Unlike' : 'Like', 'heart', liked(state.currentId) ? 'liked' : '') : ''}</div>
    <div class="player-center"><div class="player-controls">${button('prev', 'Previous song', 'prev')}<button class="play-round" data-action="toggle" aria-label="${playing ? 'Pause' : 'Play'}">${icon(playing ? 'pause' : 'play')}</button>${button('next', 'Next song', 'next')}</div>
    <div class="progress-row"><span class="current-time">${duration(audio.currentTime)}</span><input class="seek" type="range" min="0" max="1000" value="${Math.round((audio.currentTime / (audio.duration || 1)) * 1000) || 0}" aria-label="Song progress"><span class="total-time">${duration(audio.duration || t?.durationSeconds)}</span></div></div>
    <div class="player-right">${icon('volume')}<input id="volume" type="range" min="0" max="1" step="0.01" value="${audio.volume}" aria-label="Volume"></div>`;
}
function renderModal() {
  const root = $('#modal-root');
  if (!state.modal) { root.innerHTML = ''; return; }
  if (state.modal.type === 'add') {
    const playlists = state.collections?.playlists || [];
    root.innerHTML = `<div class="modal-backdrop" data-action="close"><div class="dialog" role="dialog" aria-modal="true" aria-label="Add to playlist">
      ${button('close', 'Close', 'close', 'close')}<h2>Add to playlist</h2><p>${esc(titleOf(state.tracks.find(t => idOf(t) === state.modal.id)))}</p>
      <div class="dialog-list">${playlists.map((p, i) => `<button data-action="add-to-playlist" data-index="${i}">${esc(p.name)}${icon('plus')}</button>`).join('') || '<p>Create a playlist first.</p>'}</div>
      <form id="modal-playlist-form"><input id="modal-playlist-name" maxlength="60" placeholder="New playlist name" aria-label="New playlist name" required><button class="pill" type="submit">Create</button></form></div></div>`;
    return;
  }
  const t = currentTrack();
  root.innerHTML = `<div class="modal-backdrop" data-action="close"><div class="dialog now-modal" role="dialog" aria-modal="true" aria-label="Now playing">
    ${button('close', 'Close', 'close', 'close')}<div class="eyebrow">NOW PLAYING</div>${art(t, 300)}<h2>${esc(t ? titleOf(t) : 'Nothing playing')}</h2><p>${esc(t ? artistOf(t) : 'Choose a song')}</p>
    <div class="player-center"><div class="progress-row"><span class="current-time">${duration(audio.currentTime)}</span><input class="seek" type="range" min="0" max="1000" value="0" aria-label="Song progress"><span class="total-time">${duration(audio.duration || t?.durationSeconds)}</span></div>
    <div class="player-controls">${button('prev', 'Previous song', 'prev')}<button class="play-round" data-action="toggle" aria-label="${audio.paused ? 'Play' : 'Pause'}">${icon(audio.paused ? 'play' : 'pause')}</button>${button('next', 'Next song', 'next')}</div></div>
    <div class="now-actions">${t ? button('like', liked(state.currentId) ? 'Unlike' : 'Like', 'heart', liked(state.currentId) ? 'liked' : '') : ''}<span class="eyebrow">${esc(state.channel)}</span>${t ? button('add', 'Add to playlist', 'plus').replace('data-action="add"', `data-action="add" data-id="${state.currentId}"`) : ''}</div></div></div>`;
  updateTime();
}
function render() {
  nav(); renderNotice(); renderStatus();
  $('#content').innerHTML = content();
  renderPlayer(); renderModal();
  document.querySelectorAll('.art img').forEach(img => { if (img.complete && !img.naturalWidth) img.remove(); });
}
function updateTime() {
  document.querySelectorAll('.current-time').forEach(el => { el.textContent = duration(audio.currentTime); });
  document.querySelectorAll('.total-time').forEach(el => { el.textContent = duration(audio.duration || currentTrack()?.durationSeconds); });
  document.querySelectorAll('.seek').forEach(el => {
    if (document.activeElement !== el) el.value = String(Math.round(audio.currentTime / (audio.duration || 1) * 1000) || 0);
  });
}
function queueForView() {
  if (state.group) return state.group.tracks;
  if (state.page === 'Liked') return state.tracks.filter(t => liked(idOf(t)));
  return filterTracks(state.tracks);
}
async function playTrack(t, queue = queueForView()) {
  if (!t) return;
  state.currentId = idOf(t);
  state.playQueue = queue.map(idOf);
  audio.src = urlFor(`/audio/${t.messageId}`);
  audio.load();
  renderPlayer(); renderModal();
  try { await audio.play(); state.notice = ''; renderNotice(); renderPlayer(); renderModal(); }
  catch (error) { errorMessage(error); }
}
function step(direction) {
  const index = state.playQueue.indexOf(state.currentId);
  if (direction < 0 && audio.currentTime > 3) { audio.currentTime = 0; return; }
  const next = state.playQueue[index + direction];
  if (next) playTrack(state.tracks.find(t => idOf(t) === next), state.playQueue.map(id => state.tracks.find(t => idOf(t) === id)).filter(Boolean));
  else if (direction > 0) { audio.pause(); renderPlayer(); renderModal(); }
}
function saveCollections(next) {
  state.collections = {...next, channelId: state.channelId};
  render();
  const value = state.collections;
  saveTail = saveTail.catch(() => {}).then(async () => {
    const saved = await api('/collections', value);
    if (state.channelId === value.channelId) state.collections = {...value, ...saved};
  }).catch(errorMessage);
}
function createPlaylist(name) {
  const clean = name.trim();
  if (!clean || clean.length > 60) return;
  if (state.collections.playlists.some(p => p.name.toLowerCase() === clean.toLowerCase())) {
    errorMessage(new Error('A playlist with that name already exists.')); return;
  }
  const playlist = {id: `p${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`,
    name: clean, trackIds: []};
  saveCollections({...state.collections, playlists: [...state.collections.playlists, playlist]});
}
async function onAction(buttonEl) {
  const action = buttonEl.dataset.action;
  if (action === 'close') { state.modal = null; renderModal(); return; }
  if (action === 'web-logout') {
    await api('/web/logout', {});
    state.webAuthenticated = false; state.status = null; audio.pause();
    state.modal = null; render(); return;
  }
  if (action === 'page') { state.page = buttonEl.dataset.page; state.group = null; state.limit = 100; render(); $('#content').scrollTop = 0; return; }
  if (action === 'more') { state.limit += 100; render(); return; }
  if (action === 'back') { state.group = null; render(); return; }
  if (action === 'group') {
    state.group = {kind: buttonEl.dataset.kind, name: buttonEl.dataset.name,
      tracks: groupsBy(buttonEl.dataset.kind).find(([name]) => name === buttonEl.dataset.name)?.[1] || []};
    state.limit = 100; render(); $('#content').scrollTop = 0; return;
  }
  if (action === 'playlist') {
    const p = state.collections.playlists[Number(buttonEl.dataset.index)];
    state.group = {kind: 'PLAYLIST', name: p.name, tracks: p.trackIds.map(id => state.tracks.find(t => idOf(t) === id)).filter(Boolean)};
    render(); return;
  }
  if (action === 'play-first') return playTrack(state.tracks[0], state.tracks);
  if (action === 'play') return playTrack(state.tracks.find(t => idOf(t) === buttonEl.dataset.id));
  if (action === 'toggle') {
    if (!state.currentId) return playTrack(state.tracks[0], state.tracks);
    if (audio.error) return playTrack(currentTrack(), state.playQueue.map(id => state.tracks.find(t => idOf(t) === id)).filter(Boolean));
    if (audio.paused) await audio.play().catch(errorMessage); else audio.pause();
    renderPlayer(); renderModal(); return;
  }
  if (action === 'next') return step(1);
  if (action === 'prev') return step(-1);
  if (action === 'now') { if (state.currentId) { state.modal = {type: 'now'}; renderModal(); } return; }
  if (action === 'like') {
    const id = buttonEl.dataset.id || state.currentId;
    if (!id) return;
    const favorites = liked(id) ? state.collections.favorites.filter(x => x !== id) : [...state.collections.favorites, id];
    saveCollections({...state.collections, favorites}); return;
  }
  if (action === 'add') { state.modal = {type: 'add', id: buttonEl.dataset.id || state.currentId}; renderModal(); return; }
  if (action === 'add-to-playlist') {
    const index = Number(buttonEl.dataset.index);
    const playlists = state.collections.playlists.map((p, i) => i === index ?
      {...p, trackIds: p.trackIds.includes(state.modal.id) ? p.trackIds : [...p.trackIds, state.modal.id]} : p);
    state.modal = null; saveCollections({...state.collections, playlists}); return;
  }
  if (action === 'create-playlist') { createPlaylist($('#playlist-name')?.value || ''); return; }
  if (action === 'channels-refresh') { state.channelsFetched = false; await loadChannels(); return; }
  if (action === 'channel') {
    state.busy = true; render();
    try { await api('/channels/select', {index: Number(buttonEl.dataset.index)}); await refreshStatus(true); }
    finally { state.busy = false; render(); }
    return;
  }
  if (action === 'reconnect') { await api('/reconnect', {}); await refreshStatus(true); return; }
  if (action === 'refresh') {
    if (state.status?.selected && state.status.online) await api('/library/sync', {});
    else await api('/reconnect', {});
    await refreshStatus(true);
  }
}
document.addEventListener('click', event => {
  const target = event.target.closest('[data-action]');
  if (!target) return;
  if (target.classList.contains('modal-backdrop') && event.target !== target) return;
  event.preventDefault();
  Promise.resolve(onAction(target)).catch(errorMessage);
});
document.addEventListener('submit', event => {
  event.preventDefault();
  if (event.target.id === 'auth-form') {
    const step = state.status.step;
    const value = $('#auth-value').value.trim();
    const request = step === 'phone' ? api('/auth/start', {phone: value}) : api('/auth/input', {step, value});
    request.then(() => refreshStatus()).catch(errorMessage);
  }
  if (event.target.id === 'web-login-form') {
    fetch('/web/login', {method: 'POST', headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({password: $('#web-password').value})}).then(async response => {
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'Could not unlock the player');
      state.webAuthenticated = true;
      await refreshStatus(true);
    }).catch(errorMessage);
  }
  if (event.target.id === 'modal-playlist-form') {
    createPlaylist($('#modal-playlist-name').value);
    renderModal();
  }
});
$('#search').addEventListener('input', event => {
  state.query = event.target.value; state.limit = 100;
  if (state.page === 'Home') state.page = 'Songs';
  render();
});
document.addEventListener('input', event => {
  if (event.target.classList.contains('seek') && audio.duration) audio.currentTime = audio.duration * Number(event.target.value) / 1000;
  if (event.target.id === 'volume') audio.volume = Number(event.target.value);
});
document.addEventListener('error', event => {
  if (event.target.matches?.('.art img')) event.target.remove();
}, true);
audio.addEventListener('timeupdate', updateTime);
audio.addEventListener('durationchange', updateTime);
audio.addEventListener('play', () => { renderPlayer(); if (state.modal?.type === 'now') renderModal(); });
audio.addEventListener('pause', () => { renderPlayer(); if (state.modal?.type === 'now') renderModal(); });
audio.addEventListener('ended', () => step(1));
audio.addEventListener('error', () => { if (state.currentId) errorMessage(new Error('Playback stopped. Check Telegram or the VPN, then press play to retry.')); });
async function start() {
  try {
    const session = await fetch('/web/session');
    if (session.ok) {
      state.remote = true;
      state.webAuthenticated = Boolean((await session.json()).authenticated);
      if (state.webAuthenticated) await refreshStatus(true); else render();
    } else {
      const bootstrap = await (await fetch('/bootstrap')).json();
      state.token = new URL(bootstrap.address).searchParams.get('token') || '';
      await refreshStatus(true);
    }
    setInterval(() => refreshStatus().catch(errorMessage), 5000);
  } catch (error) { errorMessage(error); render(); }
}
render();
start();
