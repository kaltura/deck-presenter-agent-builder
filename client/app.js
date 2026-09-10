import { Management } from '@kaltura/intelligent-agents/management';
import { KalturaAvatarSession, CaptionService } from '@kaltura/intelligent-agents/experience';
import { Presenter } from '@kaltura/intelligent-agents/experience/presenter';
import { createNoiseSuppressor } from '@kaltura/intelligent-agents/experience/noise-suppressor';
import { parseSections } from './prompt-format.js';

// ── Config (bundle.mjs rewrites these four before esbuild runs) ──
const PARTNER_ID = 0;
const WIDGET_ID = 'WIDGET_ID_UNSET';
const PDF_URL = './data/deck.pdf';
const VERSION = '0.1.7';
const SDK_VERSION = '0.0.0';

const AUTO_PLAY_DELAY_MS = 10000;
const AUTO_PLAY_AFTER_QUESTION_MS = 15000;
const RECENT_INTERACTION_MS = 5000;
const NAV_NUDGE_PREFIX = '[SLIDE CHANGE]';
const RESUME_CUE_PREFIX = '[RESUMED]';
const CONTACT_FORM_PREFIX = '[CONTACT FORM]';
const CONTACT_STORAGE_KEY = 'deck_presenter_contact_v1';
const GOODBYE_GRACE_MS = 45000;
const GOODBYE_PHRASE_RE = /\b(good ?bye|bye+!?|see ya|farewell|that'?s all|i'?m done|gotta go|talk later)\b/i;
const APP_MARKERS = [NAV_NUDGE_PREFIX, RESUME_CUE_PREFIX, '[NAV HINT:', CONTACT_FORM_PREFIX];
const CONTACT_COOLDOWN_MS = 60000;
const CHAT_IDLE_MS = 12000;
const CHAT_LOG_IDLE_MS = 12000;
const TYPED_ECHO_WINDOW_MS = 60000;

const stripAppText = (t) => {
  let out = t || '';
  for (const marker of APP_MARKERS) {
    const idx = out.indexOf(marker);
    if (idx !== -1) out = out.slice(0, idx);
  }
  return out.trim();
};

// ── Bundle-time data (loadData() fills these; see the function below) ──
let SLIDE_DATA = [];
let NAV_PROMPTS = { navNudges: {}, navHint: '', routeAnswers: {} };

// Tool names come from this project's own content.mjs (via bundle.mjs), never
// hardcoded here. Empty string means the project didn't enable that tool —
// the corresponding feature (contact form / end-session handling) then stays
// inert rather than silently degrading.
let TOOL_NAMES = { nav: '', contact: '', endSession: '' };

// Live-caption pronunciation replacements, derived from this project's own
// prompts/pronunciation-guide.md by bundle.mjs. Empty by default in dev mode.
let CAPTION_MAP = {};

// Per-project branding overrides layered onto these neutral defaults by
// bundle.mjs (from project.json's optional `branding` object).
let BRANDING = {
  primaryColor: '#3b82f6',
  accentColor: '#8b5cf6',
  welcomeTitle: 'AI Presenter',
  welcomeSubtitle: 'An AI-narrated presentation with live Q&A',
};

// Optional per-project chapter grouping ({label, start, end}[]) for the table
// of contents. No project.json field or bundler wiring exists yet, so this
// stays empty and buildTOC() falls back to one flat list of every slide.
let CHAPTERS = [];

// Optional topic -> slide routing hints for typed questions that don't match
// any nav-tool call. No project.json field or bundler wiring exists yet, so
// this stays empty and routeHint() is a no-op until it's populated.
let TOPIC_ROUTES = [];

// Context handed to the SDK's Presenter for prompt-building. No project.json
// field or bundler wiring exists yet for this either.
let PRESENTER_CONTEXT = {};

// Whether the avatar's voice/likeness is a fresh synthetic build ('fresh') or
// cloned from a real person's recorded voice/likeness ('cloned'). Drives the
// synthetic-content label (PLAN.md 10). No project.json field or bundler
// wiring exists yet — bundle.mjs never rewrites this, so it stays 'fresh'
// until that wiring exists.
let AVATAR_SOURCE = 'fresh';

let CAPTION_REPLACEMENT_RULES = [];
function buildCaptionRules() {
  CAPTION_REPLACEMENT_RULES = Object.entries(CAPTION_MAP)
    .sort((a, b) => b[0].length - a[0].length)
    .map(([from, to]) => {
      const escaped = from.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const startsWord = /^[a-zA-Z]/.test(from);
      const endsWord = /[a-zA-Z]$/.test(from);
      return { re: new RegExp(`${startsWord ? '\\b' : ''}${escaped}${endsWord ? '\\b' : ''}`, 'gi'), to };
    });
}
function toReadableText(text) {
  if (!text) return text;
  let result = text;
  for (const { re, to } of CAPTION_REPLACEMENT_RULES) result = result.replace(re, to);
  return result;
}

const totalSlides = () => SLIDE_DATA.length;

