'use strict';
/* ============================================================
   BEJHERRO — Reproductor de música local (PWA)
   Fase 1: núcleo del reproductor
   ============================================================ */

/* ---------------------------------------------------------
   1. BASE DE DATOS (IndexedDB)
   Guarda: handles de archivos, metadata de pistas, playlists,
   favoritos, y el estado de reproducción para reanudar.
--------------------------------------------------------- */
const DB_NAME = 'bejherro-db';
const DB_VERSION = 1;
let dbInstance = null;

function openDatabase() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains('tracks')) {
        const store = db.createObjectStore('tracks', { keyPath: 'id' });
        store.createIndex('artist', 'artist');
        store.createIndex('album', 'album');
        store.createIndex('folder', 'folder');
      }
      if (!db.objectStoreNames.contains('playlists')) {
        db.createObjectStore('playlists', { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains('kv')) {
        db.createObjectStore('kv', { keyPath: 'key' });
      }
      if (!db.objectStoreNames.contains('folderHandles')) {
        db.createObjectStore('folderHandles', { keyPath: 'id' });
      }
    };
    req.onsuccess = (e) => resolve(e.target.result);
    req.onerror = (e) => reject(e.target.error);
  });
}

async function getDB() {
  if (!dbInstance) dbInstance = await openDatabase();
  return dbInstance;
}

function idbTx(storeName, mode = 'readonly') {
  return getDB().then((db) => db.transaction(storeName, mode).objectStore(storeName));
}

