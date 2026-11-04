(function(){
'use strict';

/* =====================================================================
   My Love For You — front-end (vanilla JS, no framework)
   Sections: config · assets · storage · api · state · cursor cluster ·
             photos · screens · player · init
   ===================================================================== */

/* ---------- config ---------- */
const MIN_SONGS = 1;
const MAX_SONGS = 10;
const MAX_PHOTOS = 5;
const MAX_MESSAGE = 10000;
const PHOTO_MAX_DIM = 1024;           // longest edge after client-side resize
const PHOTO_QUALITY = 0.8;
const PHOTO_MAX_BYTES = 1500000;      // matches the server limit
const PHOTO_MAX_INPUT_BYTES = 30 * 1024 * 1024;
const PHOTO_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
const CODE_LEN = 20;
const CODE_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const LETTER_ART_W = 421;             // native width of letter-page.png
const LETTER_ART_H = 593;
const LETTER_STEP = 128;              // rows added per extension step (2 x 64)
const LETTER_CAP0 = LETTER_ART_H - 89 - 47; // writing-area height at the artwork's natural size

const app = document.getElementById('app');
const toastEl = document.getElementById('toast');

/* ---------- asset helpers ---------- */
// The build step fingerprints every asset and embeds a path -> hashed-path manifest in the page.
let MANIFEST = {};
try{
  const m = document.getElementById('asset-manifest');
  if(m) MANIFEST = JSON.parse(m.textContent || '{}');
}catch(e){ MANIFEST = {}; }
const A = (p)=> MANIFEST[p] || ('/' + p);
// Remote media must be https. Exception: when the page itself is served from localhost (local dev/tests),
// plain-http localhost URLs are accepted so the local storage stand-in works. Never true on the live site.
const DEV_HOST = /^(localhost|127\.0\.0\.1)$/.test(location.hostname);
const okRemote = (u)=> typeof u === 'string' && (/^https:\/\//.test(u) || (DEV_HOST && /^http:\/\/(127\.0\.0\.1|localhost)[:/]/.test(u)));

// natural pixel size of the original artwork (used for width/height attributes => no layout shift)
const IMG_DIMS = {
  'frame':[1792,878], 'corner-vine':[374,666], 'corner-vine-left':[940,1672],
  'cursor-1':[500,500], 'cursor-2':[1402,1122], 'cursor-3':[506,494],
  'cursor-4':[415,602], 'cursor-5':[550,454], 'cursor-6':[547,456],
  'envelope-closed':[577,432], 'envelope-open':[421,593],
  'vinyl-record':[500,500], 'angel':[426,586], 'minstrel':[432,577],
  'letter-top':[421,296], 'letter-bottom':[421,297]
};
const IMG_WIDTHS = {
  'frame':[520,1040], 'corner-vine':[280,374], 'corner-vine-left':[360,520],
  'cursor-1':[128,256], 'cursor-2':[128,256], 'cursor-3':[128,256],
  'cursor-4':[128,256], 'cursor-5':[128,256], 'cursor-6':[128,256],
  'envelope-closed':[400,577], 'envelope-open':[421],
  'vinyl-record':[256,440], 'angel':[240,360], 'minstrel':[260,390],
  'letter-top':[421], 'letter-bottom':[421]
};

/** <picture> with AVIF -> WebP -> PNG sources and a width-based srcset. */
function pic(name, o){
  o = o || {};
  const widths = IMG_WIDTHS[name];
  const dims = IMG_DIMS[name];
  const set = (ext)=> widths.map(w=> A('img/'+name+'-'+w+'.'+ext) + ' ' + w + 'w').join(', ');
  const sizes = o.sizes || (widths[widths.length-1] + 'px');
  const picture = document.createElement('picture');
  ['avif','webp'].forEach(ext=>{
    const s = document.createElement('source');
    s.type = 'image/' + ext;
    s.srcset = set(ext);
    s.sizes = sizes;
    picture.appendChild(s);
  });
  const img = document.createElement('img');
  picture.appendChild(img);              // attach to <picture> first so only the chosen source is fetched
  img.alt = o.alt || '';
  if(o.cls) img.className = o.cls;
  if(dims){ img.width = dims[0]; img.height = dims[1]; }
  img.decoding = 'async';
  if(o.lazy) img.loading = 'lazy';
  if(o.priority) img.setAttribute('fetchpriority', o.priority);
  if(o.hidden) img.setAttribute('aria-hidden','true');
  img.sizes = sizes;
  img.srcset = set('png');
  img.src = A('img/'+name+'-'+widths[widths.length-1]+'.png');
  return picture;
}

// Keep references so warmed images stay in the memory cache until used.
const warmed = {};
function warm(name, sizes){
  if(warmed[name+sizes]) return;
  try{
    const p = pic(name, {sizes: sizes, priority:'low'});
    warmed[name+sizes] = p;      // detached <picture><img>: the browser still selects a source and fetches it
  }catch(e){}
}
function idle(fn){
  if('requestIdleCallback' in window) requestIdleCallback(fn, {timeout: 2500});
  else setTimeout(fn, 600);
}
const ENV_SIZES = '(max-width:560px) 60px, (max-width:914px) 14vw, 128px';
const ENV_CLOSED_SIZES = '(max-width:476px) 84vw, 400px';
const ENV_OPEN_SIZES = '(max-width:488px) 90vw, 440px';

/* ---------- misc helpers ---------- */
function randomToken(bytes){
  const a = new Uint8Array(bytes);
  crypto.getRandomValues(a);
  let s = '';
  a.forEach(b=> s += String.fromCharCode(b));
  return btoa(s).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
}
function showToast(msg){
  if(!toastEl) return;
  toastEl.textContent = msg || 'Copied!';
  toastEl.classList.add('show');
  clearTimeout(showToast._t);
  showToast._t = setTimeout(()=> toastEl.classList.remove('show'), 2400);
}
function el(tag, props, children){
  props = props || {}; children = children || [];
  const e = document.createElement(tag);
  Object.entries(props).forEach(([k,v])=>{
    if(v === undefined || v === null || v === false) return;
    if(k==='class') e.className=v;
    else if(k==='text') e.textContent=v;
    else if(k.startsWith('on')) e.addEventListener(k.slice(2).toLowerCase(), v);
    else if(typeof v === 'boolean'){ e.setAttribute(k,''); }
    else e.setAttribute(k,v);
  });
  children.forEach(c=>{
    if(c) e.appendChild(typeof c==='string'? document.createTextNode(c): c);
  });
  return e;
}
function spinnerBtnText(label){
  const f = document.createDocumentFragment();
  f.appendChild(el('span',{class:'spinner','aria-hidden':'true'}));
  f.appendChild(document.createTextNode(label));
  return f;
}

/* ---------- local storage (drafts, manage keys) ---------- */
const mem = new Map();
const store = {
  get(k){ try{ const v = localStorage.getItem(k); if(v!==null) return v; }catch(e){} return mem.has(k)? mem.get(k) : null; },
  set(k,v){ try{ localStorage.setItem(k,v); }catch(e){} mem.set(k,v); },
  del(k){ try{ localStorage.removeItem(k); }catch(e){} mem.delete(k); }
};
const DRAFT_KEY = 'mlfy:draft:v1';

/* ---------- gift codes ---------- */
function formatCode(code){ return code.match(/.{1,5}/g).join('-'); }
function normalizeCode(input){
  if(!input) return '';
  let s = String(input).trim();
  const m = s.match(/\/g\/([0-9A-Za-z\-\s]+)/);   // pasted share URL
  if(m) s = m[1];
  s = s.toUpperCase().replace(/[\s\-_]/g,'').replace(/O/g,'0').replace(/[IL]/g,'1');
  return s;
}
function isCode(s){
  if(s.length !== CODE_LEN) return false;
  for(const ch of s) if(CODE_ALPHABET.indexOf(ch) === -1) return false;
  return true;
}
function shareUrl(code){ return location.origin + '/g/' + code; }

/* ---------- songs ---------- */
const DEFAULT_SONGS = [
  { title: 'Harpsichord Keepsake', artist: 'J.S. Bach', url: 'builtin:song-1' },
  { title: 'Acoustic Romance', artist: 'Classical Ensemble', url: 'builtin:song-2' },
  { title: 'Melodic Air for Strings', artist: 'Chamber Players', url: 'builtin:song-3' }
];
function cloneDefaults(){ return DEFAULT_SONGS.map(s=>({...s})); }
function normalizeSongUrl(u){
  // prototype gifts stored bare file names such as "song-1.mp3"
  const m = /^song-([1-3])\.mp3$/.exec(u || '');
  return m ? 'builtin:song-'+m[1] : u;
}
function resolveSongUrl(u){
  const m = /^builtin:(song-[1-3])$/.exec(u || '');
  if(m) return A('audio/'+m[1]+'.mp3');
  return u;
}
function parseAudioUrl(raw){
  let u;
  try{ u = new URL(raw.trim()); }catch(e){ return {error:'That doesn’t look like a web address. Paste a direct link such as https://example.com/song.mp3'}; }
  if(u.protocol !== 'https:') return {error:'Audio links must start with https://'};
  if(u.username || u.password) return {error:'Links containing a username or password are not allowed.'};
  if(u.href.length > 500) return {error:'That link is too long (500 characters max).'};
  return {url:u.href};
}
function parseImageUrl(raw){
  let u;
  try{ u = new URL(raw.trim()); }catch(e){ return {error:'That doesn’t look like a web address.'}; }
  if(u.protocol !== 'https:') return {error:'Image links must start with https://'};
  if(u.username || u.password) return {error:'Links containing a username or password are not allowed.'};
  if(u.href.length > 500) return {error:'That link is too long (500 characters max).'};
  return {url:u.href};
}

/* ---------- API client ---------- */
class ApiError extends Error{
  constructor(code, status, message){ super(message || code); this.code = code; this.status = status; }
}
async function api(path, o){
  o = o || {};
  const ctl = new AbortController();
  const timer = setTimeout(()=> ctl.abort(), o.timeout || 25000);
  let res;
  try{
    res = await fetch('/api' + path, {
      method: o.method || 'GET',
      headers: Object.assign(o.json ? {'Content-Type':'application/json'} : {}, o.headers || {}),
      body: o.json ? JSON.stringify(o.json) : o.body,
      signal: ctl.signal,
      cache: 'no-store',
      credentials: 'omit',
      referrerPolicy: 'no-referrer'
    });
  }catch(e){
    throw new ApiError(e && e.name === 'AbortError' ? 'timeout' : 'network', 0);
  }finally{
    clearTimeout(timer);
  }
  let data = null;
  try{ data = await res.json(); }catch(e){ data = null; }
  if(!res.ok){
    throw new ApiError((data && data.error) || ('http_'+res.status), res.status, data && data.message);
  }
  return data;
}
function friendly(err, what){
  if(!(err instanceof ApiError)) return 'Something went wrong. Please try again.';
  switch(err.code){
    case 'network': return 'We couldn’t reach the server. Check your connection and try again.';
    case 'timeout': return 'The connection is very slow and the request timed out. Please try again.';
    case 'rate_limited': return 'Too many attempts — please wait a minute and try again.';
    case 'not_found': return what === 'gift' ? 'No gift found for that code.' : 'That item could not be found.';
    case 'gone': return 'This gift has been deleted or has expired.';
    case 'backend_not_configured': return 'The gift service isn’t set up yet. (The site owner still needs to finish the Supabase configuration.)';
    case 'invalid': case 'invalid_input': return err.message || 'Some of the details weren’t accepted. Please check them and try again.';
    case 'payload_too_large': return 'That file is too large.';
    case 'unsupported_type': return 'That file type isn’t supported. Use a JPEG, PNG or WebP photo.';
    case 'photo_limit': return 'You can add up to '+MAX_PHOTOS+' photos.';
    case 'quota_exceeded': return 'Storage is full right now. Please try again later.';
    default: return err.status >= 500 ? 'The server had a problem. Please try again in a moment.' : (err.message || 'Something went wrong. Please try again.');
  }
}

/* ---------- state ---------- */
let state = {
  view: (typeof location !== 'undefined' && location.hash === '#vinyl') ? 'vinyl' : 'home',
  mode: (typeof location !== 'undefined' && location.hash === '#vinyl') ? 'creator' : null,
  code:null,
  letter:{ message:'', songs:cloneDefaults(), photos:[] },
  envelopeOpen:false, playingIndex:0, isPlaying:false,
  draft:{ title:'', artist:'', url:'' },
  loadError:'', shareCode:'', buffering:false,
  postcardIndex:0, photoUrlDraft:'',
  notice:'', saving:false, loading:false, photoMsg:'', manageKey:'',
  saveFp:'', saveKey:'', manageToken:'', photoLoadState:{}, saveRetry:false, retryCode:''
};
let renderedView = null;
let photoSeq = 0;

/* =====================================================================
   Cursor-following cluster (home screen, fine pointers only)
   ===================================================================== */
const ccFine = window.matchMedia && window.matchMedia('(hover:hover) and (pointer:fine)').matches;
const reduceMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)');
const ccOff = [{x:-90,y:-60},{x:-15,y:-85},{x:60,y:-55},{x:-80,y:35},{x:-5,y:65},{x:70,y:40}];
const ccChain = [0,1,2,5,4,3];
const ccTilt = [-6,4,-3,5,-5,3];
const ccLag = [0.20,0.16,0.13,0.11,0.09,0.08];
const ccWidths = [56,64,52,60,54,58];
let clusterEl = null, ccImgs = [];
const ccPos = ccOff.map(()=>({x:-500, y:-500}));
let ccTX = -500, ccTY = -500, ccSeen = false, ccHoverBtn = false, ccRaf = 0;

function buildCluster(){
  if(clusterEl || !ccFine || (reduceMotion && reduceMotion.matches)) return;
  clusterEl = el('div',{class:'cursor-cluster',id:'cursorCluster','aria-hidden':'true'});
  for(let i=0;i<6;i++){
    const p = pic('cursor-'+(i+1), {cls:'cc cc'+(i+1), sizes:ccWidths[i]+'px', priority:'low', hidden:true});
    clusterEl.appendChild(p);
  }
  document.body.appendChild(clusterEl);
  ccImgs = Array.from(clusterEl.querySelectorAll('img.cc'));
}
function ccActive(){ return state.view==='home' && !document.hidden && ccSeen && !ccHoverBtn; }
function ccStep(){
  ccRaf = 0;
  if(!clusterEl) return;
  if(state.view!=='home') ccHoverBtn = false;
  const show = ccActive();
  clusterEl.classList.toggle('on', show);
  if(state.view!=='home' || document.hidden || !ccSeen) return;     // sleep: restarted by the next mousemove
  let tx = ccTX, ty = ccTY, px = 0, py = 0, moving = false;
  for(let k=0;k<ccChain.length;k++){
    const i = ccChain[k];
    const p = ccPos[i];
    const dx = (tx + ccOff[i].x - px) - p.x, dy = (ty + ccOff[i].y - py) - p.y;
    p.x += dx * ccLag[k];
    p.y += dy * ccLag[k];
    if(Math.abs(dx) > 0.05 || Math.abs(dy) > 0.05) moving = true;
    ccImgs[i].style.transform = 'translate3d('+p.x.toFixed(2)+'px,'+p.y.toFixed(2)+'px,0) rotate('+ccTilt[i]+'deg)';
    tx = p.x; ty = p.y; px = ccOff[i].x; py = ccOff[i].y;
  }
  if(moving) ccRaf = requestAnimationFrame(ccStep);
}
function ccKick(){ if(!ccRaf && clusterEl) ccRaf = requestAnimationFrame(ccStep); }

if(ccFine){
  window.addEventListener('mousemove', e=>{
    if(!clusterEl) buildCluster();
    if(!clusterEl) return;
    ccTX = e.clientX; ccTY = e.clientY;
    if(!ccSeen){
      ccSeen = true;
      ccPos.forEach((p,i)=>{ p.x = ccTX + ccOff[i].x; p.y = ccTY + ccOff[i].y; });
    }
    ccKick();
  }, {passive:true});
  document.documentElement.addEventListener('mouseleave', ()=>{ ccSeen = false; ccKick(); });
  document.addEventListener('mouseover', e=>{
    if(state.view==='home' && e.target && e.target.closest && e.target.closest('.home-card .btn')){ ccHoverBtn = true; ccKick(); }
  });
  document.addEventListener('mouseout', e=>{
    if(e.target && e.target.closest && e.target.closest('.home-card .btn')){ ccHoverBtn = false; ccKick(); }
  });
  document.addEventListener('visibilitychange', ccKick);
  if(reduceMotion && reduceMotion.addEventListener) reduceMotion.addEventListener('change', ()=>{ if(reduceMotion.matches && clusterEl) clusterEl.classList.remove('on'); });
}

/* =====================================================================
   Draft autosave (the unpublished letter stays on this device only)
   ===================================================================== */
function isDefaultSongs(songs){
  return songs.length === DEFAULT_SONGS.length && songs.every((s,i)=> s.url === DEFAULT_SONGS[i].url && s.title === DEFAULT_SONGS[i].title && s.artist === DEFAULT_SONGS[i].artist);
}
function draftMeaningful(){
  const L = state.letter;
  return !!(L.message.trim() || !isDefaultSongs(L.songs) || L.photos.some(p=>p.ext));
}
let draftTimer = null;
function scheduleDraftSave(){
  if(state.mode !== 'creator') return;
  clearTimeout(draftTimer);
  draftTimer = setTimeout(saveDraftNow, 400);
}
function saveDraftNow(){
  if(state.mode !== 'creator') return;
  if(!draftMeaningful()){ store.del(DRAFT_KEY); return; }
  const L = state.letter;
  store.set(DRAFT_KEY, JSON.stringify({
    message: L.message,
    songs: L.songs,
    photos: L.photos.filter(p=>p.ext).map(p=>({url:p.url})),
    savedAt: Date.now()
  }));
}
function loadDraft(){
  try{
    const d = JSON.parse(store.get(DRAFT_KEY) || 'null');
    if(!d || typeof d.message !== 'string' || !Array.isArray(d.songs)) return null;
    return d;
  }catch(e){ return null; }
}
window.addEventListener('pagehide', saveDraftNow);
window.addEventListener('beforeunload', e=>{
  saveDraftNow();
  if(state.mode==='creator' && state.view!=='saved' && state.letter.photos.some(p=>!p.ext)){
    e.preventDefault(); e.returnValue = '';   // uploaded (not external) photos can't be restored from the draft
  }
});

/* =====================================================================
   Gift: save / load / delete
   ===================================================================== */
function serializeSong(s){ return {title:s.title, artist:s.artist || '', url:s.url}; }

function validateBeforeSave(){
  const L = state.letter;
  if(L.songs.length < MIN_SONGS) return 'Add at least '+(MIN_SONGS===1?'one song':MIN_SONGS+' songs')+' before saving.';
  if(L.songs.length > MAX_SONGS) return 'You can add up to '+MAX_SONGS+' songs.';
  if(L.message.length > MAX_MESSAGE) return 'Your letter is a little too long (limit '+MAX_MESSAGE.toLocaleString()+' characters).';
  if(L.photos.some(p=>p.status==='uploading' || p.status==='processing')) return 'Please wait until your photos have finished uploading.';
  if(L.photos.some(p=>p.status==='error')) return 'One of your photos didn’t upload. Retry it or remove it, then save.';
  return '';
}

async function saveLetter(){
  if(state.saving) return;                       // double-click / double-tap guard
  const problem = validateBeforeSave();
  if(problem){ state.loadError = problem; syncVinylForm(); return; }
  const L = state.letter;
  const body = {
    message: L.message,
    songs: L.songs.map(serializeSong),
    photos: L.photos.map(p=> p.ext ? {url:p.url} : {id:p.id})
  };
  // One idempotency key per distinct payload: a retry after a lost response can never create a second gift.
  const fp = JSON.stringify(body);
  if(fp !== state.saveFp){
    state.saveFp = fp;
    state.saveKey = randomToken(18);
    state.manageToken = randomToken(32);
  }
  body.idempotencyKey = state.saveKey;
  body.manageKey = state.manageToken;
  state.saving = true; state.loadError = ''; state.saveRetry = false;
  syncVinylForm();
  try{
    const res = await api('/gifts', {method:'POST', json:body, timeout:30000});
    if(!res || !isCode(res.code)) throw new ApiError('bad_response', 502);
    store.set('mlfy:manage:'+res.code, state.manageToken);
    store.del(DRAFT_KEY);
    clearTimeout(draftTimer);
    state.shareCode = res.code;
    state.saving = false;
    state.loadError = '';
    state.view = 'saved';
    render();
  }catch(e){
    state.saving = false;
    state.loadError = friendly(e, 'save');
    state.saveRetry = true;
    syncVinylForm();
  }
}

async function loadLetter(raw){
  if(state.loading) return;
  const code = normalizeCode(raw);
  if(!code){ state.loadError = 'Please enter a gift code or paste your gift link.'; state.retryCode = ''; render(); return; }
  if(!isCode(code)){
    // Prototype gifts used 6-character codes stored only in the browser that created them.
    const plain = String(raw).trim().toUpperCase().replace(/[\s-]/g,'');
    const legacy = plain.length <= 8 ? legacyLookup(plain) : null;
    if(legacy){ importLegacy(legacy); return; }
    state.loadError = plain.length <= 8
      ? 'That looks like an old prototype code. Gift codes are now 20 characters long, and old codes only worked on the device that created them.'
      : 'That code doesn\u2019t look right. Gift codes are 20 letters and numbers \u2014 or just open the link you were sent.';
    state.retryCode = '';
    state.view = 'enterCode';
    render(); return;
  }
  state.loading = true; state.loadError = ''; state.retryCode = '';
  renderLoading('Unsealing your gift\u2026');
  try{
    const g = await api('/gifts/' + code);
    state.loading = false;
    applyGift(g, code);
  }catch(e){
    state.loading = false;
    state.loadError = friendly(e, 'gift');
    state.mode = null;
    state.view = 'enterCode';
    const transient = e.code==='network' || e.code==='timeout' || e.status>=500 || e.code==='rate_limited';
    state.retryCode = transient ? code : '';
    if(!transient){ try{ history.replaceState(null,'','/'); }catch(_){} }
  }
  render();
}

function applyGift(g, code){
  const photos = Array.isArray(g.photos) ? g.photos.filter(p=>p && okRemote(p.url)).map(p=>({url:p.url, ext:!!p.external})) : [];
  let songs = Array.isArray(g.songs) ? g.songs.map(s=>({
      title:String(s.title||'').slice(0,120), artist:String(s.artist||'').slice(0,120), url:normalizeSongUrl(String(s.url||''))
    })).filter(s=> s.title && (/^builtin:song-[1-3]$/.test(s.url) || /^https:\/\//.test(s.url))) : [];
  if(!songs.length) songs = cloneDefaults();
  state.letter = { message: String(g.message || ''), songs, photos };
  state.code = code;
  state.mode = 'recipient';
  state.envelopeOpen = false;
  state.playingIndex = 0;
  state.postcardIndex = 0;
  state.photoLoadState = {};
  state.view = 'envelope';
  state.loadError = '';
  try{ history.replaceState(null, '', '/g/' + code); }catch(e){}
}

function legacyLookup(code){
  try{
    const raw = localStorage.getItem('gift-letter:letter:' + code);
    if(!raw) return null;
    const g = JSON.parse(raw);
    return g && typeof g.message === 'string' ? g : null;
  }catch(e){ return null; }
}
async function importLegacy(g){
  // Re-open a prototype gift (saved only in this browser) in the creator flow so it can be published for real.
  state.mode = 'creator';
  state.letter = { message:String(g.message||'').slice(0,MAX_MESSAGE), songs:[], photos:[] };
  (Array.isArray(g.songs)?g.songs:[]).slice(0,MAX_SONGS).forEach(s=>{
    const url = normalizeSongUrl(String(s.url||''));
    if(s.title && (/^builtin:song-[1-3]$/.test(url) || parseAudioUrl(url).url)) state.letter.songs.push({title:String(s.title).slice(0,120), artist:String(s.artist||'').slice(0,120), url});
  });
  if(!state.letter.songs.length) state.letter.songs = cloneDefaults();
  state.envelopeOpen = true;
  state.view = 'letter';
  state.notice = 'We found this gift saved only on this device (from the prototype). Review it and press “Save” on the music page to publish it with a shareable link.';
  render();
  for(const p of (Array.isArray(g.photos)?g.photos:[]).slice(0,MAX_PHOTOS)){
    if(!p || typeof p.url !== 'string') continue;
    if(p.url.startsWith('data:image/')){
      try{ const blob = await (await fetch(p.url)).blob(); await addPhotoFile(new File([blob], 'photo', {type: blob.type})); }catch(e){}
    }else{
      const u = parseImageUrl(p.url);
      if(u.url) addPhotoUrl(u.url, true);
    }
  }
}

async function deleteGift(){
  const code = state.shareCode;
  const key = store.get('mlfy:manage:' + code) || state.manageToken;
  if(!key) return;
  if(!window.confirm('Delete this gift permanently? The link will stop working for everyone.')) return;
  try{
    await api('/gifts/' + code, {method:'DELETE', headers:{'Authorization':'Bearer '+key}});
    store.del('mlfy:manage:' + code);
    showToast('Gift deleted.');
    state.view = 'home'; state.mode = null; state.shareCode = '';
    render();
  }catch(e){
    showToast(friendly(e, 'delete'));
  }
}

/* =====================================================================
   Photos: client-side resize -> private upload (creator) / signed URLs (recipient)
   ===================================================================== */
async function decodeImage(file){
  if('createImageBitmap' in window){
    try{ return await createImageBitmap(file, {imageOrientation:'from-image'}); }catch(e){ /* fall through */ }
  }
  return await new Promise((resolve, reject)=>{
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = ()=>{ URL.revokeObjectURL(url); resolve(img); };
    img.onerror = ()=>{ URL.revokeObjectURL(url); reject(new Error('decode')); };
    img.src = url;           // browsers apply EXIF orientation to <img> by default
  });
}
function canvasToBlob(canvas, type, q){
  return new Promise(res=> canvas.toBlob(b=>res(b), type, q));
}
async function compressImage(file){
  const src = await decodeImage(file);
  let w = src.width || src.naturalWidth, h = src.height || src.naturalHeight;
  if(!w || !h) throw new Error('empty');
  let dim = PHOTO_MAX_DIM, q = PHOTO_QUALITY, blob = null;
  for(let attempt=0; attempt<4; attempt++){
    const scale = Math.min(1, dim / Math.max(w, h));
    const cw = Math.max(1, Math.round(w*scale)), ch = Math.max(1, Math.round(h*scale));
    const canvas = document.createElement('canvas');
    canvas.width = cw; canvas.height = ch;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(src, 0, 0, cw, ch);
    blob = await canvasToBlob(canvas, 'image/webp', q);       // Safari returns PNG here -> detect and fall back
    if(!blob || blob.type !== 'image/webp'){
      ctx.globalCompositeOperation = 'destination-over';        // JPEG has no alpha: paint white behind
      ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, cw, ch);
      blob = await canvasToBlob(canvas, 'image/jpeg', q);
    }
    if(blob && blob.size <= PHOTO_MAX_BYTES) break;
    dim = Math.round(dim * 0.8); q = Math.max(0.55, q - 0.08);
  }
  if(src.close) try{ src.close(); }catch(e){}
  if(!blob || blob.size > PHOTO_MAX_BYTES) throw new Error('too_big');
  return blob;
}
function photoFilePermitted(file){
  if(PHOTO_TYPES.includes(file.type)) return true;
  if(!file.type && /\.(jpe?g|png|webp)$/i.test(file.name || '')) return true;   // some Android pickers omit the MIME type
  return false;
}
function photoCount(){ return state.letter.photos.length; }

async function addPhotoFile(file){
  if(!file) return;
  if(photoCount() >= MAX_PHOTOS){ state.photoMsg = 'You can add up to '+MAX_PHOTOS+' photos.'; syncPostcard(); return; }
  if(!photoFilePermitted(file)){ state.photoMsg = 'Please choose a JPEG, PNG or WebP photo.'; syncPostcard(); return; }
  if(file.size > PHOTO_MAX_INPUT_BYTES){ state.photoMsg = 'That photo is very large (over 30 MB). Please choose a smaller one.'; syncPostcard(); return; }
  const ph = {key:++photoSeq, status:'processing', url:'', ext:false};
  state.letter.photos.push(ph);
  state.photoMsg = '';
  syncPostcard();
  try{
    ph.blob = await compressImage(file);
    ph.url = URL.createObjectURL(ph.blob);
  }catch(e){
    const i = state.letter.photos.indexOf(ph);
    if(i>=0) state.letter.photos.splice(i,1);
    state.photoMsg = e && e.message === 'too_big' ? 'That photo couldn’t be made small enough. Try a different one.' : 'We couldn’t read that photo. Try a JPEG, PNG or WebP image.';
    syncPostcard();
    return;
  }
  ph.status = 'uploading'; syncPostcard();
  await uploadPhoto(ph);
}
async function uploadPhoto(ph){
  ph.status = 'uploading'; ph.error = ''; syncPostcard();
  try{
    const r = await api('/photos', {method:'POST', body:ph.blob, headers:{'Content-Type':ph.blob.type}, timeout:60000});
    if(!r || !r.id) throw new ApiError('bad_response', 502);
    ph.id = r.id; ph.status = 'ready';
  }catch(e){
    ph.status = 'error'; ph.error = friendly(e, 'photo');
    state.photoMsg = ph.error;
  }
  syncPostcard();
}
function addPhotoUrl(url, silent){
  const parsed = parseImageUrl(url || '');
  if(!parsed.url){ if(!silent){ state.photoMsg = parsed.error; syncPostcard(); } return; }
  if(photoCount() >= MAX_PHOTOS){ state.photoMsg = 'You can add up to '+MAX_PHOTOS+' photos.'; syncPostcard(); return; }
  state.letter.photos.push({key:++photoSeq, status:'ready', url:parsed.url, ext:true});
  state.photoUrlDraft = ''; state.photoMsg = '';
  state.saveFp = '';
  scheduleDraftSave();
  syncPostcard();
}
function removePhoto(i){
  const p = state.letter.photos[i];
  if(p && !p.ext && p.url.startsWith('blob:')) URL.revokeObjectURL(p.url);
  state.letter.photos.splice(i,1);
  state.photoMsg = '';
  state.saveFp = '';
  scheduleDraftSave();
  syncPostcard();
}

/* =====================================================================
   Rendering
   ===================================================================== */
let animateNext = false;
function render(){
  const changed = state.view !== renderedView;
  const y = window.scrollY;
  animateNext = changed;
  renderedView = state.view;
  if(state.view==='home' || state.view==='enterCode' || state.view==='envelope' || state.view==='saved') stopAudio();
  app.innerHTML = '';
  if(state.view==='home') renderHome();
  else if(state.view==='enterCode') renderEnterCode();
  else if(state.view==='envelope') renderEnvelope();
  else if(state.view==='letter') renderLetter();
  else if(state.view==='vinyl') renderVinyl();
  else if(state.view==='saved') renderSaved();
  else if(state.view==='loadingGift') renderLoading('Unsealing your gift…');
  window.scrollTo(0, changed ? 0 : y);
  ccKick();
}
function screen(children, className){
  const d = document.createElement('div');
  d.className = 'screen' + (animateNext ? ' enter' : '') + (className? ' '+className : '');
  children.forEach(c=>{ if(c) d.appendChild(c); });
  app.appendChild(d);
  return d;
}
function renderLoading(text){
  renderedView = 'loadingGift';
  animateNext = true;
  app.innerHTML = '';
  screen([ el('div',{class:'home-card',role:'status','aria-live':'polite'},[
    el('div',{class:'brand',text:'A Letter For You'}),
    el('p',{},[ el('span',{class:'loading-dot'}), text ])
  ]) ]);
}

/* ---------- home ---------- */
const HOME_TAGLINE = 'Write a personal letter, add one to ten songs, and send a keepsake that opens like an envelope and plays like a record.';
function renderHome(){
  const titleFrame = el('div',{class:'title-frame'});
  titleFrame.appendChild(pic('frame',{alt:'Decorative frame',cls:'title-frame-img',sizes:'(max-width:560px) 100vw, 520px',priority:'high'}));
  titleFrame.appendChild(el('div',{class:'title-frame-text',text:'My Love For You'}));
  const card = el('div',{class:'home-card'},[
    titleFrame,
    el('p',{class:'home-tagline',text:HOME_TAGLINE}),
    el('div',{class:'row',style:'margin-top:40px'},[
      el('button',{class:'btn',id:'btn-create',onclick:startCreate,text:'Write a Letter'}),
      el('button',{class:'btn ghost',id:'btn-code',onclick:goEnterCode,text:'I received a gift code'})
    ])
  ]);
  screen([card]);
  idle(warmAfterHome);
}
function goEnterCode(){ state.view='enterCode'; state.loadError=''; render(); }
function warmAfterHome(){
  // the cursor illustrations only exist for fine pointers without reduced motion: never fetch them on touch devices
  if(ccFine && !(reduceMotion && reduceMotion.matches)) for(let i=1;i<=6;i++) warm('cursor-'+i, ENV_SIZES);
  warm('envelope-closed', ENV_CLOSED_SIZES);
  warm('envelope-open', ENV_OPEN_SIZES);
}

/* ---------- enter code ---------- */
function renderEnterCode(){
  const input = el('input',{type:'text',placeholder:'Paste your gift link or code',autocomplete:'off',autocapitalize:'characters',spellcheck:'false','aria-label':'Gift code or link',maxlength:'200'});
  input.addEventListener('keydown', e=>{ if(e.key==='Enter') loadLetter(input.value); });
  const err = state.loadError ? el('div',{class:'error',role:'alert'},[
      state.loadError,
      state.retryCode ? el('button',{class:'retry',onclick:()=>loadLetter(state.retryCode),text:'Try again'}) : null
    ]) : el('div');
  const box = el('div',{class:'home-card',style:'width:100%;max-width:380px;background:rgba(251,244,226,0.92);border:1.5px solid #a5bcd6;border-radius:12px;padding:26px 24px;box-shadow:0 12px 30px rgba(77,14,18,0.12);'},[
    el('h2',{text:'Enter your code'}),
    el('p',{text:'Paste the gift link (or the 20-character keepsake code) you received to unseal your gift.',style:'font-size:14px;margin-bottom:18px;'}),
    input, err,
    el('div',{class:'row',style:'margin-top:20px'},[
      el('button',{class:'btn',onclick:()=>loadLetter(input.value),text:'Open my gift'}),
      el('button',{class:'btn ghost',onclick:()=>{state.view='home';state.loadError='';render();},text:'Back'})
    ])
  ]);
  screen([el('div',{class:'brand',text:'A Letter For You'}), box]);
  input.focus({preventScroll:true});
}

/* ---------- start creating (restores an unsaved draft if present) ---------- */
function startCreate(){
  state.mode='creator';
  state.envelopeOpen=false;
  state.notice = '';
  state.loadError = '';
  const d = loadDraft();
  if(d){
    state.letter = { message:String(d.message).slice(0,MAX_MESSAGE), songs:d.songs.slice(0,MAX_SONGS).filter(s=>s && s.title && s.url), photos:[] };
    if(!state.letter.songs.length) state.letter.songs = cloneDefaults();
    (d.photos||[]).slice(0,MAX_PHOTOS).forEach(p=>{ const u = parseImageUrl(p.url||''); if(u.url) state.letter.photos.push({key:++photoSeq,status:'ready',url:u.url,ext:true}); });
    state.notice = 'We restored the letter you were writing.';
  }else{
    state.letter = {message:'',songs:cloneDefaults(),photos:[]};
  }
  state.saveFp = ''; state.photoMsg = '';
  state.view='envelope';
  render();
}
function discardDraft(){
  store.del(DRAFT_KEY);
  state.letter = {message:'',songs:cloneDefaults(),photos:[]};
  state.notice = '';
  render();
}

/* ---------- envelope ---------- */
function openEnvelope(){
  if(state.envelopeOpen) return;
  state.envelopeOpen = true;
  render();
  setTimeout(()=>{
    if(state.view === 'envelope' && state.envelopeOpen){
      state.view = 'letter';
      render();
    }
  }, 1250);
}
function renderEnvelope(){
  const isOpen = state.envelopeOpen;
  const wrap = el('div',{class:'envelope-wrap'+(isOpen?' open clickable':''),
    tabindex:'0', role:'button', 'aria-label': isOpen ? 'Continue to letter' : 'Open the envelope'});
  wrap.appendChild(pic('envelope-closed',{cls:'env-img env-closed',sizes:ENV_CLOSED_SIZES,priority:'high'}));
  wrap.appendChild(pic('envelope-open',{cls:'env-img env-open',sizes:ENV_OPEN_SIZES}));
  const goLetter = ()=>{ state.view='letter'; render(); };
  const trigger = ()=>{ if(!isOpen) openEnvelope(); else goLetter(); };
  wrap.addEventListener('click', trigger);
  wrap.addEventListener('keydown', e=>{ if(e.key==='Enter' || e.key===' '){ e.preventDefault(); trigger(); } });

  const hint = el('div',{class:'env-hint'+(isOpen?' clickable':''),'aria-live':'polite'});
  if(!isOpen){
    hint.textContent = state.mode==='creator' ? 'Click to begin your letter' : 'Click to open your gift';
  } else {
    hint.textContent = state.mode==='creator' ? 'Click to begin your letter' : 'Click to read your letter';
    hint.setAttribute('role','button');
    hint.setAttribute('tabindex','0');
    hint.setAttribute('aria-label', hint.textContent);
    hint.addEventListener('click', goLetter);
    hint.addEventListener('keydown', e=>{ if(e.key==='Enter' || e.key===' '){ e.preventDefault(); goLetter(); } });
  }

  // Six decorative pictures — closed envelope only (hidden once opened)
  const stage = el('div',{class:'envelope-stage'});
  stage.appendChild(wrap);
  if(!isOpen){
    [
      {n:1, cls:'pos-tl'}, {n:2, cls:'pos-tc'}, {n:4, cls:'pos-tr'},
      {n:3, cls:'pos-bl'}, {n:5, cls:'pos-bc'}, {n:6, cls:'pos-br'}
    ].forEach(p=>{
      const s = el('span',{class:'env-spot '+p.cls,'aria-hidden':'true'});
      s.appendChild(pic('cursor-'+p.n,{cls:'env-pic',sizes:ENV_SIZES,hidden:true}));
      stage.appendChild(s);
    });
  }

  const nodes = [];
  if(state.notice && state.mode==='creator') nodes.push(el('div',{class:'notice',role:'status'},[state.notice,' ',el('button',{onclick:discardDraft,text:'Start fresh'})]));
  if(state.mode==='creator') nodes.push(el('div',{class:'brand',text:'Write your letter'}));
  nodes.push(stage, hint);
  screen(nodes);
  idle(()=>{ warm('letter-top','421px'); warm('letter-bottom','421px'); });
}

/* ---------- postcard (creator editor / recipient viewer) ---------- */
function thumbEl(p, i){
  const thumb = el('div',{class:'photo-thumb'+(p.status==='uploading'||p.status==='processing'?' uploading':'')+(p.status==='error'?' failed':'')});
  if(p.url){
    const img = el('img',{src:p.url,alt:'Postcard photo '+(i+1),decoding:'async'});
    if(p.ext){ img.referrerPolicy = 'no-referrer'; img.addEventListener('error', ()=>{ thumb.classList.add('failed'); thumb.appendChild(el('div',{class:'photo-state',text:'Can’t load'})); }); }
    thumb.appendChild(img);
  }
  if(p.status==='processing') thumb.appendChild(el('div',{class:'photo-state',text:'Preparing…'}));
  if(p.status==='uploading') thumb.appendChild(el('div',{class:'photo-state',text:'Uploading…'}));
  if(p.status==='error'){
    thumb.appendChild(el('div',{class:'photo-state',text:'Failed'}));
    thumb.appendChild(el('button',{class:'photo-retry',onclick:()=>uploadPhoto(p),text:'Retry','aria-label':'Retry upload of photo '+(i+1)}));
  }
  thumb.appendChild(el('button',{class:'photo-remove',onclick:()=>removePhoto(i),text:'✕','aria-label':'Remove photo '+(i+1)}));
  return thumb;
}
function renderPostcard(){
  const photos = state.letter.photos;
  if(state.mode==='creator'){
    const atMax = photos.length >= MAX_PHOTOS;
    const thumbs = el('div',{class:'photo-thumbs'});
    photos.forEach((p,i)=> thumbs.appendChild(thumbEl(p,i)));
    const fileInput = el('input',{type:'file',accept:'image/jpeg,image/png,image/webp',id:'photo-file'});
    fileInput.addEventListener('change', e=>{
      const files = Array.from(e.target.files || []);
      e.target.value = '';
      (async()=>{ for(const f of files) await addPhotoFile(f); })();
    });
    fileInput.multiple = true;
    const urlInput = el('input',{type:'text',placeholder:'Or paste an https:// image link','aria-label':'Image link',inputmode:'url',autocomplete:'off',maxlength:'500'});
    urlInput.value = state.photoUrlDraft;
    urlInput.addEventListener('input', e=> state.photoUrlDraft = e.target.value);
    urlInput.addEventListener('keydown', e=>{ if(e.key==='Enter'){ e.preventDefault(); addPhotoUrl(urlInput.value); } });
    const addUrlBtn = el('button',{class:'btn ghost',disabled:atMax,onclick:()=>addPhotoUrl(urlInput.value),text:'Add'});
    const fileLabel = el('label',{for:'photo-file',class:'btn ghost'+(atMax?' btn-disabled':''),text: atMax? 'Postcard full' : 'Upload a photo'});
    if(atMax) fileInput.setAttribute('disabled','');
    const msg = el('div',{class:'error',role:'alert',id:'photo-msg',style:state.photoMsg?'':'display:none',text:state.photoMsg});
    return el('div',{class:'postcard-section',id:'postcard'},[
      el('h3',{text:'Postcard photo (optional)', style:'margin:0 0 4px 0;font-size:15px;color:#606c38;'}),
      el('div',{class:'hint',style:'margin-bottom:12px;',text: photos.length+' / '+MAX_PHOTOS+' photos'}),
      photos.length ? thumbs : null,
      el('div',{class:'photo-add-row'},[fileLabel, fileInput, urlInput, addUrlBtn]),
      msg
    ].filter(Boolean));
  }
  if(!photos.length) return null;                 // no photos => no postcard section at all
  const idx = Math.min(state.postcardIndex, photos.length-1);
  const p = photos[idx];
  const viewer = el('div',{class:'postcard-viewer'});
  const status = el('div',{class:'postcard-status',role:'status'});
  const img = el('img',{class:'postcard-photo loading',alt:'Postcard photo '+(idx+1)+' of '+photos.length,decoding:'async',referrerpolicy:'no-referrer'});
  img.addEventListener('load', ()=>{ img.classList.remove('loading'); status.textContent=''; preloadNeighbours(idx); });
  img.addEventListener('error', ()=>{
    img.classList.remove('loading');
    status.textContent = 'This photo couldn’t be loaded. ';
    status.appendChild(el('button',{onclick:()=>retryPhotos(),text:'Try again'}));
  });
  if(idx > 0) img.loading = 'lazy';
  img.src = p.url;
  viewer.appendChild(img);
  viewer.appendChild(status);
  const kids = [viewer];
  if(photos.length>1){
    kids.push(el('div',{class:'postcard-nav'},[
      el('button',{class:'icon-btn',onclick:()=>{ state.postcardIndex=(idx-1+photos.length)%photos.length; render(); },text:'‹','aria-label':'Previous photo'}),
      el('span',{class:'hint',style:'font-weight:bold;',text:(idx+1)+' / '+photos.length}),
      el('button',{class:'icon-btn',onclick:()=>{ state.postcardIndex=(idx+1)%photos.length; render(); },text:'›','aria-label':'Next photo'})
    ]));
  }
  return el('div',{class:'postcard-section'},kids);
}
function preloadNeighbours(idx){
  const ph = state.letter.photos;
  if(ph.length < 2) return;
  [ (idx+1)%ph.length, (idx-1+ph.length)%ph.length ].forEach(j=>{ const i = new Image(); i.referrerPolicy='no-referrer'; i.src = ph[j].url; });
}
async function retryPhotos(){
  // Signed photo URLs expire; fetching the gift again issues fresh ones.
  if(state.mode==='recipient' && state.code){
    try{
      const g = await api('/gifts/' + state.code);
      const fresh = Array.isArray(g.photos) ? g.photos.filter(p=>p && okRemote(p.url)) : [];
      if(fresh.length === state.letter.photos.length){
        state.letter.photos = fresh.map(p=>({url:p.url, ext:!!p.external}));
      }
    }catch(e){ showToast(friendly(e,'photo')); }
  }
  render();
}
function syncPostcard(){
  // Swap only the postcard panel so the textarea keeps focus, caret and scroll position.
  if(state.view === 'letter' && state.mode === 'creator'){
    const old = document.getElementById('postcard');
    const fresh = renderPostcard();
    if(old && fresh) old.replaceWith(fresh);
  }
  else if(state.view === 'vinyl') syncVinylForm();
}

/* ---------- letter (adaptive paper) ---------- */
let letterRO = null;
function renderLetter(){
  let writing, fit;
  const sheet = el('div',{class:'letter-sheet'});
  if(state.mode==='creator'){
    const ta = el('textarea',{placeholder:'Write your letter here upon this parchment...','aria-label':'Your letter',maxlength:String(MAX_MESSAGE),enterkeyhint:'enter',rows:'6'});
    ta.value = state.letter.message;
    const count = el('div',{class:'letter-count',style:'display:none','aria-live':'polite'});
    writing = el('div',{class:'letter-writing'},[ ta, count ]);
    const mirror = el('div',{class:'letter-mirror','aria-hidden':'true',style:'position:absolute;visibility:hidden;left:0;top:0;pointer-events:none;white-space:pre-wrap;overflow-wrap:break-word;word-break:normal;'});
    fit = ()=>{
      const cs = getComputedStyle(ta);
      mirror.style.fontFamily = cs.fontFamily;
      mirror.style.fontSize = cs.fontSize;
      mirror.style.fontWeight = cs.fontWeight;
      mirror.style.letterSpacing = cs.letterSpacing;
      mirror.style.lineHeight = cs.lineHeight;
      mirror.style.padding = cs.padding;
      mirror.style.width = ta.offsetWidth + 'px';
      mirror.style.boxSizing = 'border-box';
      mirror.style.fontStyle = cs.fontStyle;
      mirror.textContent = ta.value + '​';
      return mirror.offsetHeight + 28;           // one spare line so the caret line never clips
    };
    sheet.appendChild(mirror);
    ta.addEventListener('input', e=>{
      state.letter.message = e.target.value;
      state.saveFp = '';
      scheduleDraftSave();
      fitLetter(sheet, fit);
      const n = ta.value.length;
      count.style.display = n > MAX_MESSAGE*0.9 ? '' : 'none';
      count.className = 'letter-count' + (n > MAX_MESSAGE*0.97 ? ' near' : '');
      count.textContent = n.toLocaleString() + ' / ' + MAX_MESSAGE.toLocaleString();
    });
  } else {
    const tag = el('div',{class:'readonly-tag',text:'✦ A letter for you ✦'});
    const body = el('div',{class:'letter-readonly',text: state.letter.message || '(no message written)'});
    writing = el('div',{class:'letter-writing'},[ tag, body ]);
    fit = ()=> tag.offsetHeight + 6 + body.offsetHeight + 8;
  }
  const paper = el('div',{class:'letter-paper'},[
    pic('letter-top',{sizes:'(max-width:500px) 100vw, 470px',priority:'high'}),
    el('div',{class:'lp-ext','aria-hidden':'true'}),
    pic('letter-bottom',{sizes:'(max-width:500px) 100vw, 470px',priority:'high'})
  ]);
  sheet.insertBefore(paper, sheet.firstChild);
  sheet.appendChild(writing);

  const postcard = renderPostcard();
  const err = state.loadError ? el('div',{class:'error',role:'alert',text:state.loadError}) : null;
  const nextBtn = el('button',{
    class:'btn',
    style:'margin-top:22px;font-size:14px;padding:11px 24px;',
    onclick:goVinyl,
    text: state.mode==='creator' ? 'Continue to the music' : 'Continue to the record'
  });
  const children = [];
  if(state.notice && state.mode==='creator') children.push(el('div',{class:'notice',role:'status'},[state.notice,' ',el('button',{onclick:()=>{state.notice='';render();},text:'Dismiss'})]));
  children.push(sheet);
  if(postcard) children.push(postcard);
  if(err) children.push(err);
  children.push(nextBtn);
  screen(children, 'letter-screen');

  // size the paper to the text now, and whenever the sheet's width changes
  fitLetter(sheet, fit);
  if(letterRO){ letterRO.disconnect(); letterRO = null; }
  if('ResizeObserver' in window){
    let lastW = sheet.clientWidth;
    letterRO = new ResizeObserver(()=>{ const w = sheet.clientWidth; if(w !== lastW){ lastW = w; fitLetter(sheet, fit); } });
    letterRO.observe(sheet);
  }
  // fonts can finish loading after first layout and change line breaks
  if(document.fonts && document.fonts.ready) document.fonts.ready.then(()=>{ if(sheet.isConnected) fitLetter(sheet, fit); });
  idle(()=>{ warm('vinyl-record','(max-width:560px) 172px, 220px'); warm('minstrel','130px'); warm('angel','120px'); });
}
function fitLetter(sheet, measure){
  const w = sheet.clientWidth;
  if(!w) return;
  const s = w / LETTER_ART_W;
  sheet.style.setProperty('--s', s.toFixed(4));
  const need = measure();
  const k = Math.max(0, Math.ceil((need - LETTER_CAP0 * s) / (LETTER_STEP * s)));
  sheet.style.setProperty('--k', String(k));
  sheet.classList.toggle('tall', k > 24);
}

function goVinyl(){
  state.view='vinyl';
  state.loadError = '';
  render();
}

/* =====================================================================
   Player (vinyl screen)
   ===================================================================== */
let audioEl = null;
let noteInterval = null;

function getAudio(){
  if(!audioEl){
    audioEl = new Audio();
    audioEl.preload = 'metadata';
    audioEl.volume = 0.8;
    audioEl.addEventListener('ended', ()=>{ nextTrack(); });
    audioEl.addEventListener('timeupdate', updateProgressUI);
    audioEl.addEventListener('durationchange', updateProgressUI);
    audioEl.addEventListener('loadedmetadata', updateProgressUI);
    audioEl.addEventListener('loadstart', ()=>{ if(!audioEl.paused){ state.buffering = true; syncPlayer(); } });
    audioEl.addEventListener('waiting', ()=>{ state.buffering=true; syncPlayer(); });
    audioEl.addEventListener('stalled', ()=>{ if(!audioEl.paused){ state.buffering=true; syncPlayer(); } });
    audioEl.addEventListener('canplay', ()=>{ state.buffering=false; syncPlayer(); });
    audioEl.addEventListener('playing', ()=>{
      state.buffering=false;
      state.isPlaying=true;
      state.loadError='';
      startNoteEmitter();
      syncPlayer();
    });
    audioEl.addEventListener('pause', ()=>{
      state.isPlaying=false;
      state.buffering=false;
      stopNoteEmitter();
      syncPlayer();
    });
    audioEl.addEventListener('error', ()=>{
      const c = audioEl.error ? audioEl.error.code : 0;
      state.loadError = c === 2 ? 'The network dropped while loading this song. Press play to try again.'
        : c === 4 ? 'This song can’t be played — the link may be expired, blocked, or not a direct audio file.'
        : 'This song couldn’t be loaded.';
      state.isPlaying=false;
      state.buffering=false;
      stopNoteEmitter();
      syncPlayer();
    });
  }
  return audioEl;
}
function stopAudio(){
  if(audioEl && audioEl.getAttribute('src')){
    audioEl.pause();
    audioEl.removeAttribute('src');
    audioEl.load();
  }
  state.isPlaying = false; state.buffering = false;
  stopNoteEmitter();
}
function currentSongUrl(){
  const s = state.letter.songs[state.playingIndex];
  return s ? resolveSongUrl(s.url) : '';
}
function sameSrc(a, url){
  try{ return a.src && new URL(url, location.href).href === a.src; }catch(e){ return false; }
}
function isUsableAudioUrl(url){
  return /^\/assets\/|^\/audio\//.test(url) || /^https:\/\//.test(url);
}

function startNoteEmitter(){
  stopNoteEmitter();
  if(reduceMotion && reduceMotion.matches) return;
  noteInterval = setInterval(()=>{
    if(!state.isPlaying || state.buffering || state.view !== 'vinyl' || document.hidden) return;
    const tt = document.querySelector('.turntable');
    if(!tt) return;
    if(tt.querySelectorAll('.music-note').length > 8) return;
    const symbols = ['♪', '♫', '♬', '♩', '✦'];
    const note = document.createElement('div');
    note.className = 'music-note';
    note.textContent = symbols[Math.floor(Math.random() * symbols.length)];
    const startX = 60 + Math.random() * 120;
    const startY = 60 + Math.random() * 120;
    const drift = (Math.random() - 0.5) * 60;
    const rot = (Math.random() - 0.5) * 40;
    note.style.left = startX + 'px';
    note.style.top = startY + 'px';
    note.style.setProperty('--note-drift', drift + 'px');
    note.style.setProperty('--note-rot', rot + 'deg');
    tt.appendChild(note);
    setTimeout(()=> note.remove(), 2600);
  }, 700);
}
function stopNoteEmitter(){
  if(noteInterval){ clearInterval(noteInterval); noteInterval = null; }
}

function playPromiseFailed(err){
  // NotAllowedError = autoplay policy; AbortError = a newer load interrupted this play()
  if(err && err.name === 'AbortError') return;
  state.loadError = err && err.name === 'NotAllowedError'
    ? 'Your browser blocked autoplay. Press the play button to start the music.'
    : 'This song couldn’t be played — the link may be expired, blocked, or not a direct audio file.';
  state.isPlaying = false; state.buffering = false;
  stopNoteEmitter();
  syncPlayer();
}
function setTrack(i){
  const songs = state.letter.songs;
  if(!songs.length) return null;
  i = Math.max(0, Math.min(i, songs.length - 1));
  state.playingIndex = i;
  const url = resolveSongUrl(songs[i].url);
  const a = getAudio();
  if(!isUsableAudioUrl(url)){ state.loadError = 'This song’s link isn’t valid.'; return a; }
  if(!sameSrc(a, url)){
    state.loadError = '';
    a.src = url;
    const bar = document.getElementById('seek');
    if(bar){ bar.value = '0'; }
    const cur = document.getElementById('cur-time'); if(cur) cur.textContent = '0:00';
    const dur = document.getElementById('dur-time'); if(dur) dur.textContent = '0:00';
  }
  return a;
}
function loadTrack(i, autoplay){
  const a = setTrack(i);
  if(!a) return;
  if(autoplay){
    state.buffering = true;
    syncPlayer();
    const p = a.play();
    if(p && p.catch) p.catch(playPromiseFailed);
  } else {
    a.pause();
    state.isPlaying = false;
    stopNoteEmitter();
    syncPlayer();
  }
}
function togglePlay(){
  const songs = state.letter.songs;
  if(!songs.length) return;
  const a = getAudio();
  const url = currentSongUrl();
  state.loadError = '';
  if(!sameSrc(a, url)){ loadTrack(state.playingIndex, true); return; }
  if(!a.paused && !a.ended){
    a.pause();
  } else {
    const p = a.play();
    if(p && p.catch) p.catch(playPromiseFailed);
  }
}
function nextTrack(){
  const songs = state.letter.songs;
  if(!songs.length) return;
  loadTrack((state.playingIndex+1)%songs.length, true);
}
function prevTrack(){
  const songs = state.letter.songs;
  if(!songs.length) return;
  loadTrack((state.playingIndex-1+songs.length)%songs.length, true);
}

let progressQueued = false;
function updateProgressUI(){
  if(progressQueued) return;
  progressQueued = true;
  requestAnimationFrame(()=>{
    progressQueued = false;
    const bar = document.getElementById('seek');
    const cur = document.getElementById('cur-time');
    const dur = document.getElementById('dur-time');
    if(!audioEl || !bar) return;
    const d = audioEl.duration;
    if(isFinite(d) && d > 0){
      bar.max = String(d);
      if(document.activeElement !== bar) bar.value = String(audioEl.currentTime || 0);
      if(dur) dur.textContent = fmt(d);
    }
    if(cur) cur.textContent = fmt(audioEl.currentTime || 0);
  });
}
function fmt(s){ s=Math.floor(s); return Math.floor(s/60)+':'+String(s%60).padStart(2,'0'); }
function toRoman(n){
  const r = ['I','II','III','IV','V','VI','VII','VIII','IX','X'];
  return r[n-1] || String(n);
}

/** Update the player in place (no re-render) so the record keeps spinning smoothly and typed text is never lost. */
function syncPlayer(){
  if(state.view !== 'vinyl') return;
  const spinning = state.isPlaying && !state.buffering;      // the disc turns only while audio is really playing
  const rec = document.querySelector('.record');
  if(rec) rec.className = 'record' + (spinning ? ' spinning' : ' paused');
  const arm = document.querySelector('.tonearm');
  if(arm) arm.className = 'tonearm' + (state.isPlaying ? ' playing' : '');
  const tt = document.querySelector('.turntable');
  if(tt) tt.classList.toggle('playing', state.isPlaying);
  const play = document.getElementById('play-btn');
  if(play){
    play.textContent = state.isPlaying ? '⏸' : '▶';
    play.setAttribute('aria-label', state.isPlaying ? 'Pause' : 'Play');
    play.setAttribute('aria-pressed', String(state.isPlaying));
  }
  const songs = state.letter.songs, cur = songs[state.playingIndex];
  const t = document.getElementById('np-title'); if(t) t.textContent = cur ? cur.title : 'No songs yet';
  const ar = document.getElementById('np-artist'); if(ar) ar.textContent = cur && cur.artist ? cur.artist : '';
  const st = document.getElementById('np-status');
  if(st) st.textContent = songs.length ? (state.buffering ? 'Loading...' : (state.isPlaying ? 'Now playing' : 'Paused')) : '';
  document.querySelectorAll('.track').forEach((tr, i)=>{
    const active = i === state.playingIndex;
    tr.classList.toggle('active', active);
    const tt2 = tr.querySelector('.t');
    const bars = tt2 && tt2.querySelector('.sound-bars');
    if(active && state.isPlaying && !bars && tt2){
      tt2.appendChild(el('span',{class:'sound-bars','aria-hidden':'true'},[ el('span',{class:'sound-bar'}), el('span',{class:'sound-bar'}), el('span',{class:'sound-bar'}) ]));
    } else if((!active || !state.isPlaying) && bars){ bars.remove(); }
  });
  syncVinylForm();
}
/** Error line + enabled/disabled state of the save controls. */
function syncVinylForm(){
  if(state.view !== 'vinyl') return;
  const slot = document.getElementById('err-slot');
  if(slot){
    slot.textContent = '';
    if(state.loadError){
      slot.appendChild(el('div',{class:'error',role:'alert'},[
        state.loadError,
        state.saveRetry && state.mode==='creator' && !state.saving ? el('button',{class:'retry',onclick:saveLetter,text:'Try again'}) : null
      ]));
    }
  }
  const save = document.getElementById('save-btn');
  if(save){
    const songs = state.letter.songs.length;
    const busyPhotos = state.letter.photos.some(p=>p.status==='uploading'||p.status==='processing');
    save.disabled = state.saving || songs < MIN_SONGS || busyPhotos;
    save.setAttribute('aria-busy', String(state.saving));
    save.textContent = '';
    if(state.saving) save.appendChild(spinnerBtnText('Sealing your gift…'));
    else save.appendChild(document.createTextNode(busyPhotos ? 'Waiting for photos…' : 'Save gift and get a share link'));
  }
  const hint = document.getElementById('save-hint');
  if(hint) hint.textContent = state.letter.songs.length < MIN_SONGS ? 'Add at least one song to save your gift.' : '';
}

function renderVinyl(){
  const songs = state.letter.songs;
  const spinning = state.isPlaying && !state.buffering;
  const record = pic('vinyl-record',{cls:'record'+(spinning?' spinning':' paused'),alt:'Vinyl record',sizes:'(max-width:560px) 172px, 220px',priority:'high'});
  const recImg = record.querySelector('img');
  recImg.width = 220; recImg.height = 220;
  // the <picture> must not sit between plinth and arm as a box; its <img> carries the .record class

  const tonearm = el('div',{class:'tonearm'+(state.isPlaying?' playing':'')});
  tonearm.innerHTML = '<svg viewBox="0 0 110 110" aria-hidden="true">'
    + '<circle cx="92" cy="16" r="10" fill="#3a0a0d" stroke="#d4af37" stroke-width="1.5"/>'
    + '<circle cx="92" cy="16" r="6" fill="#4d0e12" stroke="#a5bcd6" stroke-width="1"/>'
    + '<circle cx="92" cy="16" r="2.5" fill="#eedec8"/>'
    + '<line x1="92" y1="16" x2="30" y2="86" stroke="#d4af37" stroke-width="4.5" stroke-linecap="round"/>'
    + '<line x1="92" y1="16" x2="30" y2="86" stroke="#4d0e12" stroke-width="2" stroke-linecap="round"/>'
    + '<polygon points="23,79 41,79 34,95" fill="#3a0a0d" stroke="#d4af37" stroke-width="1"/>'
    + '<circle cx="34" cy="94" r="2.5" fill="#e63946" stroke="#ffe3e3" stroke-width="0.75"/>'
    + '</svg>';

  const plinth = el('div',{class:'plinth'});
  plinth.innerHTML = PLINTH_SVG;

  const turntable = el('div',{class:'turntable'+(state.isPlaying?' playing':'')},[
    plinth, record, tonearm
  ]);

  const current = songs[state.playingIndex];
  const nowPlaying = el('div',{class:'now-playing'},[
    el('div',{class:'title',id:'np-title',text: current? current.title : 'No songs yet'}),
    el('div',{class:'artist',id:'np-artist',text: current && current.artist ? current.artist : ''}),
    el('div',{class:'status',id:'np-status','aria-live':'polite',text: songs.length ? (state.buffering? 'Loading...' : (state.isPlaying? 'Now playing':'Paused')) : ''})
  ]);

  const playerCol = el('div',{style:'display:flex;flex-direction:column;align-items:center;'},[turntable, nowPlaying]);
  const minstrel = pic('minstrel',{cls:'minstrel-pic',alt:'Medieval lute player',sizes:'(max-width:560px) 54px, 130px'});
  const angel = pic('angel',{cls:'angel-pic',alt:'Angel violinist',sizes:'(max-width:560px) 52px, 120px'});
  const playerStage = el('div',{class:'player-stage'},[playerCol, minstrel, angel]);

  const seek = el('input',{type:'range',id:'seek',min:'0',max:'0',step:'0.1','aria-label':'Seek'});
  seek.addEventListener('input', ()=>{
    if(audioEl && isFinite(audioEl.duration)){
      audioEl.currentTime = parseFloat(seek.value);
    }
  });
  const timeRow = el('div',{class:'time-row'},[ el('span',{id:'cur-time',text:'0:00'}), el('span',{id:'dur-time',text:'0:00'}) ]);

  const controls = el('div',{class:'controls'},[
    el('button',{class:'icon-btn',onclick:prevTrack,text:'⏮','aria-label':'Previous song'}),
    el('button',{class:'icon-btn play',id:'play-btn',onclick:togglePlay,text: state.isPlaying? '⏸':'▶',
      'aria-label': state.isPlaying? 'Pause':'Play', 'aria-pressed': String(state.isPlaying)}),
    el('button',{class:'icon-btn',onclick:nextTrack,text:'⏭','aria-label':'Next song'})
  ]);
  const currentVol = audioEl ? audioEl.volume : 0.8;
  const vol = el('input',{type:'range',min:'0',max:'1',step:'0.05',value:String(currentVol), 'aria-label':'Volume'});
  vol.addEventListener('input', ()=>{ getAudio().volume = parseFloat(vol.value); });

  const progressWrap = el('div',{class:'progress-wrap'},[seek, timeRow]);
  const controlsWrap = el('div',{style:'display:flex;flex-direction:column;align-items:center;width:100%;max-width:420px;'},[
    controls, progressWrap,
    el('div',{style:'display:flex;align-items:center;gap:8px;margin-top:10px;width:140px;'},[
      el('span',{style:'font-size:12px;color:#ac6b73;font-weight:bold;','aria-hidden':'true',text:'🔊'}),
      vol
    ])
  ]);

  const playlistBox = el('div',{class:'playlist'});
  playlistBox.appendChild(el('h3',{text:'Playlist', style:'margin:0 0 12px 0;font-size:16px;color:#606c38;display:flex;align-items:center;gap:8px;'}));
  songs.forEach((s,i)=>{
    const track = el('div',{class:'track'+(i===state.playingIndex?' active':'')});
    track.appendChild(el('div',{class:'num',text:toRoman(i+1)}));
    const meta = el('div',{class:'meta',role:'button',tabindex:'0','aria-label':'Play '+s.title});
    const titleRow = el('div',{class:'t',text:s.title});
    if(i===state.playingIndex && state.isPlaying){
      titleRow.appendChild(el('span',{class:'sound-bars','aria-hidden':'true'},[
        el('span',{class:'sound-bar'}), el('span',{class:'sound-bar'}), el('span',{class:'sound-bar'})
      ]));
    }
    meta.appendChild(titleRow);
    if(s.artist) meta.appendChild(el('div',{class:'a',text:s.artist}));
    meta.style.cursor='pointer';
    meta.addEventListener('click', ()=>loadTrack(i,true));
    meta.addEventListener('keydown', e=>{ if(e.key==='Enter' || e.key===' '){ e.preventDefault(); loadTrack(i,true); } });
    track.appendChild(meta);
    if(state.mode==='creator'){
      track.appendChild(el('button',{onclick:()=>moveSong(i,-1),text:'↑','aria-label':'Move up'}));
      track.appendChild(el('button',{onclick:()=>moveSong(i,1),text:'↓','aria-label':'Move down'}));
      track.appendChild(el('button',{onclick:()=>removeSong(i),text:'✕','aria-label':'Remove song'}));
    }
    playlistBox.appendChild(track);
  });

  const children = [
    el('div',{class:'top-bar'},[
      state.mode==='creator' ? el('span',{class:'badge',id:'song-count',style:'margin-left:auto;font-size:12px;box-shadow:0 2px 6px rgba(77,14,18,0.08);',text: songs.length+' / '+MAX_SONGS+' songs'}) : el('span')
    ]),
    playerStage, controlsWrap,
    el('div',{id:'err-slot','aria-live':'assertive'}),
    playlistBox
  ];

  if(state.mode==='creator'){
    const t = el('input',{type:'text',placeholder:'Song title',maxlength:'120','aria-label':'Song title'});
    const a = el('input',{type:'text',placeholder:'Artist (optional)',maxlength:'120','aria-label':'Artist'});
    const u = el('input',{type:'text',placeholder:'Direct audio link (https://… .mp3, .wav, .m4a, .ogg)',inputmode:'url',autocomplete:'off',maxlength:'500','aria-label':'Audio URL'});
    t.value = state.draft.title; a.value = state.draft.artist; u.value = state.draft.url;
    [[t,'title'],[a,'artist'],[u,'url']].forEach(([inp,k])=> inp.addEventListener('input', ()=>{ state.draft[k] = inp.value; }));
    const atMax = songs.length >= MAX_SONGS;
    const addBox = el('div',{class:'add-song'},[
      el('div',{style:'display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:10px;'},[
        el('div',{},[el('label',{text:'Title'}), t]),
        el('div',{},[el('label',{text:'Artist'}), a])
      ]),
      el('label',{text:'Audio URL'}), u,
      el('div',{class:'hint',style:'margin-top:8px;font-size:12px;',text:'Use a direct link to an audio file. Streaming pages (YouTube, Spotify, …) can’t be played here.'}),
      el('div',{style:'margin-top:14px;text-align:right;'},[el('button',{class:'btn ghost',disabled:atMax,onclick:addSong,text: atMax ? 'Playlist full' : '+ Add song'})])
    ]);
    children.push(addBox);
    children.push(el('div',{id:'save-hint',class:'hint',style:'margin-top:16px;','aria-live':'polite'}));
    children.push(el('button',{class:'btn',id:'save-btn',style:'margin-top:8px;',onclick:saveLetter,text:'Save gift and get a share link'}));
    children.push(el('button',{class:'btn ghost',style:'margin-top:12px;',onclick:()=>{state.view='letter';render();},text:'Back to letter'}));
  } else {
    children.push(el('p',{class:'hint',style:'margin-top:20px;font-style:italic;',text:'This is a personal gift someone made for you.'}));
  }

  screen(children, 'vinyl-section');
  // show the first song's duration without downloading the whole file
  if(songs.length) setTrack(state.playingIndex);
  updateProgressUI();
  syncVinylForm();
  if(state.isPlaying) startNoteEmitter();
}

function addSong(){
  const {title, artist, url} = state.draft;
  if(state.letter.songs.length >= MAX_SONGS){
    state.loadError = 'You can add up to '+MAX_SONGS+' songs.';
    syncVinylForm(); return;
  }
  if(!title.trim() || !url.trim()){
    state.loadError = 'Enter at least a title and an audio URL.';
    syncVinylForm(); return;
  }
  const parsed = parseAudioUrl(url);
  if(!parsed.url){ state.loadError = parsed.error; syncVinylForm(); return; }
  state.letter.songs.push({title:title.trim().slice(0,120), artist:artist.trim().slice(0,120), url:parsed.url});
  state.draft = {title:'',artist:'',url:''};
  state.loadError='';
  state.saveFp = '';
  scheduleDraftSave();
  render();
}
function removeSong(i){
  state.letter.songs.splice(i,1);
  if(i < state.playingIndex) state.playingIndex--;
  if(state.playingIndex>=state.letter.songs.length) state.playingIndex=0;
  state.loadError = '';
  state.saveFp = '';
  scheduleDraftSave();
  render();
}
function moveSong(i,dir){
  const j = i+dir;
  if(j<0 || j>=state.letter.songs.length) return;
  const s = state.letter.songs;
  [s[i],s[j]] = [s[j],s[i]];
  if(state.playingIndex === i) state.playingIndex = j; else if(state.playingIndex === j) state.playingIndex = i;
  state.saveFp = '';
  scheduleDraftSave();
  render();
}

const PLINTH_SVG = '<svg class="plinth-svg" viewBox="0 0 256 256" aria-hidden="true">'
  + '<defs>'
  + '<pattern id="plinth-lattice" width="24" height="24" patternUnits="userSpaceOnUse">'
  + '<path d="M 0 12 L 12 0 L 24 12 L 12 24 Z" fill="none" stroke="rgba(212,175,55,0.2)" stroke-width="0.75"/>'
  + '<circle cx="12" cy="12" r="1.2" fill="rgba(212,175,55,0.35)"/>'
  + '<circle cx="0" cy="0" r="0.9" fill="rgba(96,108,56,0.25)"/>'
  + '<circle cx="24" cy="0" r="0.9" fill="rgba(96,108,56,0.25)"/>'
  + '<circle cx="0" cy="24" r="0.9" fill="rgba(96,108,56,0.25)"/>'
  + '<circle cx="24" cy="24" r="0.9" fill="rgba(96,108,56,0.25)"/>'
  + '</pattern>'
  + '<g id="corner-fleur">'
  + '<path d="M 7 38 L 7 17 Q 7 7 17 7 L 38 7" fill="none" stroke="rgba(212,175,55,0.9)" stroke-width="1.6" stroke-linecap="round"/>'
  + '<path d="M 12 32 L 12 18 Q 12 12 18 12 L 32 12" fill="none" stroke="rgba(77,14,18,0.35)" stroke-width="0.8" stroke-linecap="round"/>'
  + '<path d="M 21 21 C 18 15 14 16 15 19 C 15 23 20 25 21 27 C 22 25 27 23 27 19 C 28 16 24 15 21 21 Z" fill="rgba(212,175,55,0.78)" stroke="rgba(77,14,18,0.5)" stroke-width="0.6"/>'
  + '<circle cx="21" cy="15" r="1.5" fill="#d4af37"/>'
  + '<circle cx="36" cy="17" r="1.5" fill="#d4af37"/>'
  + '<circle cx="17" cy="36" r="1.5" fill="#d4af37"/>'
  + '<path d="M 24 24 L 32 32" stroke="rgba(212,175,55,0.7)" stroke-width="1" stroke-linecap="round"/>'
  + '<circle cx="33" cy="33" r="1.8" fill="#4d0e12" stroke="#d4af37" stroke-width="0.6"/>'
  + '</g>'
  + '</defs>'
  + '<rect x="0" y="0" width="256" height="256" rx="20" fill="url(#plinth-lattice)"/>'
  + '<circle cx="128" cy="128" r="115" fill="none" stroke="rgba(212,175,55,0.55)" stroke-width="1.2" stroke-dasharray="3 4"/>'
  + '<circle cx="128" cy="128" r="118" fill="none" stroke="rgba(77,14,18,0.28)" stroke-width="0.75"/>'
  + '<circle cx="128" cy="128" r="121" fill="none" stroke="rgba(212,175,55,0.38)" stroke-width="0.6"/>'
  + '<circle cx="128" cy="7" r="2.2" fill="#d4af37" stroke="#4d0e12" stroke-width="0.6"/>'
  + '<circle cx="128" cy="249" r="2.2" fill="#d4af37" stroke="#4d0e12" stroke-width="0.6"/>'
  + '<circle cx="7" cy="128" r="2.2" fill="#d4af37" stroke="#4d0e12" stroke-width="0.6"/>'
  + '<circle cx="249" cy="128" r="2.2" fill="#d4af37" stroke="#4d0e12" stroke-width="0.6"/>'
  + '<use href="#corner-fleur"/>'
  + '<use href="#corner-fleur" transform="translate(256, 0) scale(-1, 1)"/>'
  + '<use href="#corner-fleur" transform="translate(0, 256) scale(1, -1)"/>'
  + '<use href="#corner-fleur" transform="translate(256, 256) scale(-1, -1)"/>'
  + '</svg>';

/* ---------- saved ---------- */
function renderSaved(){
  const code = state.shareCode;
  const url = shareUrl(code);
  const copy = async (text, msg)=>{
    try{ await navigator.clipboard.writeText(text); showToast(msg); }
    catch(e){ showToast(text); }
  };
  const buttons = [
    el('button',{class:'btn',onclick:()=>copy(url,'Gift link copied to clipboard!'),text:'Copy link'}),
    el('button',{class:'btn ghost',onclick:()=>copy(formatCode(code),'Gift code copied to clipboard!'),text:'Copy code'})
  ];
  if(navigator.share){
    buttons.push(el('button',{class:'btn ghost',onclick:()=>{ navigator.share({title:'A gift for you', text:'I made you a keepsake letter.', url}).catch(()=>{}); },text:'Share…'}));
  }
  const manageKey = store.get('mlfy:manage:' + code) || state.manageToken;
  screen([
    el('div',{class:'brand',text:'A Letter For You'}),
    el('div',{class:'home-card'},[
      el('h2',{text:'Your gift is ready'}),
      el('p',{text:'Send this link to the person you made it for. They can also type the code on the home screen to unseal their envelope.'}),
      el('div',{class:'share-box'},[
        el('div',{class:'hint',text:'Gift link',style:'letter-spacing:.1em;text-transform:uppercase;'}),
        el('div',{class:'share-link',id:'share-link',text:url}),
        el('div',{class:'hint',text:'Gift code',style:'letter-spacing:.1em;text-transform:uppercase;margin-top:14px;'}),
        el('div',{class:'code',style:'font-size:20px;letter-spacing:.14em;word-break:break-all;',text:formatCode(code)}),
        el('div',{class:'hint',text:'Anyone with this link can open the gift — share it only with the person it’s for. It stays available until you delete it.'})
      ]),
      el('div',{class:'row',style:'margin-top:24px;'},buttons.concat([
        el('button',{class:'btn ghost',onclick:()=>{state.view='home';state.mode=null;render();},text:'Done'})
      ])),
      manageKey ? el('details',{class:'manage-box'},[
        el('summary',{text:'Manage this gift'}),
        el('p',{text:'Your private management key lets you delete this gift later, from any device (keep it secret). It is also remembered in this browser.'}),
        el('code',{text:manageKey}),
        el('div',{style:'margin-top:12px;'},[ el('button',{class:'btn danger',onclick:deleteGift,text:'Delete this gift'}) ])
      ]) : null
    ])
  ]);
}

/* =====================================================================
   Init
   ===================================================================== */
window.__giftApp = { state, render, loadLetter, startCreate, openEnvelope, goVinyl, addSong, normalizeCode, isCode };

(function init(){
  const m = /^\/g\/([^/?#]+)/.exec(location.pathname);
  if(m){
    // Recipient opened a share link: the g.html shell already shows a loading state.
    loadLetter(decodeURIComponent(m[1]));
    return;
  }
  const staticHome = app.querySelector('[data-static="home"]');
  if(state.view === 'home' && staticHome){
    // Hydrate the server-rendered home screen instead of rebuilding it (keeps the LCP image in place).
    renderedView = 'home';
    const c = document.getElementById('btn-create'), k = document.getElementById('btn-code');
    if(c) c.addEventListener('click', startCreate);
    if(k) k.addEventListener('click', goEnterCode);
    const run = ()=> idle(warmAfterHome);
    if(document.readyState === 'complete') run(); else window.addEventListener('load', run, {once:true});
    return;
  }
  render();
})();

})();