const el = {
  versionTag: document.getElementById('version-tag'),
  btnDownloadPdf: document.getElementById('btn-download-pdf'),
  btnTranscript: document.getElementById('btn-transcript'),
  btnClearMemory: document.getElementById('btn-clear-memory'),

  startOverlay: document.getElementById('start-overlay'),
  welcomeStep: document.getElementById('welcome-step'),
  disclaimerStep: document.getElementById('disclaimer-step'),
  welcomeTitle: document.getElementById('welcome-title'),
  welcomeSubtitle: document.getElementById('welcome-subtitle'),
  btnContinue: document.getElementById('btn-continue'),
  btnStart: document.getElementById('btn-start'),

  btnPrivacy: document.getElementById('btn-privacy'),
  privacyPanel: document.getElementById('privacy-panel'),
  btnClosePrivacy: document.getElementById('btn-close-privacy'),

  tocSidebar: document.getElementById('toc-sidebar'),
  tocContent: document.getElementById('toc-content'),
  btnTocToggle: document.getElementById('btn-toc-toggle'),
  btnTocClose: document.getElementById('btn-toc-close'),

  presentationContainer: document.getElementById('presentation-container'),
  slideWrapper: document.getElementById('slide-wrapper'),
  pdfCanvas: document.getElementById('pdf-canvas'),
  annotationLayer: document.getElementById('annotation-layer'),

  avatarPip: document.getElementById('avatar-pip'),
  avatarLoading: document.getElementById('avatar-loading'),
  avatarPauseOverlay: document.getElementById('avatar-pause-overlay'),
  aiContentLabel: document.getElementById('ai-content-label'),

  captionContainer: document.getElementById('caption-container'),
  captionText: document.getElementById('caption-text'),

  slideBadge: document.getElementById('slide-badge'),

  chatLogWrapper: document.getElementById('chat-log-wrapper'),
  chatLog: document.getElementById('chat-log'),
  chatToggle: document.getElementById('chat-toggle'),
  chatForm: document.getElementById('chat-form'),
  chatInput: document.getElementById('chat-input'),

  btnPrev: document.getElementById('btn-prev'),
  btnNext: document.getElementById('btn-next'),
  progressBar: document.getElementById('progress-bar'),
  progressFill: document.getElementById('progress-fill'),
  slideJumpInput: document.getElementById('slide-jump-input'),
  slideCounter: document.getElementById('slide-counter'),

  autoplayControl: document.getElementById('autoplay-control'),
  btnAutoplayToggle: document.getElementById('btn-autoplay-toggle'),
  autoplayRingProgress: document.getElementById('autoplay-ring-progress'),
  autoplayDigits: document.getElementById('autoplay-digits'),
  autoplayStatus: document.getElementById('autoplay-status'),

  btnCc: document.getElementById('btn-cc'),
  btnMute: document.getElementById('btn-mute'),

  transcriptPanel: document.getElementById('transcript-panel'),
  transcriptContent: document.getElementById('transcript-content'),

  statusToast: document.getElementById('status-toast'),

  contactModal: document.getElementById('contact-modal'),
  contactForm: document.getElementById('contact-form'),
  contactName: document.getElementById('contact-name'),
  contactEmail: document.getElementById('contact-email'),
  contactCompany: document.getElementById('contact-company'),
  contactMessage: document.getElementById('contact-message'),
  btnContactSkip: document.getElementById('btn-contact-skip'),

  sessionEnded: document.getElementById('session-ended'),
  sessionEndedTitle: document.getElementById('session-ended-title'),
  sessionEndedMessage: document.getElementById('session-ended-message'),
  btnRestartSession: document.getElementById('btn-restart-session'),
};

// ── State ──
let session = null;
let presenter = null;
let captions = null;
let avatarSpeaking = false;
let isPaused = false;
let ccEnabled = false;
let micMuted = false;
let micPausedForForm = false;
let contactClosedAt = 0;
let autoPlayEnabled = true;
let autoPlayTimer = null;
let countdownTicker = null;
let countdownEndsAt = 0;
let countdownDurationMs = 0;
let userInteractedRecently = false;
let userInteractionTimer = null;
let lastAvatarTextEndedWithQuestion = false;
let pdfDoc = null;
let renderGeneration = 0;
let currentRenderTask = null;
let lastChatMessage = '';
let avatarBubble = null;
let avatarBubbleAt = 0;
let lastBubbleRole = null;
let lastBubbleText = '';
const pendingTypedTexts = new Map();
let pendingNavNudge = null;
let resumeSlide = 0;
let pendingResume = 0;
const cleanInterests = (list) => Array.isArray(list) ? [...new Set(list.map((s) => String(s).trim()).filter(Boolean))].slice(0, 12) : [];
const recentTypedTexts = new Map();
let sessionEnded = false;
let goodbyePending = false;
let goodbyeGraceTimer = null;
let deckPausedAfterGoodbye = false;
let contactModalOpen = false;
let contactSubmitted = false;
let chatIdleTimer = null;
let chatLogIdleTimer = null;
let pageUnloading = false;

const RING_CIRCUMFERENCE = 2 * Math.PI * 25;

// ── Data loading (bundle.mjs finds this function by name+brace and replaces
// its whole body with literal SLIDE_DATA/NAV_PROMPTS/TOOL_NAMES/CAPTION_MAP/
// BRANDING assignments at build time. In local dev, this fetches instead.) ──
async function loadData() {
  const slides = [];
  for (let n = 1; ; n += 1) {
    const num = String(n).padStart(2, '0');
    const res = await fetch(`./data/slides/${num}.json`);
    if (!res.ok) break;
    slides.push(await res.json());
  }
  SLIDE_DATA = slides;

  const fetchText = (path) => fetch(path).then((r) => {
    if (!r.ok) throw new Error(`${path} failed to load (${r.status})`);
    return r.text();
  });
  const [navNudges, navHint, routeAnswers] = await Promise.all([
    fetchText('./prompts/client/nav-nudges.md'),
    fetchText('./prompts/client/nav-hint.md'),
    fetchText('./prompts/client/route-answers.md'),
  ]);
  NAV_PROMPTS = {
    navNudges: parseSections(navNudges),
    navHint: navHint.trim(),
    routeAnswers: parseSections(routeAnswers),
  };
}