async function idbGetAll(storeName) {
  const store = await idbTx(storeName);
  return new Promise((resolve, reject) => {
    const req = store.getAll();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idbGet(storeName, key) {
  const store = await idbTx(storeName);
  return new Promise((resolve, reject) => {
    const req = store.get(key);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idbPut(storeName, value) {
  const store = await idbTx(storeName, 'readwrite');
  return new Promise((resolve, reject) => {
    const req = store.put(value);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idbDelete(storeName, key) {
  const store = await idbTx(storeName, 'readwrite');
  return new Promise((resolve, reject) => {
    const req = store.delete(key);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

async function idbClear(storeName) {
  const store = await idbTx(storeName, 'readwrite');
  return new Promise((resolve, reject) => {
    const req = store.clear();
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

async function kvGet(key, fallback = null) {
  const row = await idbGet('kv', key);
  return row ? row.value : fallback;
}
async function kvSet(key, value) {
  return idbPut('kv', { key, value });
}

/* ---------------------------------------------------------
   2. ESTADO GLOBAL
--------------------------------------------------------- */
const state = {
  tracks: [],          // todas las pistas indexadas {id, title, artist, album, genre, year, duration, fileHandle, folder, ...}
  tracksById: new Map(),
  playlists: [],        // [{id, name, trackIds:[]}]
  favorites: new Set(), // ids de pista favoritos
  folderHandles: [],    // handles de carpetas concedidas

  queue: [],            // array de track ids en el orden actual de reproducción
  queueIndex: -1,
  currentTrack: null,

  isPlaying: false,
  repeatMode: 'off',    // 'off' | 'all' | 'one' | 'stop-at-end'
  shuffle: false,
  shuffleHistory: [],
  playbackRate: 1,
  volume: 1,

  currentScreen: 'home',
  sortBy: 'title',
  sortDir: 'asc',

  sleepTimer: { active: false, mode: null, endsAt: null, intervalId: null },
};

/* ---------------------------------------------------------
   3. UTILIDADES
--------------------------------------------------------- */
function uid() {
  return 't_' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

function formatTime(sec) {
  if (!isFinite(sec) || sec < 0) sec = 0;
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

function formatBytes(bytes) {
  if (!bytes) return '—';
  const units = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  let n = bytes;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(1)} ${units[i]}`;
}

function escapeHtml(str) {
  if (str === null || str === undefined) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function toast(message, type = '') {
  const container = document.getElementById('toast-container');
  const el = document.createElement('div');
  el.className = `toast ${type}`.trim();
  el.textContent = message;
  container.appendChild(el);
  setTimeout(() => {
    el.style.opacity = '0';
    el.style.transition = 'opacity .2s ease';
    setTimeout(() => el.remove(), 220);
  }, 2600);
}

function debounce(fn, ms) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

/* Extrae metadata básica del nombre de archivo cuando no hay tags ID3 */
function guessFromFilename(filename) {
  const clean = filename.replace(/\.[^/.]+$/, '');
  const parts = clean.split(' - ').map((s) => s.trim());
  if (parts.length >= 2) {
    return { artist: parts[0], title: parts.slice(1).join(' - ') };
  }
  return { artist: 'Artista desconocido', title: clean };
}

/* ---------------------------------------------------------
   4. LECTURA DE METADATA ID3 (parser ligero, sin dependencias)
   Soporta ID3v2 (TIT2, TPE1, TALB, TCON, TYER/TDRC) y carátula (APIC).
--------------------------------------------------------- */
async function readId3Tags(file) {
  const result = { title: null, artist: null, album: null, genre: null, year: null, picture: null };
  try {
    const headerBuf = await file.slice(0, 10).arrayBuffer();
    const header = new Uint8Array(headerBuf);
    if (header[0] !== 0x49 || header[1] !== 0x44 || header[2] !== 0x33) {
      return result; // no es ID3v2
    }
    const size = ((header[6] & 0x7f) << 21) | ((header[7] & 0x7f) << 14) | ((header[8] & 0x7f) << 7) | (header[9] & 0x7f);
    const tagBuf = await file.slice(10, 10 + size).arrayBuffer();
    const bytes = new Uint8Array(tagBuf);
    let offset = 0;
    const version = header[3];

    while (offset < bytes.length - 10) {
      let frameId, frameSize, frameHeaderLen;
      if (version >= 3) {
        frameId = String.fromCharCode(bytes[offset], bytes[offset + 1], bytes[offset + 2], bytes[offset + 3]);
        if (version === 4) {
          frameSize = ((bytes[offset + 4] & 0x7f) << 21) | ((bytes[offset + 5] & 0x7f) << 14) | ((bytes[offset + 6] & 0x7f) << 7) | (bytes[offset + 7] & 0x7f);
        } else {
          frameSize = (bytes[offset + 4] << 24) | (bytes[offset + 5] << 16) | (bytes[offset + 6] << 8) | bytes[offset + 7];
        }
        frameHeaderLen = 10;
      } else {
        frameId = String.fromCharCode(bytes[offset], bytes[offset + 1], bytes[offset + 2]);
        frameSize = (bytes[offset + 3] << 16) | (bytes[offset + 4] << 8) | bytes[offset + 5];
        frameHeaderLen = 6;
      }
      if (!frameId || frameId.charCodeAt(0) === 0 || frameSize <= 0 || frameSize > bytes.length) break;

      const frameStart = offset + frameHeaderLen;
      const frameData = bytes.slice(frameStart, frameStart + frameSize);

      const textFrames = { TIT2: 'title', TT2: 'title', TPE1: 'artist', TP1: 'artist', TALB: 'album', TAL: 'album', TCON: 'genre', TCO: 'genre', TYER: 'year', TDRC: 'year', TYE: 'year' };
      if (textFrames[frameId] && frameData.length > 1) {
        result[textFrames[frameId]] = decodeId3Text(frameData);
      } else if ((frameId === 'APIC' || frameId === 'PIC') && !result.picture) {
        result.picture = decodeApic(frameData, frameId === 'PIC');
      }

      offset = frameStart + frameSize;
    }
  } catch (err) {
    console.warn('Error leyendo ID3:', err);
  }
  return result;
}

function decodeId3Text(data) {
  const encByte = data[0];
  let bytes = data.slice(1);
  let text = '';
  try {
    if (encByte === 1 || encByte === 2) {
      // UTF-16
      let start = 0;
      if (bytes[0] === 0xff && bytes[1] === 0xfe) { start = 2; text = new TextDecoder('utf-16le').decode(bytes.slice(start)); }
      else if (bytes[0] === 0xfe && bytes[1] === 0xff) { start = 2; text = new TextDecoder('utf-16be').decode(bytes.slice(start)); }
      else { text = new TextDecoder('utf-16le').decode(bytes); }
    } else {
      text = new TextDecoder(encByte === 3 ? 'utf-8' : 'iso-8859-1').decode(bytes);
    }
  } catch (e) { text = ''; }
  return text.replace(/\0/g, '').trim();
}

function decodeApic(data, isV2) {
  try {
    let offset = 1; // encoding byte
    let mime = '';
    if (isV2) {
      mime = String.fromCharCode(data[1], data[2], data[3]);
      offset = 4;
    } else {
      while (data[offset] !== 0 && offset < data.length) { mime += String.fromCharCode(data[offset]); offset++; }
      offset++; // skip null
    }
    offset++; // picture type byte
    while (data[offset] !== 0 && offset < data.length) offset++; // skip description
    offset++;
    const imgData = data.slice(offset);
    const mimeType = isV2 ? (mime === 'PNG' ? 'image/png' : 'image/jpeg') : (mime || 'image/jpeg');
    const blob = new Blob([imgData], { type: mimeType });
    return URL.createObjectURL(blob);
  } catch (e) {
    return null;
  }
}

/* Duración leyendo metadata de audio (rápido, no decodifica todo el archivo) */
function readDuration(file) {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const audio = new Audio();
    audio.preload = 'metadata';
    audio.onloadedmetadata = () => {
      resolve(audio.duration || 0);
      URL.revokeObjectURL(url);
    };
    audio.onerror = () => { resolve(0); URL.revokeObjectURL(url); };
    audio.src = url;
  });
}

/* ---------------------------------------------------------
   5. INDEXADO DE CARPETAS (File System Access API)
--------------------------------------------------------- */
const AUDIO_EXTENSIONS = ['.mp3', '.m4a', '.wav', '.ogg', '.flac', '.aac', '.opus'];

function isAudioFile(name) {
  const lower = name.toLowerCase();
  return AUDIO_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

async function pickAndIndexFolder(onProgress) {
  if (!window.showDirectoryPicker) {
    toast('Tu navegador no soporta selección de carpetas. Prueba con Chrome/Edge en Android.', 'error');
    return null;
  }
  let dirHandle;
  try {
    dirHandle = await window.showDirectoryPicker({ mode: 'read' });
  } catch (err) {
    if (err.name === 'AbortError') return null;
    throw err;
  }

  const folderId = Bejherro.utils.uid();
  await Bejherro.db.idbPut('folderHandles', { id: folderId, name: dirHandle.name, handle: dirHandle, isFavorite: false });

  await indexDirectoryHandle(dirHandle, dirHandle.name, onProgress);
  return dirHandle;
}

async function indexDirectoryHandle(dirHandle, folderPath, onProgress) {
  const entries = [];
  for await (const entry of dirHandle.values()) {
    entries.push(entry);
  }

  let count = 0;
  for (const entry of entries) {
    if (entry.kind === 'file' && isAudioFile(entry.name)) {
      count++;
      if (onProgress) onProgress({ current: count, name: entry.name, folder: folderPath });
      try {
        await indexAudioFile(entry, folderPath);
      } catch (err) {
        console.warn('No se pudo indexar', entry.name, err);
      }
    } else if (entry.kind === 'directory') {
      await indexDirectoryHandle(entry, `${folderPath}/${entry.name}`, onProgress);
    }
  }
}

async function indexAudioFile(fileHandle, folderPath) {
  const file = await fileHandle.getFile();
  const guessed = Bejherro.utils.guessFromFilename(file.name);
  const tags = await readId3Tags(file);
  const duration = await readDuration(file);

  const track = {
    id: Bejherro.utils.uid(),
    title: tags.title || guessed.title,
    artist: tags.artist || guessed.artist,
    album: tags.album || 'Álbum desconocido',
    genre: tags.genre || 'Sin género',
    year: tags.year || null,
    duration,
    size: file.size,
    codec: file.name.split('.').pop().toUpperCase(),
    dateAdded: Date.now(),
    folder: folderPath,
    fileName: file.name,
    fileHandle: fileHandle,
    picture: tags.picture || null,
    playCount: 0,
    lastPlayed: null,
    gain: 0, // ganancia manual en dB por canción
  };
  await Bejherro.db.idbPut('tracks', track);
  return track;
}

async function loadAllTracksFromDB() {
  const rows = await Bejherro.db.idbGetAll('tracks');
  state.tracks = rows;
  state.tracksById = new Map(rows.map((t) => [t.id, t]));
}

async function reindexAllFolders(onProgress) {
  const folders = await Bejherro.db.idbGetAll('folderHandles');
  for (const f of folders) {
    try {
      const perm = await f.handle.queryPermission({ mode: 'read' });
      if (perm !== 'granted') {
        const req = await f.handle.requestPermission({ mode: 'read' });
        if (req !== 'granted') continue;
      }
      await indexDirectoryHandle(f.handle, f.name, onProgress);
    } catch (err) {
      console.warn('No se pudo reindexar carpeta', f.name, err);
    }
  }
  await loadAllTracksFromDB();
}

window.Bejherro = {
  state,
  db: { idbGetAll, idbGet, idbPut, idbDelete, idbClear, kvGet, kvSet, getDB },
  utils: { uid, formatTime, formatBytes, escapeHtml, toast, debounce, guessFromFilename },
  library: { pickAndIndexFolder, indexDirectoryHandle, loadAllTracksFromDB, reindexAllFolders, isAudioFile },
};

/* ---------------------------------------------------------
   6. MOTOR DE AUDIO
   Un único elemento <audio> reutilizado. Controla cola, orden,
   repetición, shuffle, velocidad, y expone eventos al resto de la app.
--------------------------------------------------------- */
const audioEl = new Audio();
audioEl.preload = 'auto';

const listeners = { trackchange: [], timeupdate: [], playstate: [], queuechange: [] };
function on(event, cb) { (listeners[event] || (listeners[event] = [])).push(cb); }
function emit(event, payload) { (listeners[event] || []).forEach((cb) => cb(payload)); }

let objectUrlInUse = null;

async function loadTrackIntoAudio(track, autoplay = true) {
  if (objectUrlInUse) { URL.revokeObjectURL(objectUrlInUse); objectUrlInUse = null; }
  const file = await track.fileHandle.getFile();
  const url = URL.createObjectURL(file);
  objectUrlInUse = url;
  audioEl.src = url;
  audioEl.playbackRate = state.playbackRate;
  audioEl.volume = state.volume;
  if (autoplay) {
    try { await audioEl.play(); state.isPlaying = true; } catch (e) { state.isPlaying = false; }
  }
  emit('playstate', state.isPlaying);
}

async function playTrackById(trackId, queueContext = null) {
  const track = state.tracksById.get(trackId);
  if (!track) return;

  if (queueContext) {
    state.queue = queueContext.slice();
    state.queueIndex = state.queue.indexOf(trackId);
  } else if (!state.queue.includes(trackId)) {
    state.queue = [trackId];
    state.queueIndex = 0;
  } else {
    state.queueIndex = state.queue.indexOf(trackId);
  }

  state.currentTrack = track;
  await loadTrackIntoAudio(track, true);

  track.playCount = (track.playCount || 0) + 1;
  track.lastPlayed = Date.now();
  Bejherro.db.idbPut('tracks', track);

  emit('trackchange', track);
  updateMediaSession(track);
  persistPlaybackState();
}

function computeNextIndex(direction = 1) {
  if (state.queue.length === 0) return -1;
  if (state.shuffle) {
    if (direction > 0) {
      const remaining = state.queue
        .map((id, idx) => idx)
        .filter((idx) => !state.shuffleHistory.includes(idx));
      if (remaining.length === 0) {
        state.shuffleHistory = [];
        return Math.floor(Math.random() * state.queue.length);
      }
      return remaining[Math.floor(Math.random() * remaining.length)];
    } else {
      if (state.shuffleHistory.length > 0) return state.shuffleHistory.pop();
      return state.queueIndex;
    }
  }
  let next = state.queueIndex + direction;
  if (next >= state.queue.length) {
    if (state.repeatMode === 'all') next = 0;
    else return -1;
  } else if (next < 0) {
    next = state.queue.length - 1;
  }
  return next;
}

async function playNext(userInitiated = true) {
  if (state.repeatMode === 'one' && !userInitiated) {
    audioEl.currentTime = 0;
    audioEl.play();
    return;
  }
  if (state.shuffle) state.shuffleHistory.push(state.queueIndex);
  const nextIndex = computeNextIndex(1);
  if (nextIndex === -1) {
    if (state.repeatMode === 'stop-at-end' || !userInitiated) {
      state.isPlaying = false;
      emit('playstate', false);
      return;
    }
    return;
  }
  state.queueIndex = nextIndex;
  const trackId = state.queue[nextIndex];
  await playTrackById(trackId);
}

async function playPrev() {
  if (audioEl.currentTime > 3) {
    audioEl.currentTime = 0;
    return;
  }
  const prevIndex = computeNextIndex(-1);
  if (prevIndex === -1) return;
  state.queueIndex = prevIndex;
  const trackId = state.queue[prevIndex];
  await playTrackById(trackId);
}

function togglePlayPause() {
  if (!state.currentTrack) return;
  if (audioEl.paused) {
    audioEl.play();
    state.isPlaying = true;
  } else {
    audioEl.pause();
    state.isPlaying = false;
  }
  emit('playstate', state.isPlaying);
  persistPlaybackState();
}

function setPlaybackRate(rate) {
  state.playbackRate = rate;
  audioEl.playbackRate = rate;
  persistPlaybackState();
}

function setVolume(vol) {
  state.volume = vol;
  audioEl.volume = vol;
}

function seekTo(seconds) {
  audioEl.currentTime = seconds;
}

function cycleRepeatMode() {
  const order = ['off', 'all', 'one'];
  const idx = order.indexOf(state.repeatMode);
  state.repeatMode = order[(idx + 1) % order.length];
  persistPlaybackState();
  return state.repeatMode;
}

function toggleShuffle() {
  state.shuffle = !state.shuffle;
  state.shuffleHistory = [];
  persistPlaybackState();
  return state.shuffle;
}

audioEl.addEventListener('timeupdate', () => {
  emit('timeupdate', { currentTime: audioEl.currentTime, duration: audioEl.duration });
});
audioEl.addEventListener('ended', () => { playNext(false); });
audioEl.addEventListener('play', () => { state.isPlaying = true; emit('playstate', true); });
audioEl.addEventListener('pause', () => { state.isPlaying = false; emit('playstate', false); });

/* Guardar posición cada 5s para poder reanudar tras cerrar la app */
setInterval(() => {
  if (state.currentTrack && !audioEl.paused) persistPlaybackState();
}, 5000);

function persistPlaybackState() {
  Bejherro.db.kvSet('playbackState', {
    trackId: state.currentTrack ? state.currentTrack.id : null,
    currentTime: audioEl.currentTime || 0,
    playbackRate: state.playbackRate,
    volume: state.volume,
    queue: state.queue,
    queueIndex: state.queueIndex,
    shuffle: state.shuffle,
    repeatMode: state.repeatMode,
  });
}

async function restorePlaybackState() {
  const saved = await Bejherro.db.kvGet('playbackState');
  if (!saved || !saved.trackId) return false;
  const track = state.tracksById.get(saved.trackId);
  if (!track) return false;

  state.queue = saved.queue || [saved.trackId];
  state.queueIndex = saved.queueIndex ?? 0;
  state.shuffle = saved.shuffle || false;
  state.repeatMode = saved.repeatMode || 'off';
  state.playbackRate = saved.playbackRate || 1;
  state.volume = saved.volume ?? 1;
  state.currentTrack = track;

  await loadTrackIntoAudio(track, false);
  audioEl.currentTime = saved.currentTime || 0;
  audioEl.playbackRate = state.playbackRate;
  audioEl.volume = state.volume;

  emit('trackchange', track);
  updateMediaSession(track);
  return true;
}

/* ---------------------------------------------------------
   7. MEDIA SESSION API — controles en pantalla de bloqueo
--------------------------------------------------------- */
function updateMediaSession(track) {
  if (!('mediaSession' in navigator)) return;
  const artwork = track.picture
    ? [{ src: track.picture, sizes: '512x512', type: 'image/png' }]
    : [{ src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png' }];

  navigator.mediaSession.metadata = new MediaMetadata({
    title: track.title,
    artist: track.artist,
    album: track.album,
    artwork,
  });

  navigator.mediaSession.setActionHandler('play', () => togglePlayPause());
  navigator.mediaSession.setActionHandler('pause', () => togglePlayPause());
  navigator.mediaSession.setActionHandler('previoustrack', () => playPrev());
  navigator.mediaSession.setActionHandler('nexttrack', () => playNext(true));
  navigator.mediaSession.setActionHandler('seekto', (details) => {
    if (details.seekTime !== undefined) seekTo(details.seekTime);
  });
}

/* ---------------------------------------------------------
   8. TEMPORIZADOR DE APAGADO (sleep timer)
--------------------------------------------------------- */
function startSleepTimer(minutes) {
  clearSleepTimer();
  const endsAt = Date.now() + minutes * 60000;
  state.sleepTimer = { active: true, mode: 'minutes', endsAt, intervalId: null };
  state.sleepTimer.intervalId = setInterval(() => {
    if (Date.now() >= endsAt) {
      audioEl.pause();
      clearSleepTimer();
      Bejherro.utils.toast('Temporizador finalizado. Reproducción pausada.');
    }
  }, 1000);
}

function clearSleepTimer() {
  if (state.sleepTimer.intervalId) clearInterval(state.sleepTimer.intervalId);
  state.sleepTimer = { active: false, mode: null, endsAt: null, intervalId: null };
}

Bejherro.player = {
  on, emit, audioEl,
  playTrackById, playNext, playPrev, togglePlayPause,
  setPlaybackRate, setVolume, seekTo,
  cycleRepeatMode, toggleShuffle,
  restorePlaybackState, persistPlaybackState,
  startSleepTimer, clearSleepTimer,
};

/* ---------------------------------------------------------
   9. PLAYLISTS Y FAVORITOS
--------------------------------------------------------- */
async function loadPlaylistsAndFavorites() {
  state.playlists = await Bejherro.db.idbGetAll('playlists');
  const favRow = await Bejherro.db.kvGet('favorites', []);
  state.favorites = new Set(favRow);
}

async function toggleFavorite(trackId) {
  if (state.favorites.has(trackId)) state.favorites.delete(trackId);
  else state.favorites.add(trackId);
  await Bejherro.db.kvSet('favorites', Array.from(state.favorites));
  return state.favorites.has(trackId);
}

async function createPlaylist(name) {
  const playlist = { id: Bejherro.utils.uid(), name, trackIds: [], createdAt: Date.now() };
  await Bejherro.db.idbPut('playlists', playlist);
  state.playlists.push(playlist);
  return playlist;
}

async function addToPlaylist(playlistId, trackId) {
  const pl = state.playlists.find((p) => p.id === playlistId);
  if (!pl) return;
  if (!pl.trackIds.includes(trackId)) pl.trackIds.push(trackId);
  await Bejherro.db.idbPut('playlists', pl);
}

async function removeFromPlaylist(playlistId, trackId) {
  const pl = state.playlists.find((p) => p.id === playlistId);
  if (!pl) return;
  pl.trackIds = pl.trackIds.filter((id) => id !== trackId);
  await Bejherro.db.idbPut('playlists', pl);
}

async function deletePlaylist(playlistId) {
  await Bejherro.db.idbDelete('playlists', playlistId);
  state.playlists = state.playlists.filter((p) => p.id !== playlistId);
}

Bejherro.playlists = {
  loadPlaylistsAndFavorites, toggleFavorite, createPlaylist,
  addToPlaylist, removeFromPlaylist, deletePlaylist,
};

/* ---------------------------------------------------------
   10. SORTING / HELPERS DE LISTAS
--------------------------------------------------------- */
function sortTracks(tracks, by = 'title', dir = 'asc') {
  const sorted = [...tracks].sort((a, b) => {
    let va = a[by], vb = b[by];
    if (by === 'duration' || by === 'size' || by === 'dateAdded' || by === 'playCount') {
      va = va || 0; vb = vb || 0;
      return va - vb;
    }
    va = (va || '').toString().toLowerCase();
    vb = (vb || '').toString().toLowerCase();
    return va.localeCompare(vb, 'es');
  });
  return dir === 'desc' ? sorted.reverse() : sorted;
}

function groupBy(tracks, key) {
  const map = new Map();
  for (const t of tracks) {
    const k = t[key] || `Desconocido`;
    if (!map.has(k)) map.set(k, []);
    map.get(k).push(t);
  }
  return map;
}

Bejherro.sorting = { sortTracks, groupBy };

/* ---------------------------------------------------------
   11. RENDERIZADO DE PANTALLAS
--------------------------------------------------------- */
const screensEl = document.getElementById('screens');

function trackRowHtml(track, opts = {}) {
  const { showAlbum = true } = opts;
  const isPlaying = state.currentTrack && state.currentTrack.id === track.id;
  const isFav = state.favorites.has(track.id);
  const artHtml = track.picture
    ? `<img src="${track.picture}" alt="">`
    : `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>`;
  const eqHtml = isPlaying && state.isPlaying
    ? `<span class="mini-eq"><span></span><span></span><span></span></span>`
    : '';
  return `
    <div class="track-row ${isPlaying ? 'playing' : ''}" data-track-id="${track.id}">
      <div class="track-art">${artHtml}</div>
      <div class="track-info">
        <div class="track-title">${Bejherro.utils.escapeHtml(track.title)}</div>
        <div class="track-sub">${Bejherro.utils.escapeHtml(track.artist)}${showAlbum ? ' · ' + Bejherro.utils.escapeHtml(track.album) : ''}</div>
      </div>
      <div class="track-meta">
        ${eqHtml}
        <span>${Bejherro.utils.formatTime(track.duration)}</span>
      </div>
      <button class="track-fav ${isFav ? 'active' : ''}" data-fav-id="${track.id}" aria-label="Favorito" type="button">
        <svg viewBox="0 0 24 24" fill="${isFav ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="2"><path d="M20.8 4.6a5.5 5.5 0 00-7.8 0L12 5.6l-1-1a5.5 5.5 0 00-7.8 7.8l1 1L12 21l7.8-7.6 1-1a5.5 5.5 0 000-7.8z"/></svg>
      </button>
      <button class="track-more" data-more-id="${track.id}" aria-label="Más opciones" type="button">
        <svg viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="5" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="12" cy="19" r="2"/></svg>
      </button>
    </div>`;
}

function emptyStateHtml(icon, title, desc, ctaHtml = '') {
  return `
    <div class="empty-state">
      <div class="glyph">${icon}</div>
      <h3>${title}</h3>
      <p>${desc}</p>
      ${ctaHtml}
    </div>`;
}

const ICONS = {
  folder: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2V7z"/></svg>`,
  music: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>`,
  playlist: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M4 6h16M4 12h16M4 18h7"/><circle cx="19" cy="18" r="3"/></svg>`,
  search: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4.35-4.35"/></svg>`,
};

function renderScreen() {
  const screen = state.currentScreen;
  if (screen === 'home') renderHomeScreen();
  else if (screen === 'library') renderLibraryScreen();
  else if (screen === 'search') renderSearchScreen();
  else if (screen === 'playlists') renderPlaylistsScreen();
  else if (screen === 'settings') renderSettingsScreen();

  document.querySelectorAll('.nav-btn').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.screen === screen);
  });
  wireTrackRowEvents();
}

function renderHomeScreen() {
  if (state.tracks.length === 0) {
    screensEl.innerHTML = `
      <div class="screen">
        <div class="topbar">
          <div class="brand"><img src="icons/icon-192.png" alt="Bejherro"><span class="brand-name">Bejherro</span></div>
        </div>
        ${emptyStateHtml(
          ICONS.folder,
          'Tu biblioteca está vacía',
          'Selecciona una carpeta de tu dispositivo con música para empezar a escuchar.',
          `<button class="btn-brand" id="empty-pick-folder" type="button">Elegir carpeta de música</button>`
        )}
      </div>`;
    document.getElementById('empty-pick-folder').addEventListener('click', handlePickFolder);
    return;
  }

  const recent = Bejherro.sorting.sortTracks(state.tracks, 'dateAdded', 'desc').slice(0, 10);
  const mostPlayed = state.tracks.filter((t) => t.playCount > 0)
    .sort((a, b) => b.playCount - a.playCount).slice(0, 10);
  const favTracks = state.tracks.filter((t) => state.favorites.has(t.id)).slice(0, 10);

  screensEl.innerHTML = `
    <div class="screen">
      <div class="topbar">
        <div class="brand"><img src="icons/icon-192.png" alt="Bejherro"><span class="brand-name">Bejherro</span></div>
        <div class="header-actions">
          <button class="icon-btn" id="add-folder-btn" aria-label="Añadir carpeta" type="button">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 5v14M5 12h14"/></svg>
          </button>
        </div>
      </div>

      ${favTracks.length ? `
      <div class="section-row"><h2 class="section-title">Favoritos</h2></div>
      <div class="track-list">${favTracks.map((t) => trackRowHtml(t)).join('')}</div>
      ` : ''}

      ${mostPlayed.length ? `
      <div class="section-row"><h2 class="section-title">Más reproducidas</h2></div>
      <div class="track-list">${mostPlayed.slice(0, 6).map((t) => trackRowHtml(t)).join('')}</div>
      ` : ''}

      <div class="section-row"><h2 class="section-title">Añadidas recientemente</h2></div>
      <div class="track-list">${recent.map((t) => trackRowHtml(t)).join('')}</div>
    </div>`;

  document.getElementById('add-folder-btn').addEventListener('click', handlePickFolder);
}

function renderLibraryScreen() {
  const filter = state.libraryFilter || 'songs';
  screensEl.innerHTML = `
    <div class="screen">
      <div class="topbar">
        <h2 class="section-title" style="margin-bottom:0">Biblioteca</h2>
        <div class="header-actions">
          <button class="icon-btn" id="sort-btn" aria-label="Ordenar" type="button">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18M6 12h12M10 18h4"/></svg>
          </button>
          <button class="icon-btn" id="add-folder-btn-lib" aria-label="Añadir carpeta" type="button">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 5v14M5 12h14"/></svg>
          </button>
        </div>
      </div>
      <div class="chip-row" id="library-chips">
        <button class="chip ${filter === 'songs' ? 'active' : ''}" data-filter="songs" type="button">Canciones</button>
        <button class="chip ${filter === 'artists' ? 'active' : ''}" data-filter="artists" type="button">Artistas</button>
        <button class="chip ${filter === 'albums' ? 'active' : ''}" data-filter="albums" type="button">Álbumes</button>
        <button class="chip ${filter === 'genres' ? 'active' : ''}" data-filter="genres" type="button">Géneros</button>
        <button class="chip ${filter === 'folders' ? 'active' : ''}" data-filter="folders" type="button">Carpetas</button>
      </div>
      <div id="library-content"></div>
    </div>`;

  document.getElementById('add-folder-btn-lib').addEventListener('click', handlePickFolder);
  document.getElementById('sort-btn').addEventListener('click', openSortSheet);
  document.querySelectorAll('#library-chips .chip').forEach((chip) => {
    chip.addEventListener('click', () => {
      state.libraryFilter = chip.dataset.filter;
      renderScreen();
    });
  });

  renderLibraryContent(filter);
}

function renderLibraryContent(filter) {
  const container = document.getElementById('library-content');
  if (!container) return;

  if (state.tracks.length === 0) {
    container.innerHTML = emptyStateHtml(ICONS.music, 'Sin canciones todavía', 'Añade una carpeta con archivos de audio.');
    return;
  }

  const sorted = Bejherro.sorting.sortTracks(state.tracks, state.sortBy, state.sortDir);

  if (filter === 'songs') {
    container.innerHTML = `<div class="track-list">${sorted.map((t) => trackRowHtml(t)).join('')}</div>`;
  } else if (filter === 'artists') {
    const groups = Bejherro.sorting.groupBy(sorted, 'artist');
    const names = Array.from(groups.keys()).sort((a, b) => a.localeCompare(b, 'es'));
    container.innerHTML = `<div class="card-grid">${names.map((name) => `
      <div class="card" data-open-group="artist" data-group-value="${Bejherro.utils.escapeHtml(name)}">
        <div class="card-art round">${ICONS.music}</div>
        <div class="card-body">
          <div class="card-title">${Bejherro.utils.escapeHtml(name)}</div>
          <div class="card-sub">${groups.get(name).length} canciones</div>
        </div>
      </div>`).join('')}</div>`;
  } else if (filter === 'albums') {
    const groups = Bejherro.sorting.groupBy(sorted, 'album');
    const names = Array.from(groups.keys()).sort((a, b) => a.localeCompare(b, 'es'));
    container.innerHTML = `<div class="card-grid">${names.map((name) => {
      const tracks = groups.get(name);
      const art = tracks.find((t) => t.picture)?.picture;
      return `
      <div class="card" data-open-group="album" data-group-value="${Bejherro.utils.escapeHtml(name)}">
        <div class="card-art">${art ? `<img src="${art}" alt="">` : ICONS.music}</div>
        <div class="card-body">
          <div class="card-title">${Bejherro.utils.escapeHtml(name)}</div>
          <div class="card-sub">${Bejherro.utils.escapeHtml(tracks[0].artist)}</div>
        </div>
      </div>`;
    }).join('')}</div>`;
  } else if (filter === 'genres') {
    const groups = Bejherro.sorting.groupBy(sorted, 'genre');
    const names = Array.from(groups.keys()).sort((a, b) => a.localeCompare(b, 'es'));
    container.innerHTML = `<div class="card-grid">${names.map((name) => `
      <div class="card" data-open-group="genre" data-group-value="${Bejherro.utils.escapeHtml(name)}">
        <div class="card-art">${ICONS.music}</div>
        <div class="card-body">
          <div class="card-title">${Bejherro.utils.escapeHtml(name)}</div>
          <div class="card-sub">${groups.get(name).length} canciones</div>
        </div>
      </div>`).join('')}</div>`;
  } else if (filter === 'folders') {
    const groups = Bejherro.sorting.groupBy(sorted, 'folder');
    const names = Array.from(groups.keys()).sort((a, b) => a.localeCompare(b, 'es'));
    container.innerHTML = `<div class="track-list">${names.map((name) => `
      <div class="track-row" data-open-group="folder" data-group-value="${Bejherro.utils.escapeHtml(name)}">
        <div class="track-art">${ICONS.folder}</div>
        <div class="track-info">
          <div class="track-title">${Bejherro.utils.escapeHtml(name)}</div>
          <div class="track-sub">${groups.get(name).length} canciones</div>
        </div>
      </div>`).join('')}</div>`;
  }

  container.querySelectorAll('[data-open-group]').forEach((el) => {
    el.addEventListener('click', () => {
      openGroupDetail(el.dataset.openGroup, el.dataset.groupValue);
    });
  });
}

function openGroupDetail(groupType, value) {
  const fieldMap = { artist: 'artist', album: 'album', genre: 'genre', folder: 'folder' };
  const field = fieldMap[groupType];
  const tracks = state.tracks.filter((t) => (t[field] || 'Desconocido') === value);
  const sorted = Bejherro.sorting.sortTracks(tracks, 'title', 'asc');

  screensEl.innerHTML = `
    <div class="screen">
      <div class="topbar">
        <button class="icon-btn" id="group-back" type="button"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M15 18l-6-6 6-6"/></svg></button>
        <h2 class="section-title" style="margin-bottom:0">${Bejherro.utils.escapeHtml(value)}</h2>
        <div style="width:40px"></div>
      </div>
      <p style="color:var(--muted);font-size:13px;margin:-8px 0 16px;">${sorted.length} canciones</p>
      <div class="track-list">${sorted.map((t) => trackRowHtml(t, { showAlbum: groupType !== 'album' })).join('')}</div>
    </div>`;

  document.getElementById('group-back').addEventListener('click', renderScreen);
  wireTrackRowEvents(sorted.map((t) => t.id));
}

function renderSearchScreen() {
  screensEl.innerHTML = `
    <div class="screen">
      <div class="topbar">
        <h2 class="section-title" style="margin-bottom:0">Buscar</h2>
      </div>
      <input type="text" class="text-input" id="search-input" placeholder="Título, artista, álbum, género, año…" autocomplete="off">
      <div id="search-results"></div>
    </div>`;

  const input = document.getElementById('search-input');
  input.focus();
  input.addEventListener('input', Bejherro.utils.debounce(() => {
    runSearch(input.value.trim());
  }, 150));
}

function runSearch(query) {
  const resultsEl = document.getElementById('search-results');
  if (!query) {
    resultsEl.innerHTML = '';
    return;
  }
  const q = query.toLowerCase();
  const results = state.tracks.filter((t) => {
    return (
      (t.title || '').toLowerCase().includes(q) ||
      (t.artist || '').toLowerCase().includes(q) ||
      (t.album || '').toLowerCase().includes(q) ||
      (t.genre || '').toLowerCase().includes(q) ||
      (t.folder || '').toLowerCase().includes(q) ||
      (t.year && String(t.year).includes(q))
    );
  });

  if (results.length === 0) {
    resultsEl.innerHTML = emptyStateHtml(ICONS.search, 'Sin resultados', `No se encontró nada para "${Bejherro.utils.escapeHtml(query)}".`);
    return;
  }
  resultsEl.innerHTML = `<div class="track-list">${results.map((t) => trackRowHtml(t)).join('')}</div>`;
  wireTrackRowEvents(results.map((t) => t.id));
}

function renderPlaylistsScreen() {
  screensEl.innerHTML = `
    <div class="screen">
      <div class="topbar">
        <h2 class="section-title" style="margin-bottom:0">Listas</h2>
        <button class="icon-btn" id="new-playlist-btn" aria-label="Crear lista" type="button">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 5v14M5 12h14"/></svg>
        </button>
      </div>
      <div id="playlists-content"></div>
    </div>`;

  document.getElementById('new-playlist-btn').addEventListener('click', openCreatePlaylistModal);
  renderPlaylistsList();
}

function renderPlaylistsList() {
  const container = document.getElementById('playlists-content');
  if (!container) return;
  if (state.playlists.length === 0) {
    container.innerHTML = emptyStateHtml(
      ICONS.playlist, 'Aún no tienes listas',
      'Crea tu primera lista de reproducción para organizar tu música.',
      `<button class="btn-brand" id="empty-new-playlist" type="button">Crear lista</button>`
    );
    document.getElementById('empty-new-playlist').addEventListener('click', openCreatePlaylistModal);
    return;
  }
  container.innerHTML = `<div class="card-grid">${state.playlists.map((pl) => `
    <div class="card" data-open-playlist="${pl.id}">
      <div class="card-art">${ICONS.playlist}</div>
      <div class="card-body">
        <div class="card-title">${Bejherro.utils.escapeHtml(pl.name)}</div>
        <div class="card-sub">${pl.trackIds.length} canciones</div>
      </div>
    </div>`).join('')}</div>`;

  container.querySelectorAll('[data-open-playlist]').forEach((el) => {
    el.addEventListener('click', () => openPlaylistDetail(el.dataset.openPlaylist));
  });
}

function openPlaylistDetail(playlistId) {
  const pl = state.playlists.find((p) => p.id === playlistId);
  if (!pl) return;
  const tracks = pl.trackIds.map((id) => state.tracksById.get(id)).filter(Boolean);

  screensEl.innerHTML = `
    <div class="screen">
      <div class="topbar">
        <button class="icon-btn" id="pl-back" type="button"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M15 18l-6-6 6-6"/></svg></button>
        <h2 class="section-title" style="margin-bottom:0">${Bejherro.utils.escapeHtml(pl.name)}</h2>
        <button class="icon-btn" id="pl-delete" aria-label="Eliminar lista" type="button"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18M8 6V4a2 2 0 012-2h4a2 2 0 012 2v2m3 0l-1 14a2 2 0 01-2 2H7a2 2 0 01-2-2L4 6h16z"/></svg></button>
      </div>
      ${tracks.length ? `
        <button class="btn-brand" id="pl-play-all" style="margin-bottom:16px" type="button">Reproducir todo</button>
        <div class="track-list">${tracks.map((t) => trackRowHtml(t)).join('')}</div>
      ` : emptyStateHtml(ICONS.playlist, 'Lista vacía', 'Añade canciones desde el menú de opciones de cualquier pista.')}
    </div>`;

  document.getElementById('pl-back').addEventListener('click', renderScreen);
  document.getElementById('pl-delete').addEventListener('click', () => {
    showConfirmModal('Eliminar lista', `¿Seguro que quieres eliminar "${pl.name}"? Esta acción no se puede deshacer.`, async () => {
      await Bejherro.playlists.deletePlaylist(pl.id);
      Bejherro.utils.toast('Lista eliminada');
      renderScreen();
    });
  });
  const playAllBtn = document.getElementById('pl-play-all');
  if (playAllBtn) playAllBtn.addEventListener('click', () => {
    Bejherro.player.playTrackById(tracks[0].id, tracks.map((t) => t.id));
  });
  wireTrackRowEvents(tracks.map((t) => t.id));
}

function renderSettingsScreen() {
  screensEl.innerHTML = `
    <div class="screen">
      <div class="topbar">
        <h2 class="section-title" style="margin-bottom:0">Ajustes</h2>
      </div>

      <div class="section-row"><h3 style="font-size:14px;color:var(--muted);font-weight:600;">Biblioteca</h3></div>
      <div class="option-list" style="margin-bottom:24px;">
        <div class="option-row" id="settings-add-folder">
          <span class="label">${ICONS.folder} Añadir carpeta de música</span>
        </div>
        <div class="option-row" id="settings-rescan">
          <span class="label">${ICONS.music} Volver a escanear biblioteca</span>
        </div>
        <div class="option-row">
          <span class="label">Canciones indexadas</span>
          <span style="color:var(--muted);font-size:13.5px;">${state.tracks.length}</span>
        </div>
      </div>

      <div class="section-row"><h3 style="font-size:14px;color:var(--muted);font-weight:600;">Reproducción</h3></div>
      <div class="option-list" style="margin-bottom:24px;">
        <div class="option-row">
          <span class="label">Volumen</span>
        </div>
        <input type="range" class="std-slider" id="settings-volume" min="0" max="1" step="0.01" value="${state.volume}">
      </div>

      <div class="section-row"><h3 style="font-size:14px;color:var(--muted);font-weight:600;">Acerca de</h3></div>
      <div class="option-list">
        <div class="option-row">
          <span class="label"><img src="icons/icon-192.png" alt="" style="width:22px;height:22px;border-radius:6px;"> Bejherro</span>
          <span style="color:var(--muted);font-size:13px;">v1.0</span>
        </div>
      </div>
    </div>`;

  document.getElementById('settings-add-folder').addEventListener('click', handlePickFolder);
  document.getElementById('settings-rescan').addEventListener('click', handleRescan);
  document.getElementById('settings-volume').addEventListener('input', (e) => {
    Bejherro.player.setVolume(parseFloat(e.target.value));
  });
}

Bejherro.ui = { renderScreen, trackRowHtml, emptyStateHtml, ICONS, runSearch };

/* ---------------------------------------------------------
   12. MODALES Y SHEETS GENÉRICOS
--------------------------------------------------------- */
function showConfirmModal(title, desc, onConfirm) {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal-box">
      <h3>${Bejherro.utils.escapeHtml(title)}</h3>
      <p>${Bejherro.utils.escapeHtml(desc)}</p>
      <div class="modal-actions">
        <button class="btn-ghost" id="modal-cancel" type="button">Cancelar</button>
        <button class="btn-brand" id="modal-confirm" type="button">Confirmar</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);
  requestAnimationFrame(() => overlay.classList.add('open'));
  const close = () => { overlay.classList.remove('open'); setTimeout(() => overlay.remove(), 200); };
  overlay.querySelector('#modal-cancel').addEventListener('click', close);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
  overlay.querySelector('#modal-confirm').addEventListener('click', () => { onConfirm(); close(); });
}

function openCreatePlaylistModal() {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal-box">
      <h3>Nueva lista</h3>
      <p>Ponle un nombre a tu nueva lista de reproducción.</p>
      <input type="text" class="text-input" id="new-playlist-name" placeholder="Ej. Para el coche" autocomplete="off">
      <div class="modal-actions">
        <button class="btn-ghost" id="modal-cancel" type="button">Cancelar</button>
        <button class="btn-brand" id="modal-confirm" type="button">Crear</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);
  requestAnimationFrame(() => overlay.classList.add('open'));
  const input = overlay.querySelector('#new-playlist-name');
  setTimeout(() => input.focus(), 100);
  const close = () => { overlay.classList.remove('open'); setTimeout(() => overlay.remove(), 200); };
  overlay.querySelector('#modal-cancel').addEventListener('click', close);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
  const submit = async () => {
    const name = input.value.trim();
    if (!name) { input.focus(); return; }
    await Bejherro.playlists.createPlaylist(name);
    Bejherro.utils.toast('Lista creada');
    close();
    if (state.currentScreen === 'playlists') renderPlaylistsList();
  };
  overlay.querySelector('#modal-confirm').addEventListener('click', submit);
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });
}

function openAddToPlaylistSheet(trackId) {
  const sheet = createSheet('Añadir a lista', () => {
    if (state.playlists.length === 0) {
      return `${emptyStateHtml(ICONS.playlist, 'Sin listas', 'Crea una lista primero.')}`;
    }
    return `<div class="option-list">${state.playlists.map((pl) => `
      <div class="option-row" data-add-to-playlist="${pl.id}">
        <span class="label">${ICONS.playlist} ${Bejherro.utils.escapeHtml(pl.name)}</span>
        <span style="color:var(--muted);font-size:13px;">${pl.trackIds.includes(trackId) ? '✓' : ''}</span>
      </div>`).join('')}</div>
      <button class="btn-ghost" id="sheet-new-playlist" style="width:100%;margin-top:12px;" type="button">+ Crear nueva lista</button>`;
  });
  sheet.body.querySelectorAll('[data-add-to-playlist]').forEach((el) => {
    el.addEventListener('click', async () => {
      await Bejherro.playlists.addToPlaylist(el.dataset.addToPlaylist, trackId);
      Bejherro.utils.toast('Añadida a la lista');
      closeSheet();
    });
  });
  const newBtn = sheet.body.querySelector('#sheet-new-playlist');
  if (newBtn) newBtn.addEventListener('click', () => { closeSheet(); openCreatePlaylistModal(); });
}

function openSortSheet() {
  const options = [
    { by: 'title', label: 'Nombre' },
    { by: 'artist', label: 'Artista' },
    { by: 'album', label: 'Álbum' },
    { by: 'duration', label: 'Duración' },
    { by: 'dateAdded', label: 'Fecha de adición' },
    { by: 'size', label: 'Tamaño' },
    { by: 'year', label: 'Año' },
  ];
  const sheet = createSheet('Ordenar por', () => `
    <div class="option-list">${options.map((o) => `
      <div class="option-row ${state.sortBy === o.by ? 'selected' : ''}" data-sort-by="${o.by}">
        <span class="label">${o.label}</span>
        <svg class="check-mark" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20 6L9 17l-5-5"/></svg>
      </div>`).join('')}</div>
    <div class="field-row" style="margin-top:16px;">
      <div class="field-label"><span>Dirección</span></div>
      <div class="chip-row" style="margin-bottom:0;">
        <button class="chip ${state.sortDir === 'asc' ? 'active' : ''}" data-sort-dir="asc" type="button">Ascendente</button>
        <button class="chip ${state.sortDir === 'desc' ? 'active' : ''}" data-sort-dir="desc" type="button">Descendente</button>
      </div>
    </div>`);
  sheet.body.querySelectorAll('[data-sort-by]').forEach((el) => {
    el.addEventListener('click', () => {
      state.sortBy = el.dataset.sortBy;
      closeSheet();
      renderScreen();
    });
  });
  sheet.body.querySelectorAll('[data-sort-dir]').forEach((el) => {
    el.addEventListener('click', () => {
      state.sortDir = el.dataset.sortDir;
      closeSheet();
      renderScreen();
    });
  });
}

function openTrackOptionsSheet(trackId) {
  const track = state.tracksById.get(trackId);
  if (!track) return;
  const isFav = state.favorites.has(trackId);
  const sheet = createSheet(track.title, () => `
    <div class="option-list">
      <div class="option-row" data-action="play">
        <span class="label">${ICONS.music} Reproducir</span>
      </div>
      <div class="option-row" data-action="add-queue">
        <span class="label">${ICONS.playlist} Añadir a la cola</span>
      </div>
      <div class="option-row" data-action="add-playlist">
        <span class="label">${ICONS.playlist} Añadir a lista</span>
      </div>
      <div class="option-row" data-action="favorite">
        <span class="label">♥ ${isFav ? 'Quitar de favoritos' : 'Añadir a favoritos'}</span>
      </div>
      <div class="option-row" data-action="info">
        <span class="label">ℹ️ Información técnica</span>
      </div>
    </div>`);
  sheet.body.querySelector('[data-action="play"]').addEventListener('click', () => {
    closeSheet();
    Bejherro.player.playTrackById(trackId, state.tracks.map((t) => t.id));
  });
  sheet.body.querySelector('[data-action="add-queue"]').addEventListener('click', () => {
    if (!state.queue.includes(trackId)) state.queue.push(trackId);
    Bejherro.utils.toast('Añadida a la cola');
    closeSheet();
  });
  sheet.body.querySelector('[data-action="add-playlist"]').addEventListener('click', () => {
    closeSheet();
    setTimeout(() => openAddToPlaylistSheet(trackId), 250);
  });
  sheet.body.querySelector('[data-action="favorite"]').addEventListener('click', async () => {
    await Bejherro.playlists.toggleFavorite(trackId);
    closeSheet();
    renderScreen();
  });
  sheet.body.querySelector('[data-action="info"]').addEventListener('click', () => {
    closeSheet();
    setTimeout(() => openTrackInfoSheet(trackId), 250);
  });
}

function openTrackInfoSheet(trackId) {
  const t = state.tracksById.get(trackId);
  if (!t) return;
  const rows = [
    ['Título', t.title], ['Artista', t.artist], ['Álbum', t.album],
    ['Género', t.genre], ['Año', t.year || '—'],
    ['Duración', Bejherro.utils.formatTime(t.duration)],
    ['Tamaño', Bejherro.utils.formatBytes(t.size)],
    ['Codec', t.codec], ['Carpeta', t.folder],
    ['Reproducciones', t.playCount || 0],
  ];
  createSheet('Información técnica', () => `
    <div class="option-list">${rows.map(([label, val]) => `
      <div class="option-row">
        <span class="label">${label}</span>
        <span style="color:var(--muted);font-size:13px;max-width:60%;text-align:right;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${Bejherro.utils.escapeHtml(String(val))}</span>
      </div>`).join('')}</div>`);
}

function openSpeedSheet() {
  const speeds = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2];
  const sheet = createSheet('Velocidad de reproducción', () => `
    <div class="option-list">${speeds.map((s) => `
      <div class="option-row ${state.playbackRate === s ? 'selected' : ''}" data-speed="${s}">
        <span class="label">${s}x ${s === 1 ? '(Normal)' : ''}</span>
        <svg class="check-mark" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20 6L9 17l-5-5"/></svg>
      </div>`).join('')}</div>`);
  sheet.body.querySelectorAll('[data-speed]').forEach((el) => {
    el.addEventListener('click', () => {
      Bejherro.player.setPlaybackRate(parseFloat(el.dataset.speed));
      updateNowPlayingUI();
      closeSheet();
    });
  });
}

function openRepeatSheet() {
  const modes = [
    { mode: 'off', label: 'Sin repetición' },
    { mode: 'all', label: 'Repetir lista' },
    { mode: 'one', label: 'Repetir canción' },
    { mode: 'stop-at-end', label: 'Reproducir hasta el final y parar' },
  ];
  const sheet = createSheet('Modo de repetición', () => `
    <div class="option-list">${modes.map((m) => `
      <div class="option-row ${state.repeatMode === m.mode ? 'selected' : ''}" data-repeat-mode="${m.mode}">
        <span class="label">${m.label}</span>
        <svg class="check-mark" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20 6L9 17l-5-5"/></svg>
      </div>`).join('')}</div>`);
  sheet.body.querySelectorAll('[data-repeat-mode]').forEach((el) => {
    el.addEventListener('click', () => {
      state.repeatMode = el.dataset.repeatMode;
      Bejherro.player.persistPlaybackState();
      updateRepeatButtonUI();
      closeSheet();
    });
  });
}

function openTimerSheet() {
  const options = [10, 15, 30, 45, 60, 90];
  const sheet = createSheet('Temporizador de apagado', () => `
    ${state.sleepTimer.active ? `
      <p style="color:var(--muted);font-size:13.5px;margin-bottom:14px;">
        Activo — se detendrá en <strong style="color:var(--ink)">${Math.max(0, Math.ceil((state.sleepTimer.endsAt - Date.now()) / 60000))} min</strong>
      </p>
      <button class="btn-ghost" id="timer-cancel" style="width:100%;margin-bottom:16px;" type="button">Cancelar temporizador</button>
    ` : ''}
    <div class="option-list">${options.map((min) => `
      <div class="option-row" data-timer-min="${min}">
        <span class="label">${min} minutos</span>
      </div>`).join('')}</div>`);
  const cancelBtn = sheet.body.querySelector('#timer-cancel');
  if (cancelBtn) cancelBtn.addEventListener('click', () => {
    Bejherro.player.clearSleepTimer();
    Bejherro.utils.toast('Temporizador cancelado');
    closeSheet();
  });
  sheet.body.querySelectorAll('[data-timer-min]').forEach((el) => {
    el.addEventListener('click', () => {
      const min = parseInt(el.dataset.timerMin, 10);
      Bejherro.player.startSleepTimer(min);
      Bejherro.utils.toast(`Temporizador activado: ${min} minutos`);
      closeSheet();
    });
  });
}

function openQueueSheet() {
  const sheet = createSheet('Cola de reproducción', () => {
    if (state.queue.length === 0) return emptyStateHtml(ICONS.playlist, 'Cola vacía', 'Reproduce una canción para ver la cola aquí.');
    const tracks = state.queue.map((id) => state.tracksById.get(id)).filter(Boolean);
    return `<div class="track-list">${tracks.map((t, i) => `
      <div class="track-row ${i === state.queueIndex ? 'playing' : ''}" data-queue-track-id="${t.id}" data-queue-index="${i}">
        <div class="track-art">${t.picture ? `<img src="${t.picture}" alt="">` : ICONS.music}</div>
        <div class="track-info">
          <div class="track-title">${Bejherro.utils.escapeHtml(t.title)}</div>
          <div class="track-sub">${Bejherro.utils.escapeHtml(t.artist)}</div>
        </div>
        <span style="color:var(--muted);font-size:12px;">${Bejherro.utils.formatTime(t.duration)}</span>
      </div>`).join('')}</div>`;
  });
  sheet.body.querySelectorAll('[data-queue-track-id]').forEach((el) => {
    el.addEventListener('click', () => {
      state.queueIndex = parseInt(el.dataset.queueIndex, 10);
      Bejherro.player.playTrackById(el.dataset.queueTrackId);
      closeSheet();
    });
  });
}

let activeSheet = null;
function createSheet(title, bodyRenderFn) {
  closeSheet();
  const overlay = document.getElementById('sheet-overlay');
  const sheet = document.createElement('div');
  sheet.className = 'sheet';
  sheet.innerHTML = `
    <div class="sheet-handle"></div>
    <div class="sheet-header"><h3>${Bejherro.utils.escapeHtml(title)}</h3>
      <button class="icon-btn" id="sheet-close" aria-label="Cerrar" type="button"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 6l12 12M18 6L6 18"/></svg></button>
    </div>
    <div class="sheet-body"></div>`;
  document.body.appendChild(sheet);
  const bodyEl = sheet.querySelector('.sheet-body');
  bodyEl.innerHTML = bodyRenderFn();
  sheet.querySelector('#sheet-close').addEventListener('click', closeSheet);
  overlay.classList.add('open');
  overlay.onclick = closeSheet;
  requestAnimationFrame(() => sheet.classList.add('open'));
  activeSheet = sheet;
  return { el: sheet, body: bodyEl };
}

function closeSheet() {
  const overlay = document.getElementById('sheet-overlay');
  overlay.classList.remove('open');
  if (activeSheet) {
    activeSheet.classList.remove('open');
    const toRemove = activeSheet;
    setTimeout(() => toRemove.remove(), 250);
    activeSheet = null;
  }
}

/* ---------------------------------------------------------
   13. EVENTOS DE FILAS DE PISTA (delegación)
--------------------------------------------------------- */
function wireTrackRowEvents(contextIds = null) {
  document.querySelectorAll('.track-row[data-track-id]').forEach((row) => {
    row.addEventListener('click', (e) => {
      if (e.target.closest('[data-fav-id]') || e.target.closest('[data-more-id]')) return;
      const trackId = row.dataset.trackId;
      const ids = contextIds || Array.from(document.querySelectorAll('.track-row[data-track-id]')).map((r) => r.dataset.trackId);
      Bejherro.player.playTrackById(trackId, ids);
    });
  });
  document.querySelectorAll('[data-fav-id]').forEach((btn) => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      await Bejherro.playlists.toggleFavorite(btn.dataset.favId);
      const isFav = state.favorites.has(btn.dataset.favId);
      btn.classList.toggle('active', isFav);
      btn.querySelector('svg').setAttribute('fill', isFav ? 'currentColor' : 'none');
    });
  });
  document.querySelectorAll('[data-more-id]').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      openTrackOptionsSheet(btn.dataset.moreId);
    });
  });
}

/* ---------------------------------------------------------
   14. INDEXADO — MODAL DE PROGRESO
--------------------------------------------------------- */
async function handlePickFolder() {
  const progressOverlay = document.createElement('div');
  progressOverlay.className = 'modal-overlay open';
  progressOverlay.innerHTML = `
    <div class="modal-box" style="text-align:center;">
      <h3 id="progress-title">Explorando carpeta…</h3>
      <div class="loading-spinner"></div>
      <p id="progress-detail">Preparando…</p>
    </div>`;
  document.body.appendChild(progressOverlay);

  try {
    const handle = await Bejherro.library.pickAndIndexFolder(({ current, name }) => {
      progressOverlay.querySelector('#progress-detail').textContent = `${current} · ${name}`;
    });
    progressOverlay.remove();
    if (handle) {
      await Bejherro.library.loadAllTracksFromDB();
      await Bejherro.playlists.loadPlaylistsAndFavorites();
      Bejherro.utils.toast(`Carpeta "${handle.name}" añadida`, 'success');
      renderScreen();
      updateMiniPlayerVisibility();
    }
  } catch (err) {
    progressOverlay.remove();
    console.error(err);
    Bejherro.utils.toast('No se pudo leer la carpeta seleccionada', 'error');
  }
}

async function handleRescan() {
  const progressOverlay = document.createElement('div');
  progressOverlay.className = 'modal-overlay open';
  progressOverlay.innerHTML = `
    <div class="modal-box" style="text-align:center;">
      <h3>Reescaneando biblioteca…</h3>
      <div class="loading-spinner"></div>
      <p id="progress-detail">Preparando…</p>
    </div>`;
  document.body.appendChild(progressOverlay);
  try {
    await Bejherro.library.reindexAllFolders(({ current, name }) => {
      progressOverlay.querySelector('#progress-detail').textContent = `${current} · ${name}`;
    });
    progressOverlay.remove();
    Bejherro.utils.toast('Biblioteca actualizada', 'success');
    renderScreen();
  } catch (err) {
    progressOverlay.remove();
    console.error(err);
    Bejherro.utils.toast('Error al reescanear', 'error');
  }
}

Bejherro.modals = { showConfirmModal, openCreatePlaylistModal, openTrackOptionsSheet, closeSheet };

/* ---------------------------------------------------------
   15. MINI REPRODUCTOR Y REPRODUCTOR A PANTALLA COMPLETA
--------------------------------------------------------- */
const miniPlayerEl = document.getElementById('mini-player');
const nowPlayingEl = document.getElementById('now-playing');

function updateMiniPlayerVisibility() {
  if (state.currentTrack) miniPlayerEl.classList.remove('hidden');
}

function updateMiniPlayerUI() {
  const t = state.currentTrack;
  if (!t) return;
  document.getElementById('mini-title').textContent = t.title;
  document.getElementById('mini-artist').textContent = t.artist;
  const artEl = document.getElementById('mini-art');
  artEl.innerHTML = t.picture
    ? `<img src="${t.picture}" alt="">`
    : `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>`;
  updateMiniPlayPauseIcon();
}

function updateMiniPlayPauseIcon() {
  const btn = document.getElementById('mini-play');
  btn.innerHTML = state.isPlaying
    ? `<svg viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="5" width="4" height="14" rx="1"/><rect x="14" y="5" width="4" height="14" rx="1"/></svg>`
    : `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>`;
}

function updateNowPlayingUI() {
  const t = state.currentTrack;
  if (!t) return;
  document.getElementById('np-title').textContent = t.title;
  document.getElementById('np-artist').textContent = t.artist;
  document.getElementById('np-caption').textContent = state.queue.length > 1 ? `Reproduciendo · ${state.queueIndex + 1} de ${state.queue.length}` : 'Reproduciendo';

  const artEl = document.getElementById('np-art');
  artEl.innerHTML = t.picture
    ? `<img src="${t.picture}" alt="">`
    : `<div class="placeholder"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg></div>`;
  artEl.classList.toggle('spinning', state.isPlaying);

  document.getElementById('np-bg').style.background = t.picture
    ? `linear-gradient(160deg, rgba(140,57,189,0.35), rgba(251,123,0,0.25))`
    : 'var(--brand-gradient-soft)';

  document.getElementById('np-speed-label').textContent = `${state.playbackRate}x`;
  document.getElementById('np-favorite').classList.toggle('active', state.favorites.has(t.id));

  updateNpPlayPauseIcon();
  updateShuffleButtonUI();
  updateRepeatButtonUI();
}

function updateNpPlayPauseIcon() {
  const btn = document.getElementById('np-play');
  btn.innerHTML = state.isPlaying
    ? `<svg viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="5" width="4" height="14" rx="1"/><rect x="14" y="5" width="4" height="14" rx="1"/></svg>`
    : `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>`;
  document.getElementById('np-art').classList.toggle('spinning', state.isPlaying);
}

function updateShuffleButtonUI() {
  document.getElementById('np-shuffle').classList.toggle('active', state.shuffle);
}

function updateRepeatButtonUI() {
  const btn = document.getElementById('np-repeat');
  const badge = document.getElementById('np-repeat-badge');
  btn.classList.toggle('active', state.repeatMode !== 'off');
  if (state.repeatMode === 'one') {
    badge.textContent = '1';
    badge.classList.remove('hidden');
  } else if (state.repeatMode === 'stop-at-end') {
    badge.textContent = '■';
    badge.classList.remove('hidden');
  } else {
    badge.classList.add('hidden');
  }
}

function openNowPlaying() {
  if (!state.currentTrack) return;
  updateNowPlayingUI();
  nowPlayingEl.classList.add('open');
}
function closeNowPlaying() {
  nowPlayingEl.classList.remove('open');
}

/* Progreso — mini player y pantalla completa */
Bejherro.player.on('timeupdate', ({ currentTime, duration }) => {
  const pct = duration ? (currentTime / duration) * 100 : 0;
  document.getElementById('mini-progress').style.width = pct + '%';

  if (nowPlayingEl.classList.contains('open') && !seekDragging) {
    document.getElementById('np-seek').value = pct;
    document.getElementById('np-time-current').textContent = Bejherro.utils.formatTime(currentTime);
    document.getElementById('np-time-total').textContent = Bejherro.utils.formatTime(duration);
  }
});

Bejherro.player.on('trackchange', () => {
  updateMiniPlayerUI();
  updateMiniPlayerVisibility();
  if (nowPlayingEl.classList.contains('open')) updateNowPlayingUI();
  if (['home', 'library', 'search', 'playlists'].includes(state.currentScreen)) renderScreen();
});

Bejherro.player.on('playstate', () => {
  updateMiniPlayPauseIcon();
  updateNpPlayPauseIcon();
});

let seekDragging = false;

function wirePlayerControls() {
  document.getElementById('mini-play').addEventListener('click', (e) => { e.stopPropagation(); Bejherro.player.togglePlayPause(); });
  document.getElementById('mini-prev').addEventListener('click', (e) => { e.stopPropagation(); Bejherro.player.playPrev(); });
  document.getElementById('mini-next').addEventListener('click', (e) => { e.stopPropagation(); Bejherro.player.playNext(true); });
  miniPlayerEl.addEventListener('click', openNowPlaying);

  document.getElementById('np-close').addEventListener('click', closeNowPlaying);
  document.getElementById('np-play').addEventListener('click', () => Bejherro.player.togglePlayPause());
  document.getElementById('np-prev').addEventListener('click', () => Bejherro.player.playPrev());
  document.getElementById('np-next').addEventListener('click', () => Bejherro.player.playNext(true));
  document.getElementById('np-shuffle').addEventListener('click', () => { Bejherro.player.toggleShuffle(); updateShuffleButtonUI(); });
  document.getElementById('np-repeat').addEventListener('click', openRepeatSheet);
  document.getElementById('np-favorite').addEventListener('click', async () => {
    if (!state.currentTrack) return;
    await Bejherro.playlists.toggleFavorite(state.currentTrack.id);
    updateNowPlayingUI();
  });
  document.getElementById('np-speed').addEventListener('click', openSpeedSheet);
  document.getElementById('np-timer').addEventListener('click', openTimerSheet);
  document.getElementById('np-queue').addEventListener('click', openQueueSheet);
  document.getElementById('np-more').addEventListener('click', () => {
    if (state.currentTrack) openTrackOptionsSheet(state.currentTrack.id);
  });

  const seekSlider = document.getElementById('np-seek');
  seekSlider.addEventListener('input', () => { seekDragging = true; });
  seekSlider.addEventListener('change', () => {
    const duration = audioEl.duration || 0;
    Bejherro.player.seekTo((seekSlider.value / 100) * duration);
    seekDragging = false;
  });
}

/* ---------------------------------------------------------
   16. NAVEGACIÓN INFERIOR
--------------------------------------------------------- */
function wireBottomNav() {
  document.querySelectorAll('.nav-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.currentScreen = btn.dataset.screen;
      renderScreen();
      screensEl.scrollTop = 0;
    });
  });
}