function applyBranding() {
  document.documentElement.style.setProperty('--brand-primary', BRANDING.primaryColor);
  document.documentElement.style.setProperty('--brand-accent', BRANDING.accentColor);
  if (el.welcomeTitle) el.welcomeTitle.textContent = BRANDING.welcomeTitle;
  if (el.welcomeSubtitle) el.welcomeSubtitle.textContent = BRANDING.welcomeSubtitle;
  document.title = BRANDING.welcomeTitle;
}

function applyAvatarSourceLabel() {
  el.aiContentLabel.hidden = AVATAR_SOURCE !== 'cloned';
}

// ── Table of contents ──
function buildTOC() {
  el.tocContent.innerHTML = '';
  const chapters = CHAPTERS.length ? CHAPTERS : [{ label: 'Slides', start: 1, end: totalSlides() }];
  chapters.forEach((section, idx) => {
    const header = document.createElement('button');
    header.className = 'toc-section-header';
    header.type = 'button';
    header.textContent = section.label;
    const body = document.createElement('div');
    body.className = 'toc-section-body';
    if (idx !== 0) body.classList.add('hidden');
    for (let n = section.start; n <= section.end; n += 1) {
      const slide = SLIDE_DATA[n - 1];
      const item = document.createElement('button');
      item.type = 'button';
      item.className = 'toc-slide-item';
      item.dataset.slide = String(n);
      item.textContent = `${n}. ${slide?.title || `Slide ${n}`}`;
      item.addEventListener('click', () => {
        el.tocSidebar.classList.add('collapsed');
        goToSlide(n, 'toc');
      });
      body.appendChild(item);
    }
    header.addEventListener('click', () => body.classList.toggle('hidden'));
    el.tocContent.appendChild(header);
    el.tocContent.appendChild(body);
  });
}

function updateTOCHighlight(slideNum) {
  el.tocContent.querySelectorAll('.toc-slide-item').forEach((item) => {
    item.classList.toggle('active', Number(item.dataset.slide) === slideNum);
  });
}

// ── Nav nudge text ──
function nextSlideClose(slideNum) {
  if (slideNum >= totalSlides()) return '';
  const next = SLIDE_DATA[slideNum]?.title;
  if (!next) return '';
  const template = NAV_PROMPTS.navNudges['close-segue'] || '';
  return ` ${template.replaceAll('{{next}}', next)}`;
}

function navNudgeText(section, slideNum) {
  const slide = SLIDE_DATA[slideNum - 1];
  const template = NAV_PROMPTS.navNudges[section] || NAV_PROMPTS.navNudges.default || '';
  return `${NAV_NUDGE_PREFIX} ${template
    .replaceAll('{{title}}', slide?.title || `slide ${slideNum}`)
    .replaceAll('{{close}}', nextSlideClose(slideNum))}`;
}

// ── Topic routing hint for typed questions (inert until TOPIC_ROUTES is populated) ──
function routeHint(text) {
  if (!TOPIC_ROUTES.length) return '';
  const lower = text.toLowerCase();
  const match = TOPIC_ROUTES.find((r) => r.keywords.some((k) => lower.includes(k)));
  if (!match) return '';
  const slide = SLIDE_DATA[match.slide - 1];
  return `[NAV HINT: ${NAV_PROMPTS.navHint
    .replaceAll('{{slide}}', String(match.slide))
    .replaceAll('{{title}}', slide?.title || '')
    .replaceAll('{{current}}', String(currentSlideNum))}]`;
}

// ── Typed-question echo/resend robustness ──
function normalizeTyped(text) {
  return (text || '').trim().toLowerCase().replace(/\s+/g, ' ');
}
function rememberTyped(text) {
  const key = normalizeTyped(text);
  recentTypedTexts.set(key, Date.now());
  for (const [k, at] of recentTypedTexts) {
    if (Date.now() - at > TYPED_ECHO_WINDOW_MS) recentTypedTexts.delete(k);
  }
}
function consumeTypedEcho(text) {
  const key = normalizeTyped(text);
  if (recentTypedTexts.has(key)) {
    recentTypedTexts.delete(key);
    return true;
  }
  return false;
}
function sendTyped(text) {
  const trimmed = text.trim();
  if (!trimmed) return;
  rememberTyped(trimmed);
  const hint = routeHint(trimmed);
  const payload = hint ? `${trimmed}\n${hint}` : trimmed;
  pendingTypedTexts.set(normalizeTyped(trimmed), { text: trimmed, at: Date.now(), tries: 0 });
  appendChatMessage(trimmed, 'user');
  speakInterrupting(payload);
  markUserInteraction();
  resetChatIdleTimer();
}
function resendTyped(entry) {
  entry.tries += 1;
  speakInterrupting(entry.text);
}
function resendIfStalled() {
  const now = Date.now();
  for (const entry of pendingTypedTexts.values()) {
    if (now - entry.at > CHAT_IDLE_MS && entry.tries < 1) resendTyped(entry);
  }
}
function resetChatIdleTimer() {
  clearTimeout(chatIdleTimer);
  chatIdleTimer = setTimeout(resendIfStalled, CHAT_IDLE_MS);
}
// KalturaAvatarSession has no sendText(): typed/nudge text goes through speak(),
// and a mid-utterance send needs interrupt() first or the server queues it behind
// the avatar's current turn instead of running it now.
function speakInterrupting(text) {
  if (!session || sessionEnded) return;
  // The SDK can deliver the agent's first navigate_to_slide tool call before
  // session.state flips to 'connected' (connect() resolves after the join
  // handshake, but a queued tool-call event can land in the same tick). Wait
  // for 'connected' rather than assume it, so an early slide-change nudge
  // doesn't throw KalturaError('speak() requires a connected session').
  const send = () => {
    if (!session || sessionEnded) return;
    if (session.state === 'connected') { session.speak(text); return; }
    let fired = false;
    const offState = session.on('stateChange', (state) => {
      if (fired || state !== 'connected') return;
      fired = true;
      offState();
      if (session && !sessionEnded) session.speak(text);
    });
    setTimeout(() => { if (!fired) offState(); }, 5000);
  };
  if (!(session.speaking || avatarSpeaking)) { send(); return; }
  let done = false;
  let off = () => {};
  const fire = () => { if (done) return; done = true; off(); send(); };
  off = session.on('interrupted', fire);
  try { session.interrupt(); } catch { /* not connected: fall through to the timer */ }
  setTimeout(fire, 800);
}

// ── Navigation ──
let currentSlideNum = 1;
function resumeTarget() {
  return pendingResume > 0 ? pendingResume : 0;
}
function goToSlide(n, reason = 'user') {
  if (n < 1 || n > totalSlides()) return;
  presenter?.goTo(n, reason);
}

// ── Chat log rendering ──
function appendChatMessage(text, role) {
  const rendered = toReadableText(stripAppText(text)).trim();
  if (!rendered) return null;
  if (role === lastBubbleRole && rendered === lastBubbleText) return null;
  const bubble = document.createElement('div');
  bubble.className = role === 'user' ? 'chat-msg chat-msg-user' : 'chat-msg chat-msg-avatar';
  bubble.textContent = rendered;
  el.chatLog.appendChild(bubble);
  el.chatLog.scrollTop = el.chatLog.scrollHeight;
  el.chatLogWrapper.classList.remove('idle');
  clearTimeout(chatLogIdleTimer);
  chatLogIdleTimer = setTimeout(() => el.chatLogWrapper.classList.add('idle'), CHAT_LOG_IDLE_MS);
  lastBubbleRole = role;
  lastBubbleText = rendered;
  return bubble;
}

function addDebugEntry(text) {
  if (!el.transcriptContent) return;
  const line = document.createElement('p');
  line.textContent = `${new Date().toLocaleTimeString()} — ${text}`;
  el.transcriptContent.appendChild(line);
}

function showToast(message, kind = 'info') {
  el.statusToast.textContent = message;
  el.statusToast.className = `status-toast ${kind}`;
  el.statusToast.classList.remove('hidden');
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => el.statusToast.classList.add('hidden'), 4000);
}

// ── Slide UI ──
function updateSlideUI(n) {
  currentSlideNum = n;
  el.slideCounter.textContent = `/ ${totalSlides()}`;
  el.slideJumpInput.value = String(n);
  el.progressFill.style.width = `${(n / totalSlides()) * 100}%`;
  el.slideBadge.textContent = `Slide ${n} of ${totalSlides()}`;
  el.slideBadge.classList.remove('flash');
  requestAnimationFrame(() => el.slideBadge.classList.add('flash'));
  updateTOCHighlight(n);
  renderPage(n);
}

function onSlideChange(n, reason) {
  updateSlideUI(n);
  if (reason === 'resume') pendingResume = 0;
  const nudgeReason = pendingNavNudge || reason || 'default';
  pendingNavNudge = null;
  speakInterrupting(navNudgeText(nudgeReason, n));
}

// ── PDF rendering ──
async function loadPDF() {
  try {
    const loadingTask = window.pdfjsLib.getDocument(PDF_URL);
    pdfDoc = await loadingTask.promise;
    el.slideJumpInput.max = String(totalSlides());
    await renderPage(currentSlideNum);
  } catch (err) {
    addDebugEntry(`PDF load failed: ${err.message}`);
  }
}

async function renderPage(n) {
  if (!pdfDoc) return;
  const generation = ++renderGeneration;
  if (currentRenderTask) {
    try { currentRenderTask.cancel(); } catch { /* already done */ }
    // cancel() doesn't settle task.promise synchronously — starting a new render
    // on the same canvas before the old one settles can leave it hung forever.
    await currentRenderTask.promise.catch(() => {});
  }
  if (generation !== renderGeneration) return;
  try {
    const page = await pdfDoc.getPage(Math.min(n, pdfDoc.numPages));
    if (generation !== renderGeneration) return;
    const unscaled = page.getViewport({ scale: 1 });
    // Measure the outer container, not slideWrapper: slideWrapper is inline-block and
    // sized BY its own canvas child, so measuring it here would be circular.
    const containerWidth = el.presentationContainer.clientWidth || 1280;
    const containerHeight = el.presentationContainer.clientHeight || 720;
    const scale = Math.min(containerWidth / unscaled.width, containerHeight / unscaled.height);
    const viewport = page.getViewport({ scale });
    const dpr = window.devicePixelRatio || 1;
    el.pdfCanvas.width = Math.floor(viewport.width * dpr);
    el.pdfCanvas.height = Math.floor(viewport.height * dpr);
    el.pdfCanvas.style.width = `${Math.floor(viewport.width)}px`;
    el.pdfCanvas.style.height = `${Math.floor(viewport.height)}px`;
    el.slideWrapper.style.setProperty('--slide-h', `${Math.floor(viewport.height)}px`);
    updateCaptionOffset();
    const ctx = el.pdfCanvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    currentRenderTask = page.render({ canvasContext: ctx, viewport });
    await currentRenderTask.promise;
  } catch (err) {
    if (err?.name !== 'RenderingCancelledException') addDebugEntry(`Render failed: ${err.message}`);
  }
}

function debounce(fn, ms) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}
new ResizeObserver(debounce(() => renderPage(currentSlideNum), 100)).observe(el.presentationContainer);