/* ---------------------------------------------------------
   17. REGISTRO DEL SERVICE WORKER
--------------------------------------------------------- */
function registerServiceWorker() {
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('sw.js').catch((err) => {
        console.warn('No se pudo registrar el service worker:', err);
      });
    });
  }
}

/* ---------------------------------------------------------
   18. ACCIONES DESDE ACCESOS DIRECTOS DE LA PWA
--------------------------------------------------------- */
function handleShortcutAction() {
  const params = new URLSearchParams(window.location.search);
  const action = params.get('action');
  if (!action) return;

  if (action === 'play-favorites') {
    const favTracks = state.tracks.filter((t) => state.favorites.has(t.id));
    if (favTracks.length) Bejherro.player.playTrackById(favTracks[0].id, favTracks.map((t) => t.id));
  } else if (action === 'shuffle-all') {
    if (state.tracks.length) {
      state.shuffle = true;
      const ids = state.tracks.map((t) => t.id);
      Bejherro.player.playTrackById(ids[Math.floor(Math.random() * ids.length)], ids);
    }
  }
  // 'resume' no necesita acción extra: restorePlaybackState ya se ejecuta siempre.
  window.history.replaceState({}, '', window.location.pathname);
}

/* ---------------------------------------------------------
   19. BOOTSTRAP
--------------------------------------------------------- */
async function initApp() {
  const splashStart = Date.now();
  registerServiceWorker();
  wirePlayerControls();
  wireBottomNav();

  await Bejherro.library.loadAllTracksFromDB();
  await Bejherro.playlists.loadPlaylistsAndFavorites();

  const restored = await Bejherro.player.restorePlaybackState();
  if (restored) updateMiniPlayerVisibility();

  renderScreen();
  handleShortcutAction();

  hideSplash(splashStart);
}