// ── Contact form ──
function openContactModal(reason) {
  if (!TOOL_NAMES.contact || contactModalOpen || contactSubmitted) return;
  if (Date.now() - contactClosedAt < CONTACT_COOLDOWN_MS) return;
  contactModalOpen = true;
  pauseAvatarForForm();
  el.contactModal.classList.remove('hidden');
  addDebugEntry(`contact form opened (${reason})`);
}
function pauseAvatarForForm() {
  micPausedForForm = true;
  session?.pauseMic?.();
}
function closeContactModal() {
  contactModalOpen = false;
  contactClosedAt = Date.now();
  el.contactModal.classList.add('hidden');
  el.contactForm.reset();
  micPausedForForm = false;
  session?.resumeMic?.();
}
function submitContact(ev) {
  ev.preventDefault();
  const payload = {
    name: el.contactName.value.trim(),
    email: el.contactEmail.value.trim(),
    company: el.contactCompany.value.trim(),
    message: el.contactMessage.value.trim(),
    at: Date.now(),
  };
  try {
    window.localStorage.setItem(CONTACT_STORAGE_KEY, JSON.stringify(payload));
  } catch { /* storage may be unavailable; the submission still proceeds */ }
  contactSubmitted = true;
  speakInterrupting(`${CONTACT_FORM_PREFIX} The viewer submitted their contact details. Do not read the email address back to them; thank them briefly and continue.`);
  showToast('Thanks! Your details were shared with the team.', 'info');
  closeContactModal();
}
function skipContact() {
  closeContactModal();
}

// ── Goodbye / session end ──
function handleGoodbye() {
  if (!TOOL_NAMES.endSession || goodbyePending) return;
  goodbyePending = true;
  deckPausedAfterGoodbye = true;
  addDebugEntry('goodbye detected — grace period started');
  goodbyeGraceTimer = setTimeout(() => {
    session?.disconnect();
    showSessionEnded('goodbye');
  }, GOODBYE_GRACE_MS);
}
function cancelGoodbyeGrace() {
  if (!goodbyePending) return;
  clearTimeout(goodbyeGraceTimer);
  goodbyePending = false;
  deckPausedAfterGoodbye = false;
}

function showSessionEnded(reason) {
  sessionEnded = true;
  const messages = {
    goodbye: "Thanks for joining! Start a new session anytime to keep exploring — it'll pick up where you left off.",
    expired: 'This session has ended. Start a new one to keep going — the deck picks up where you left off.',
    error: 'The avatar connection ended unexpectedly. Start a new session to try again.',
  };
  el.sessionEndedMessage.textContent = messages[reason] || messages.error;
  el.sessionEnded.classList.remove('hidden');
  presenter?.saveMemory?.();
}

// ── Autoplay ──
function cancelAutoPlay() {
  clearTimeout(autoPlayTimer);
  autoPlayTimer = null;
  hideCountdown();
}
function scheduleAutoPlay(delay = AUTO_PLAY_DELAY_MS) {
  cancelAutoPlay();
  if (!autoPlayEnabled || isPaused || sessionEnded || deckPausedAfterGoodbye) return;
  const wait = lastAvatarTextEndedWithQuestion ? AUTO_PLAY_AFTER_QUESTION_MS : delay;
  showCountdown(wait);
  autoPlayTimer = setTimeout(() => {
    if (currentSlideNum < totalSlides() && !userInteractedRecently && !avatarSpeaking) {
      goToSlide(currentSlideNum + 1, 'autoplay');
    }
  }, wait);
}
function showCountdown(ms) {
  countdownEndsAt = Date.now() + ms;
  countdownDurationMs = ms;
  el.autoplayRingProgress.style.strokeDasharray = String(RING_CIRCUMFERENCE);
  clearInterval(countdownTicker);
  countdownTicker = setInterval(updateCountdownDigits, 250);
  updateCountdownDigits();
}
function updateCountdownDigits() {
  const remaining = Math.max(0, countdownEndsAt - Date.now());
  const seconds = Math.ceil(remaining / 1000);
  const elapsedFraction = countdownDurationMs > 0 ? 1 - remaining / countdownDurationMs : 1;
  el.autoplayDigits.textContent = autoPlayEnabled ? String(seconds) : '';
  el.autoplayStatus.textContent = autoPlayEnabled ? `Advancing in ${seconds} seconds` : '';
  el.autoplayRingProgress.style.strokeDashoffset = String(RING_CIRCUMFERENCE * Math.min(1, Math.max(0, elapsedFraction)));
  if (remaining <= 0) clearInterval(countdownTicker);
}
function hideCountdown() {
  clearInterval(countdownTicker);
  el.autoplayDigits.textContent = '';
  el.autoplayStatus.textContent = '';
  el.autoplayRingProgress.style.strokeDashoffset = String(RING_CIRCUMFERENCE);
}
function markUserInteraction() {
  userInteractedRecently = true;
  clearTimeout(userInteractionTimer);
  userInteractionTimer = setTimeout(() => { userInteractedRecently = false; }, RECENT_INTERACTION_MS);
}
function setAutoPlayUI(enabled) {
  autoPlayEnabled = enabled;
  el.btnAutoplayToggle.setAttribute('aria-pressed', String(enabled));
  if (enabled) scheduleAutoPlay();
  else cancelAutoPlay();
}

function togglePause() {
  if (!session) return;
  isPaused = !isPaused;
  el.avatarPauseOverlay.classList.toggle('hidden', !isPaused);
  el.avatarPip.classList.toggle('paused', isPaused);
  el.avatarPip.setAttribute('aria-pressed', String(isPaused));
  if (isPaused) {
    cancelAutoPlay();
    session.pause?.();
  } else {
    session.resume?.();
    presenter?.refreshContext();
    speakInterrupting(`${RESUME_CUE_PREFIX} The viewer has resumed — briefly continue where you left off.`);
    scheduleAutoPlay();
  }
}