/* Splash propio: se muestra un mínimo de 2s para que la marca respire,
   y como máximo 5s por si algo se retrasa. Al terminar, el logo "vuela"
   (técnica FLIP) desde el centro del splash hasta su sitio en la cabecera
   de Inicio, y el resto del splash (texto, puntos) se desvanece a la vez. */
function hideSplash(startedAt) {
  const splashEl = document.getElementById('splash');
  if (!splashEl) return;
  const elapsed = Date.now() - startedAt;
  const minVisible = 2000;
  const wait = Math.max(0, minVisible - elapsed);
  setTimeout(() => flySplashLogoToHeader(splashEl), wait);
}

function flySplashLogoToHeader(splashEl) {
  const logoWrap = splashEl.querySelector('.splash-logo-wrap');
  const target = document.querySelector('.brand img');
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  const finish = () => {
    splashEl.classList.add('hide');
    setTimeout(() => splashEl.remove(), 450);
  };

  if (!logoWrap || !target || reduceMotion) {
    finish();
    return;
  }

  // 1. FIRST: posición y tamaño actuales del logo dentro del flujo del splash.
  const startRect = logoWrap.getBoundingClientRect();

  // 2. Sacar el logo del flujo normal y fijarlo con coordenadas absolutas,
  //    exactamente donde ya estaba, para poder animarlo con position:fixed.
  logoWrap.style.left = startRect.left + 'px';
  logoWrap.style.top = startRect.top + 'px';
  logoWrap.style.width = startRect.width + 'px';
  logoWrap.style.height = startRect.height + 'px';
  logoWrap.style.margin = '0';
  splashEl.classList.add('flying');

  requestAnimationFrame(() => {
    // 3. LAST: posición y tamaño reales del logo pequeño de la cabecera.
    const endRect = target.getBoundingClientRect();

    // 4. PLAY: transicionamos hacia las coordenadas/tamaño de destino;
    //    las transitions ya declaradas en CSS para .splash-logo-wrap
    //    (top/left via transform, width, height, border-radius) hacen el resto.
    const deltaX = endRect.left - startRect.left;
    const deltaY = endRect.top - startRect.top;
    logoWrap.style.transform = `translate(${deltaX}px, ${deltaY}px)`;
    logoWrap.style.width = endRect.width + 'px';
    logoWrap.style.height = endRect.height + 'px';
  });

  // 5. Al terminar la transición del logo, ocultamos el splash entero.
  let done = false;
  const onEnd = (e) => {
    if (e.propertyName !== 'transform' || done) return;
    done = true;
    logoWrap.removeEventListener('transitionend', onEnd);
    finish();
  };
  logoWrap.addEventListener('transitionend', onEnd);
  // Salvaguarda por si transitionend no dispara (p.ej. pestaña en segundo plano).
  setTimeout(() => { if (!done) { done = true; finish(); } }, 750);
}

document.addEventListener('DOMContentLoaded', () => {
  // Salvaguarda: si algo falla en initApp, no dejar el splash bloqueado para siempre.
  const failSafe = setTimeout(() => {
    const splashEl = document.getElementById('splash');
    if (splashEl) { splashEl.classList.add('hide'); setTimeout(() => splashEl.remove(), 450); }
  }, 6000);

  initApp().finally(() => clearTimeout(failSafe));
});