// ── Draggable avatar pip / chat log ──
function initAvatarDrag() {
  let dragging = false;
  let didDrag = false;
  let startX = 0;
  let startY = 0;
  let offsetX = 0;
  let offsetY = 0;
  el.avatarPip.addEventListener('pointerdown', (ev) => {
    dragging = true;
    didDrag = false;
    startX = ev.clientX;
    startY = ev.clientY;
    const rect = el.avatarPip.getBoundingClientRect();
    offsetX = ev.clientX - rect.left;
    offsetY = ev.clientY - rect.top;
    el.avatarPip.setPointerCapture(ev.pointerId);
  });
  el.avatarPip.addEventListener('pointermove', (ev) => {
    if (!dragging) return;
    if (!didDrag && (Math.abs(ev.clientX - startX) > 4 || Math.abs(ev.clientY - startY) > 4)) {
      didDrag = true;
      el.avatarPip.classList.add('dragging');
    }
    if (!didDrag) return;
    const parent = el.slideWrapper.getBoundingClientRect();
    el.avatarPip.style.left = `${ev.clientX - parent.left - offsetX}px`;
    el.avatarPip.style.top = `${ev.clientY - parent.top - offsetY}px`;
    el.avatarPip.style.right = 'auto';
    el.avatarPip.style.bottom = 'auto';
  });
  el.avatarPip.addEventListener('pointerup', () => {
    if (dragging && !didDrag) togglePause();
    dragging = false;
    el.avatarPip.classList.remove('dragging');
  });
  el.avatarPip.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); togglePause(); }
  });
}

function clampChatLogWrapperPosition() {
  const rect = el.chatLogWrapper.getBoundingClientRect();
  const parent = el.slideWrapper.getBoundingClientRect();
  if (rect.right > parent.right) el.chatLogWrapper.style.left = `${parent.width - rect.width - 8}px`;
  if (rect.bottom > parent.bottom) el.chatLogWrapper.style.top = `${parent.height - rect.height - 8}px`;
}

function updateCaptionOffset() {
  const pipRect = el.avatarPip.getBoundingClientRect();
  const containerRect = el.slideWrapper.getBoundingClientRect();
  const bottomGap = containerRect.bottom - pipRect.top;
  el.slideWrapper.style.setProperty('--caption-bottom', `${Math.max(84, bottomGap + 12)}px`);
}

function initChatLogDrag() {
  let dragging = false;
  let didDrag = false;
  let suppressClick = false;
  let startX, startY, startLeft, startTop;

  function onDown(clientX, clientY) {
    dragging = true;
    didDrag = false;
    const rect = el.chatLogWrapper.getBoundingClientRect();
    const parentRect = el.slideWrapper.getBoundingClientRect();
    startX = clientX;
    startY = clientY;
    startLeft = rect.left - parentRect.left;
    startTop = rect.top - parentRect.top;
  }
  function onMove(clientX, clientY) {
    if (!dragging) return;
    const dx = clientX - startX;
    const dy = clientY - startY;
    if (Math.abs(dx) > 4 || Math.abs(dy) > 4) didDrag = true;
    if (!didDrag) return;
    el.chatLogWrapper.classList.add('dragging');
    const parentRect = el.slideWrapper.getBoundingClientRect();
    const maxLeft = parentRect.width - el.chatLogWrapper.offsetWidth;
    const maxTop = parentRect.height - el.chatLogWrapper.offsetHeight;
    const left = Math.min(Math.max(0, startLeft + dx), Math.max(0, maxLeft));
    const top = Math.min(Math.max(0, startTop + dy), Math.max(0, maxTop));
    el.chatLogWrapper.style.left = `${left}px`;
    el.chatLogWrapper.style.top = `${top}px`;
    el.chatLogWrapper.style.right = 'auto';
    el.chatLogWrapper.style.bottom = 'auto';
  }
  function onUp() {
    if (dragging && didDrag) suppressClick = true;
    dragging = false;
    el.chatLogWrapper.classList.remove('dragging');
    clampChatLogWrapperPosition();
  }

  el.chatToggle.addEventListener('mousedown', (ev) => onDown(ev.clientX, ev.clientY));
  window.addEventListener('mousemove', (ev) => onMove(ev.clientX, ev.clientY));
  window.addEventListener('mouseup', onUp);
  el.chatToggle.addEventListener('touchstart', (ev) => onDown(ev.touches[0].clientX, ev.touches[0].clientY), { passive: true });
  window.addEventListener('touchmove', (ev) => onMove(ev.touches[0].clientX, ev.touches[0].clientY), { passive: true });
  window.addEventListener('touchend', onUp);
  el.chatToggle.addEventListener('click', (ev) => {
    if (suppressClick) { suppressClick = false; ev.preventDefault(); return; }
    el.chatLogWrapper.classList.toggle('collapsed');
  });
}

// ── SDK session wiring ──
async function initAvatar() {
  const video = document.createElement('video');
  video.autoplay = true;
  video.playsInline = true;
  el.avatarPip.insertBefore(video, el.avatarPip.firstChild);

  const audio = document.createElement('audio');
  audio.autoplay = true;
  audio.style.display = 'none';
  document.body.appendChild(audio);

  if (WIDGET_ID === 'WIDGET_ID_UNSET') {
    throw new Error('WIDGET_ID is not set. Build with node engine/bundle.mjs (it reads the widget id from .provisioning-state.json, or pass --widget-id).');
  }

  const mgmt = new Management({ partnerId: PARTNER_ID });
  let token = await mgmt.sessions.createWidgetToken({ widgetId: WIDGET_ID });
  let init;
  try {
    init = await mgmt.application.appInit(token.ks);
  } catch (err) {
    if (err.status === 401 || err.code === 'unauthorized') {
      token = await mgmt.sessions.createWidgetToken({ widgetId: WIDGET_ID });
      init = await mgmt.application.appInit(token.ks);
    } else {
      throw err;
    }
  }

  const gatedMicProcessor = createNoiseSuppressor();

  session = new KalturaAvatarSession({
    token: init.ks,
    conversationManagerUrl: init.conversationManagerUrl,
    srsBaseUrl: init.srsBaseUrl,
    turnServerUrl: init.turnServerUrl,
    videoEl: video,
    audioEl: audio,
    socketFactory: (url, opts) => window.io(url, opts),
    micStartMode: 'deferred',
    noiseProcessor: gatedMicProcessor,
    toolSpiralLimit: 3,
    hardToolSpiralLimit: 5,
  });

  presenter = new Presenter({
    session,
    slides: SLIDE_DATA,
    context: PRESENTER_CONTEXT,
    onSlideChange,
    storage: window.localStorage,
    toolCallName: TOOL_NAMES.nav,
    deckOutline: true,
    extraMemory: (questions) => ({ interests: cleanInterests(questions) }),
    restoreMemory: (m) => ({ interests: cleanInterests(m.interests) }),
  });

  const last = presenter.memory?.lastSlide;
  resumeSlide = typeof last === 'number' && last > 1 && last < totalSlides() ? last : 0;
  pendingResume = resumeSlide;
  if (resumeSlide) addDebugEntry(`resume armed: slide ${resumeSlide}`);

  const presenterGoTo = presenter.goTo.bind(presenter);
  presenter.goTo = (n, reason = 'user') => {
    if (contactModalOpen) return;
    if (resumeTarget() && reason !== 'resume') {
      const target = resumeTarget();
      pendingResume = 0;
      pendingNavNudge = 'resume';
      presenterGoTo(target, 'resume');
      return;
    }
    pendingNavNudge = reason;
    presenterGoTo(n, reason);
  };

  registerSessionEvents(session);

  if (TOOL_NAMES.contact) {
    session.onToolCall(TOOL_NAMES.contact, (args) => openContactModal(args?.reason || 'agent'));
  }
  if (TOOL_NAMES.endSession) {
    session.onToolCall(TOOL_NAMES.endSession, () => handleGoodbye());
  }
  session.onToolCall(TOOL_NAMES.nav, (args, call) => {
    if (call.toolMetadata?.waitForResponse && call.toolMetadata.id) {
      session.respondToTool(call.toolMetadata.id, { ok: true, slide_num: args?.slide_num ?? null });
    }
  });

  try {
    await session.connect();
  } catch (err) {
    showToast('Could not connect to the avatar. Please refresh.', 'error');
    throw err;
  }

  try {
    await session.startMic();
    addDebugEntry('mic started');
  } catch (err) {
    const micErrors = {
      NotAllowedError: 'Microphone access was denied. Allow it in your browser settings to talk with the avatar.',
      NotFoundError: 'No microphone was found on this device.',
    };
    showToast(micErrors[err.code] || micErrors[err.name] || 'Could not start the microphone.', 'warn');
  }

  await presenter.start();
  updateSlideUI(1);
  scheduleAutoPlay();

  captions = new CaptionService(session, { replacements: CAPTION_MAP });
  captions.onCaption(({ text, clear }) => {
    if (!ccEnabled) return;
    el.captionText.textContent = clear ? '' : toReadableText(text);
  });

  window.addEventListener('beforeunload', () => {
    pageUnloading = true;
    presenter?.saveMemory();
    presenter?.destroy();
    session?.disconnect();
  });
}

function registerSessionEvents(sess) {
  sess.on('stateChange', (state) => {
    addDebugEntry(`state: ${state}`);
    if (state === 'connecting') showToast('Connecting to the avatar…', 'info');
  });
  sess.on('streamReady', () => addDebugEntry('stream ready'));
  sess.on('mediaReady', () => el.avatarLoading.classList.add('hidden'));
  sess.on('error', (err) => {
    addDebugEntry(`error: ${err?.message || err}`);
    showToast('Something went wrong with the avatar connection.', 'error');
  });
  sess.on('warning', (warning) => {
    if (warning?.code === 'playback_blocked') {
      showToast("Click anywhere to enable the avatar's voice.", 'info');
      const onClick = () => { sess.startPlayback(); document.removeEventListener('click', onClick); };
      document.addEventListener('click', onClick, { once: true });
    }
  });

  sess.on('avatarStartTalking', () => { avatarSpeaking = true; el.avatarPip.classList.add('thinking'); });
  sess.on('avatarStopTalking', () => { avatarSpeaking = false; el.avatarPip.classList.remove('thinking'); });
  sess.on('interrupted', () => { avatarSpeaking = false; });
  sess.on('transcript', ({ type, text }) => {
    if (type === 'partial' || !text) return;
    if (type === 'user') {
      if (consumeTypedEcho(text)) return;
      appendChatMessage(text, 'user');
      markUserInteraction();
      if (TOOL_NAMES.endSession && GOODBYE_PHRASE_RE.test(text)) handleGoodbye();
      else cancelGoodbyeGrace();
    } else {
      lastAvatarTextEndedWithQuestion = /\?\s*$/.test(text.trim());
      const now = Date.now();
      if (avatarBubble && now - avatarBubbleAt < 4000) {
        avatarBubble.textContent = toReadableText(stripAppText(`${lastChatMessage} ${text}`));
      } else {
        avatarBubble = appendChatMessage(text, 'avatar');
      }
      avatarBubbleAt = now;
      lastChatMessage = text;
    }
  });
  sess.on('brainSegment', () => {});
  sess.on('responsePending', () => {});
  sess.on('responseSettled', () => { scheduleAutoPlay(); });

  sess.on('reconnecting', () => showToast('Reconnecting…', 'warn'));
  sess.on('reconnected', () => showToast('Reconnected.', 'info'));
  sess.on('brainStalled', () => {
    addDebugEntry('brain stalled — resending resume instruction');
    speakInterrupting(`${RESUME_CUE_PREFIX} You stalled mid-response. In one short sentence, resume where you left off on slide ${currentSlideNum}. Do not navigate to a different slide.`);
  });
  sess.on('capacityChanged', () => {});
  sess.on('toolSpiralDetected', () => addDebugEntry('tool spiral detected'));
  sess.on('toolSpiralRecovering', () => addDebugEntry('tool spiral recovering'));
  sess.on('spiralRecovered', () => addDebugEntry('tool spiral recovered'));

  sess.on('disclosure', (info) => {
    if (info?.text) showToast(info.text, 'info');
  });
  sess.on('timeWarning', ({ remainingTime }) => {
    showToast(`This session is ending in about ${Math.max(1, Math.round((remainingTime || 0) / 1000))}s.`, 'warn');
  });
  sess.on('timeExpired', () => showSessionEnded('expired'));
  sess.on('ended', () => { if (!pageUnloading) showSessionEnded(goodbyePending ? 'goodbye' : 'error'); });
}

// ── Event binding ──
function bindEvents() {
  el.btnContinue.addEventListener('click', () => {
    el.welcomeStep.classList.add('hidden');
    el.disclaimerStep.classList.remove('hidden');
    el.disclaimerStep.scrollTop = 0;
  });
  el.btnStart.addEventListener('click', async () => {
    el.startOverlay.classList.add('hidden');
    try {
      await initAvatar();
    } catch (err) {
      addDebugEntry(`start failed: ${err.message}`);
      showToast('Could not start the avatar session. Please refresh.', 'error');
    }
  });

  el.btnPrivacy.addEventListener('click', () => el.privacyPanel.classList.remove('hidden'));
  el.btnClosePrivacy.addEventListener('click', () => el.privacyPanel.classList.add('hidden'));

  el.btnTocToggle.addEventListener('click', () => el.tocSidebar.classList.toggle('collapsed'));
  el.btnTocClose.addEventListener('click', () => el.tocSidebar.classList.add('collapsed'));

  el.btnPrev.addEventListener('click', () => { markUserInteraction(); goToSlide(currentSlideNum - 1, 'user'); });
  el.btnNext.addEventListener('click', () => { markUserInteraction(); goToSlide(currentSlideNum + 1, 'user'); });
  el.slideJumpInput.addEventListener('change', () => {
    const n = Number(el.slideJumpInput.value);
    if (Number.isInteger(n)) { markUserInteraction(); goToSlide(n, 'jump'); }
  });

  el.btnAutoplayToggle.addEventListener('click', () => setAutoPlayUI(!autoPlayEnabled));

  el.btnCc.addEventListener('click', () => {
    ccEnabled = !ccEnabled;
    el.btnCc.setAttribute('aria-pressed', String(ccEnabled));
    el.captionContainer.classList.toggle('hidden', !ccEnabled);
    if (!ccEnabled) el.captionText.textContent = '';
  });
  el.btnMute.addEventListener('click', () => {
    if (micPausedForForm) return;
    micMuted = !micMuted;
    el.btnMute.setAttribute('aria-pressed', String(micMuted));
    const audioEl = document.querySelector('audio');
    if (audioEl) audioEl.muted = micMuted;
  });

  el.chatForm.addEventListener('submit', (ev) => {
    ev.preventDefault();
    const text = el.chatInput.value;
    el.chatInput.value = '';
    if (!text.trim()) return;
    if (TOOL_NAMES.endSession && GOODBYE_PHRASE_RE.test(text)) handleGoodbye();
    sendTyped(text);
  });

  el.contactForm.addEventListener('submit', submitContact);
  el.btnContactSkip.addEventListener('click', skipContact);

  el.btnRestartSession.addEventListener('click', () => window.location.reload());

  el.btnTranscript.addEventListener('click', () => el.transcriptPanel.classList.toggle('hidden'));
  el.btnClearMemory.addEventListener('click', () => { presenter?.clearMemory?.(); showToast('Memory cleared.', 'info'); });

  document.addEventListener('keydown', (ev) => {
    if (ev.target.tagName === 'INPUT' || ev.target.tagName === 'TEXTAREA') return;
    if (ev.key === 'c' || ev.key === 'C') el.btnCc.click();
    if (ev.key === 'ArrowRight') el.btnNext.click();
    if (ev.key === 'ArrowLeft') el.btnPrev.click();
    if (ev.key === ' ') { ev.preventDefault(); togglePause(); }
  });

  window.addEventListener('resize', clampChatLogWrapperPosition);
}

// ── Boot ──
async function init() {
  applyBranding();
  el.btnDownloadPdf.href = PDF_URL;

  const debugMode = new URLSearchParams(window.location.search).has('debug');
  el.btnTranscript.classList.toggle('hidden', !debugMode);
  el.btnClearMemory.classList.toggle('hidden', !debugMode);
  if (debugMode) el.versionTag.textContent = `app v${VERSION} · SDK v${SDK_VERSION}`;
  el.versionTag.classList.toggle('hidden', !debugMode);

  try {
    await loadData();
  } catch (err) {
    document.body.innerHTML = `<div style="padding:40px;font-family:sans-serif;color:#fff;">Failed to load presentation data: ${err.message}</div>`;
    return;
  }
  buildCaptionRules();
  applyAvatarSourceLabel();

  bindEvents();
  buildTOC();
  initAvatarDrag();
  initChatLogDrag();
  updateCaptionOffset();

  el.chatLogWrapper.classList.add('collapsed');
  setAutoPlayUI(autoPlayEnabled);

  await loadPDF();
}

init();
