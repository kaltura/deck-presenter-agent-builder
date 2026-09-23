import { Management } from '@kaltura/intelligent-agents/management';
import { KalturaAvatarSession, CaptionService } from '@kaltura/intelligent-agents/experience';
import { Presenter } from '@kaltura/intelligent-agents/experience/presenter';
import { createNoiseSuppressor } from '@kaltura/intelligent-agents/experience/noise-suppressor';
import { parseSections } from './prompt-format.js';
import { normalizeTyped, typedTextsMatch } from './echo-match.js';
import { isWithinCooldown } from './nav-cooldown.js';
import { levelAt, statsSummary } from './mic-stats.js';
import { navAckPayload } from './nav-ack.js';
import { peekResumeSlide } from './presenter-memory.js';
import { autoPlayBlocked, autoPlayBlockers, STAY_HERE_PHRASE_RE } from './autoplay-state.js';

// ── Config (bundle.mjs rewrites these four before esbuild runs) ──
const PARTNER_ID = 0;
const WIDGET_ID = 'WIDGET_ID_UNSET';
const PDF_URL = './data/deck.pdf';
const VERSION = '0.1.21';
const SDK_VERSION = '0.0.0';

const AUTO_PLAY_DELAY_MS = 10000;
const AVATAR_CONNECT_TIMEOUT_MS = 20000;
const AUTO_PLAY_AFTER_QUESTION_MS = 15000;
const NAV_NUDGE_PREFIX = '[SLIDE CHANGE]';
const RESUME_CUE_PREFIX = '[RESUMED]';
const CONTACT_FORM_PREFIX = '[CONTACT FORM]';
const CONTACT_STORAGE_KEY = 'deck_presenter_contact_v1';
const GOODBYE_GRACE_MS = 45000;
const GOODBYE_PHRASE_RE = /\b(good ?bye|bye+!?|see ya|farewell|that'?s all|i'?m done|gotta go|talk later)\b/i;
const APP_MARKERS = [NAV_NUDGE_PREFIX, RESUME_CUE_PREFIX, '[NAV HINT:', CONTACT_FORM_PREFIX];
const CONTACT_COOLDOWN_MS = 60000;
const NAV_BLOCK_AFTER_CONTACT_MS = 2500;
const CHAT_LOG_IDLE_MS = 12000;
const TYPED_ECHO_WINDOW_MS = 60000;
// A typed question sent while the avatar is mid-sentence, or in the first
// second of a new slide's narration, can sit unprocessed on the server with
// no echo back. Resend once if no echo (or a brain stall) arrives within
// this window. 20s, not a few seconds: a real echo round trip can be slow.
const TYPED_ECHO_TIMEOUT_MS = 20000;

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
// hardcoded here. Empty string means the project didn't enable that tool, so
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
// of contents, remapped by bundle.mjs from project.json's chapters field.
// Empty when a project declares no chapters, and buildTOC() then falls back
// to one flat list of every slide.
let CHAPTERS = [];

// Optional topic -> slide routing hints for typed questions that don't match
// any nav-tool call, remapped by bundle.mjs from data/routes.json (itself a
// deterministic render of data/nav-rules.json). Empty when a project has no
// topic-tagged nav rules, and routeHint() is then a no-op.
let TOPIC_ROUTES = [];

// Context handed to the SDK's Presenter for prompt-building. No project.json
// field or bundler wiring exists yet for this either.
let PRESENTER_CONTEXT = {};

// Whether the avatar's voice/likeness is a fresh synthetic build ('fresh') or
// cloned from a real person's recorded voice/likeness ('cloned'), rewritten by
// bundle.mjs from project.json avatar.source. Drives the synthetic-content
// label (ARCHITECTURE.md 10).
let AVATAR_SOURCE = 'fresh';

// The AI-disclosure line's text, rewritten by bundle.mjs from project.json
// disclosure.text (falling back to the toolkit default when that's blank).
let DISCLOSURE_TEXT = "This experience is presented by an AI avatar. It is not a human, and it cannot make commitments on anyone's behalf.";

// Who to show in the privacy panel as responsible for audience data,
// rewritten by bundle.mjs from project.json's privacy fields.
let PRIVACY = { controllerName: '', controllerContact: '' };

// Where, besides the persistent chrome label, to additionally show the
// synthetic-content label when AVATAR_SOURCE is 'cloned'. Rewritten by
// bundle.mjs from project.json avatar.syntheticLabelPlacement. Only 'welcome'
// is supported today.
let SYNTHETIC_LABEL_PLACEMENT = [];

// True only when avatar.source is 'cloned' and the project owner explicitly
// acknowledged suppressing the synthetic-content label (project.json
// overrides.acknowledgeWarnings). Rewritten by bundle.mjs.
let SUPPRESS_SYNTHETIC_LABEL = false;

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
  disclosureLine: document.getElementById('disclosure-line'),
  aiContentLabelWelcome: document.getElementById('ai-content-label-welcome'),
  btnContinue: document.getElementById('btn-continue'),
  btnStart: document.getElementById('btn-start'),

  disclaimerScroll: document.getElementById('disclaimer-scroll'),

  btnPrivacy: document.getElementById('btn-privacy'),
  privacyPanel: document.getElementById('privacy-panel'),
  privacyController: document.getElementById('privacy-controller'),
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
  avatarLoadingLabel: document.getElementById('avatar-loading-label'),
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
  slideSeek: document.getElementById('slide-seek'),
  slideLabel: document.getElementById('slide-label'),
  slideJumpInput: document.getElementById('slide-jump-input'),

  autoplayControl: document.getElementById('autoplay-control'),
  btnAutoplayToggle: document.getElementById('btn-autoplay-toggle'),
  autoplayRingProgress: document.getElementById('autoplay-ring-progress'),
  autoplayDigits: document.getElementById('autoplay-digits'),
  autoplayStatus: document.getElementById('autoplay-status'),

  btnCc: document.getElementById('btn-cc'),
  btnMute: document.getElementById('btn-mute'),
  iconUnmuted: document.getElementById('icon-unmuted'),
  iconMuted: document.getElementById('icon-muted'),
  btnMicMute: document.getElementById('btn-mic-mute'),
  iconMicOn: document.getElementById('icon-mic-on'),
  iconMicOff: document.getElementById('icon-mic-off'),

  transcriptPanel: document.getElementById('transcript-panel'),
  transcriptBody: document.getElementById('transcript-body'),
  btnDownloadTranscript: document.getElementById('btn-download-transcript'),
  btnCloseTranscript: document.getElementById('btn-close-transcript'),
  micStats: document.getElementById('mic-stats'),

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
let viewerMicMuted = false;
let micPausedForForm = false;
let contactClosedAt = 0;

// ── Mic input statistics: numbers only, no audio, no text. Kept in memory, shown as one
// in-place line in the debug panel and as a short block at the end of the downloaded log. ──
const MIC_GATE_DB = -50;
const MIC_STATS_TICK_MS = 100;
const micStats = { ctx: null, raw: null, gated: null, buf: null, timer: null, ticks: 0, hist: new Uint32Array(101), openTicks: 0, openings: 0, gateOpen: false, turns: 0, shortTurns: 0, bargeIns: 0 };
let autoPlayEnabled = true;
// Set by a manual move to an earlier slide, cleared by the next forward move.
// Otherwise autoplay would send the visitor straight back to where they just
// asked to leave, and the deck ping-pongs between the two slides.
let autoPlayHeldAfterBack = false;
let autoPlayTimer = null;
let countdownTicker = null;
let countdownEndsAt = 0;
let countdownDurationMs = 0;
// The disclaimer has been acknowledged and the avatar is allowed to speak and
// to toast connection status. Set once, in startSession().
let sessionRevealed = false;
// An SDK 'disclosure' event that arrived before sessionRevealed, held for the reveal.
let pendingDisclosureText = null;
// Autoplay starts only once the scripted opening has finished (openingDone) AND
// the deck is actually presenting: the visitor replied, or a slide changed. The
// opening ends on a question, so its end must not start a countdown off slide 1.
let openingDone = false;
let deckPresenting = false;
// A real visitor turn puts the current slide into Q&A mode: the next countdown
// waits AUTO_PLAY_AFTER_QUESTION_MS instead of the short default.
let visitorInQnA = false;
// Local mic voice activity, tracked separately from the server's own speech
// detection: a barge-in can end the avatar's turn while the visitor is still
// mid-sentence, and the server's own signal can arrive seconds late.
let visitorSpeaking = false;
let visitorSilenceTimer = null;
const VISITOR_SILENCE_MS = 1500;
// Caps how long steady background noise (never recognized as real speech by the
// server) can hold autoplay. Real speech is covered by replyPending instead.
let visitorSpeakingMaxTimer = null;
const VISITOR_SPEAKING_MAX_MS = 12000;
// A barge-in, or server-detected speech, means a reply is coming even if local
// voice detection stays silent (a suspended AudioContext, some mic setups).
let replyPending = false;
let replyPendingTimer = null;
const REPLY_PENDING_MAX_MS = 20000;
// Mirrors the session's own responsePending/responseSettled events, for the
// autoplay gate and the avatar pip's pending cue.
let responsePending = false;
let memoryCleared = false;
let lastAvatarTextEndedWithQuestion = false;
let pdfDoc = null;
let renderGeneration = 0;
let currentRenderTask = null;
let lastChatMessage = '';
let avatarBubble = null;
let avatarBubbleAt = 0;
let lastBubbleRole = null;
let lastBubbleText = '';
let pendingNavNudge = null;
const cleanInterests = (list) => Array.isArray(list) ? [...new Set(list.map((s) => String(s).trim()).filter(Boolean))].slice(0, 12) : [];
let recentTypedTexts = []; // { norm, at } of texts the user typed; the server echoes them back as 'user' transcripts
let awaitingTyped = null; // { norm, payload, resent } for the typed question still waiting on its echo
let sessionEnded = false;
let goodbyePending = false;
let goodbyeGraceTimer = null;
let deckPausedAfterGoodbye = false;
// The brain can answer a goodbye with an end-session tool call after the visitor
// has already moved on to another slide. That call must not end the session.
let visitorNavigatedSinceMessage = false;
let contactModalOpen = false;
let contactSubmitted = false;
let contactDeclined = false;
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

function applyDisclosure() {
  if (el.disclosureLine) el.disclosureLine.textContent = DISCLOSURE_TEXT;
}

function applyPrivacy() {
  if (!el.privacyController) return;
  const { controllerName, controllerContact } = PRIVACY;
  el.privacyController.textContent = `${controllerName || '[controller name]'} - ${controllerContact || '[controller contact]'}`;
}

function applyAvatarSourceLabel() {
  const showLabel = AVATAR_SOURCE === 'cloned' && !SUPPRESS_SYNTHETIC_LABEL;
  el.aiContentLabel.hidden = !showLabel;
  if (el.aiContentLabelWelcome) {
    el.aiContentLabelWelcome.hidden = !(showLabel && SYNTHETIC_LABEL_PLACEMENT.includes('welcome'));
  }
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
  if (slideNum >= totalSlides() || autoPlayHeldAfterBack) return '';
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
function rememberTyped(text) {
  const now = Date.now();
  recentTypedTexts = recentTypedTexts.filter((t) => now - t.at < TYPED_ECHO_WINDOW_MS);
  recentTypedTexts.push({ norm: normalizeTyped(text), at: now });
}
// True when a 'user' transcript is the server echoing text we already showed on Send.
function consumeTypedEcho(text) {
  const norm = normalizeTyped(text);
  if (!norm) return false;
  const now = Date.now();
  const idx = recentTypedTexts.findIndex((t) => now - t.at < TYPED_ECHO_WINDOW_MS && typedTextsMatch(t.norm, norm));
  if (idx === -1) return false;
  recentTypedTexts.splice(idx, 1);
  return true;
}
function resendTyped(reason) {
  if (!awaitingTyped || awaitingTyped.resent || !session || sessionEnded || contactModalOpen) return;
  awaitingTyped.resent = true;
  addDebugEntry(`resend (${reason}): ${awaitingTyped.payload.slice(0, 60)}`);
  speakInterrupting(awaitingTyped.payload);
}
function resendIfStalled(count) {
  if (count !== 1) return;
  // A typed question awaiting its echo gets its own text resent, so the
  // resume cue below never overrides what the viewer actually asked. Any
  // other stall (mid-narration, no pending typed question) still needs the
  // documented recovery (implementation-appendix.md's health-events table):
  // nudge the current slide by name, or the avatar sits silently frozen.
  if (awaitingTyped) { resendTyped('brain stalled'); return; }
  if (!session || sessionEnded || contactModalOpen) return;
  addDebugEntry(`resend (brain stalled): resume cue for slide ${currentSlideNum}`);
  speakInterrupting(`${RESUME_CUE_PREFIX} You stalled mid-response. In one short sentence, resume where you left off on slide ${currentSlideNum}. Do not navigate to a different slide.`);
}
function sendTyped(text) {
  if (!session || sessionEnded) return;
  const trimmed = text.trim();
  if (!trimmed) return;
  rememberTyped(trimmed);
  visitorNavigatedSinceMessage = false;
  const hint = routeHint(trimmed);
  const payload = hint ? `${trimmed}\n${hint}` : trimmed;
  const pending = { norm: normalizeTyped(trimmed), payload, resent: false };
  awaitingTyped = pending;
  appendChatMessage(trimmed, 'user');
  speakInterrupting(payload);
  markUserInteraction();
  setTimeout(() => {
    if (awaitingTyped !== pending) return;
    resendTyped('no echo');
  }, TYPED_ECHO_TIMEOUT_MS);
}
// speak() throws disclosure_required until startSession() acknowledges the
// disclosure, which happens only after connect() resolves. Text typed while the
// session is still connecting waits for the ack instead of being dropped.
let disclosureAcked = false;
let resolveDisclosureAcked;
const disclosureAckedPromise = new Promise((resolve) => { resolveDisclosureAcked = resolve; });

// KalturaAvatarSession has no sendText(): typed/nudge text goes through speak(),
// and a mid-utterance send needs interrupt() first or the server queues it behind
// the avatar's current turn instead of running it now.
function speakInterrupting(text) {
  if (!session || sessionEnded) return;
  if (!disclosureAcked) { disclosureAckedPromise.then(() => speakInterrupting(text)); return; }
  // The SDK can deliver the agent's first navigate_to_slide tool call before
  // session.state flips to 'connected' (connect() resolves after the join
  // handshake, but a queued tool-call event can land in the same tick). Wait
  // for 'connected' rather than assume it, so an early slide-change nudge
  // doesn't throw KalturaError('speak() requires a connected session').
  const speak = () => session.speak(text).catch((err) => addDebugEntry(`speak failed: ${err.code || err.message}`));
  const send = () => {
    if (!session || sessionEnded) return;
    if (session.state === 'connected') { speak(); return; }
    let fired = false;
    const offState = session.on('stateChange', ({ state } = {}) => {
      if (fired || state !== 'connected') return;
      fired = true;
      offState();
      if (session && !sessionEnded) speak();
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

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function micAudioContext() {
  if (!micStats.ctx) micStats.ctx = new AudioContext();
  return micStats.ctx;
}
function tapMicStream(stream) {
  const ctx = micAudioContext();
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 2048;
  ctx.createMediaStreamSource(stream).connect(analyser);
  return analyser;
}
function analyserDb(analyser, buf) {
  analyser.getFloatTimeDomainData(buf);
  let sum = 0;
  for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
  const rms = Math.sqrt(sum / buf.length);
  return rms > 0 ? Math.max(-100, Math.min(0, 20 * Math.log10(rms))) : -100;
}
// cfg.noiseProcessor: the SDK noise gate, with level taps before and after it for the stats.
async function gatedMicProcessor(raw) {
  const ctx = micAudioContext();
  ctx.resume?.().catch(() => {});
  const gate = await createNoiseSuppressor({ audioContext: ctx, thresholdDb: MIC_GATE_DB })(raw);
  micStats.raw = tapMicStream(raw);
  micStats.gated = tapMicStream(gate.stream);
  micStats.buf = new Float32Array(2048);
  clearInterval(micStats.timer);
  micStats.timer = setInterval(micStatsTick, MIC_STATS_TICK_MS);
  return { stream: gate.stream, stop() { clearInterval(micStats.timer); micStats.timer = null; gate.stop(); } };
}
function micStatsTick() {
  if (viewerMicMuted || micPausedForForm || !micStats.raw) return;
  const rawDb = analyserDb(micStats.raw, micStats.buf);
  const open = analyserDb(micStats.gated, micStats.buf) > -75;
  micStats.ticks++;
  micStats.hist[Math.round(-rawDb)]++; // bin i = -i dBFS
  if (open) micStats.openTicks++;
  if (open && !micStats.gateOpen) micStats.openings++;
  micStats.gateOpen = open;
  if (micStats.ticks % 50 === 0) renderMicStats();
}
function micStatsSummary() {
  return statsSummary(micStats, MIC_STATS_TICK_MS, MIC_GATE_DB);
}
function renderMicStats() {
  const m = micStatsSummary();
  if (!m || !el.micStats) return;
  el.micStats.textContent = `mic · floor ${levelAt(micStats.hist, micStats.ticks, 0.9)} · speech ${levelAt(micStats.hist, micStats.ticks, 0.1)} dBFS · gate open ${Math.round(100 * micStats.openTicks / micStats.ticks)}% (${micStats.openings}) · voice turns ${micStats.turns} (${micStats.shortTurns} short, ${micStats.bargeIns} barge-in) · ${m.sampled.split(' ')[0]}`;
  el.micStats.classList.remove('hidden');
}

function addDebugEntry(text) {
  // Kept even when the transcript panel is hidden or missing, so a browser
  // harness can read exact startup timings from it.
  (window.__debugTimeline ||= []).push({ tMs: performance.now(), text });
  if (!el.transcriptBody) return;
  const empty = el.transcriptBody.querySelector('.transcript-empty');
  if (empty) empty.remove();
  const line = document.createElement('div');
  line.className = 'transcript-entry';
  const ts = new Date().toLocaleTimeString();
  line.innerHTML = `<span class="transcript-ts">${ts}</span> ${escapeHtml(text)}`;
  el.transcriptBody.appendChild(line);
  el.transcriptBody.scrollTop = el.transcriptBody.scrollHeight;
}

function showToast(message, kind = 'info', { sticky = false } = {}) {
  el.statusToast.textContent = message;
  el.statusToast.className = `status-toast ${kind}`;
  el.statusToast.classList.remove('hidden');
  clearTimeout(showToast._t);
  if (!sticky) showToast._t = setTimeout(() => el.statusToast.classList.add('hidden'), 4000);
}

// ── Slide UI ──
function updateSlideUI(n) {
  currentSlideNum = n;
  el.slideLabel.textContent = `${n} / ${totalSlides()}`;
  el.slideJumpInput.value = String(n);
  el.slideSeek.value = String(n);
  el.slideSeek.style.setProperty('--progress', `${(n / totalSlides()) * 100}%`);
  el.slideBadge.textContent = `Slide ${n} of ${totalSlides()}`;
  el.slideBadge.classList.remove('flash');
  requestAnimationFrame(() => el.slideBadge.classList.add('flash'));
  updateTOCHighlight(n);
  renderPage(n);
}

function onSlideChange(n, _slide, reason) {
  // A slide change after a goodbye means the visitor is still watching, so the
  // pending disconnect must not cut off the slide that is starting now.
  cancelGoodbyeGrace();
  deckPausedAfterGoodbye = false;
  if (!['avatar', 'resume', 'autoplay'].includes(reason)) visitorNavigatedSinceMessage = true;
  deckPresenting = true;
  visitorInQnA = false;
  cancelAutoPlay();
  updateSlideUI(n);
  // Keep the intellect's rejoin hint current so a reconnect mid-deck resumes
  // from where the visitor actually is, not from the join-time snapshot.
  if (session?.state === 'connected') {
    const label = SLIDE_DATA[n - 1]?.title;
    session.updateRequestVars({ rejoin_slide: n, ...(label ? { rejoin_label: label } : {}) });
  }
  const nudgeReason = pendingNavNudge || reason || 'default';
  pendingNavNudge = null;
  // A nav tool call ('avatar', 'resume') lands mid-turn while the brain waits for
  // the ack, and the ack already carries this slide's content. A nudge sent now
  // would start a new turn and cancel the answer the brain is about to give.
  if (nudgeReason === 'avatar' || nudgeReason === 'resume') return;
  speakInterrupting(navNudgeText(nudgeReason, n));
}

// ── PDF rendering ──
async function loadPDF() {
  try {
    // Debug-only override so the E2E suite can point rendering at a scratch PDF
    // fixture without touching the deck the avatar actually knows about.
    const params = new URLSearchParams(window.location.search);
    const url = params.has('debug') && params.get('pdf') ? params.get('pdf') : PDF_URL;
    const loadingTask = window.pdfjsLib.getDocument(url);
    pdfDoc = await loadingTask.promise;
    el.slideJumpInput.max = String(totalSlides());
    el.slideSeek.max = String(totalSlides());
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
    // cancel() doesn't settle task.promise synchronously. Starting a new render
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
    if (generation !== renderGeneration) return;
    await renderAnnotations(page, viewport);
  } catch (err) {
    if (err?.name !== 'RenderingCancelledException') addDebugEntry(`Render failed: ${err.message}`);
  }
}

async function renderAnnotations(page, viewport) {
  el.annotationLayer.innerHTML = '';
  el.annotationLayer.style.width = `${Math.floor(viewport.width)}px`;
  el.annotationLayer.style.height = `${Math.floor(viewport.height)}px`;
  const annotations = await page.getAnnotations();
  for (const ann of annotations) {
    if (ann.subtype !== 'Link') continue;
    const rect = window.pdfjsLib.Util.normalizeRect(ann.rect);
    const [x1, y1] = viewport.convertToViewportPoint(rect[0], rect[1]);
    const [x2, y2] = viewport.convertToViewportPoint(rect[2], rect[3]);
    const a = document.createElement('a');
    a.style.position = 'absolute';
    a.style.left = `${Math.min(x1, x2)}px`;
    a.style.top = `${Math.min(y1, y2)}px`;
    a.style.width = `${Math.abs(x2 - x1)}px`;
    a.style.height = `${Math.abs(y2 - y1)}px`;
    if (ann.url) {
      a.href = ann.url;
      a.target = '_blank';
      a.rel = 'noopener';
    } else if (ann.dest) {
      a.href = '#';
      a.addEventListener('click', async (e) => {
        e.preventDefault();
        try {
          const dest = typeof ann.dest === 'string' ? await pdfDoc.getDestination(ann.dest) : ann.dest;
          const ref = dest?.[0];
          if (!ref) return;
          const idx = await pdfDoc.getPageIndex(ref);
          goToSlide(idx + 1, 'pdf_link');
        } catch (err) {
          addDebugEntry(`Internal link resolution failed: ${err.message}`);
        }
      });
    } else {
      continue;
    }
    el.annotationLayer.appendChild(a);
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
  if (isWithinCooldown(contactClosedAt, Date.now(), CONTACT_COOLDOWN_MS)) return;
  contactModalOpen = true;
  pauseAvatarForForm();
  el.contactModal.classList.remove('hidden');
  addDebugEntry(`contact form opened (${reason})`);
  awaitingTyped = null; // the request that opened the form was answered by the tool call: no resend
}
function pauseAvatarForForm() {
  micPausedForForm = true;
  // Stray speech while typing ("um...") was taken as "continue" and moved
  // the deck. Only pause the mic if the viewer hadn't already muted it
  // themselves, so closing the form doesn't unmute a mic they wanted off.
  if (session && !viewerMicMuted) { try { session.mute(); } catch { /* mic not started */ } }
  try { session?.interrupt?.(); } catch { /* not connected: nothing to interrupt */ }
}
function closeContactModal() {
  contactModalOpen = false;
  contactClosedAt = Date.now();
  el.contactModal.classList.add('hidden');
  el.contactForm.reset();
  micPausedForForm = false;
  if (session && !viewerMicMuted && !sessionEnded) { try { session.unmute(); } catch { /* mic not started */ } }
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
  contactDeclined = true;
  closeContactModal();
}

// ── Goodbye / session end ──
function handleGoodbye() {
  if (!TOOL_NAMES.endSession || goodbyePending) return;
  goodbyePending = true;
  deckPausedAfterGoodbye = true;
  cancelAutoPlay(); // an in-flight countdown must not fire and advance the deck after goodbye
  addDebugEntry('goodbye detected, grace period started');
  goodbyeGraceTimer = setTimeout(() => {
    session?.disconnect();
    showSessionEnded('goodbye');
  }, GOODBYE_GRACE_MS);
}
function cancelGoodbyeGrace() {
  if (!goodbyePending) return;
  clearTimeout(goodbyeGraceTimer);
  goodbyePending = false;
  // deckPausedAfterGoodbye stays set: canceling the grace period only means
  // the goodbye didn't stick, not that the viewer re-engaged. Only a real
  // slide navigation (onSlideChange) should let autoplay resume.
}

function showSessionEnded(reason) {
  sessionEnded = true;
  const messages = {
    goodbye: "Thanks for joining! Start a new session anytime to keep exploring. It'll pick up where you left off.",
    expired: 'This session has ended. Start a new one to keep going. The deck picks up where you left off.',
    error: 'The avatar connection ended unexpectedly. Start a new session to try again.',
  };
  el.sessionEndedMessage.textContent = messages[reason] || messages.error;
  el.sessionEnded.classList.remove('hidden');
  presenter?.saveMemory?.();
}

// ── Autoplay ──
// One snapshot builder feeds the pure autoPlayBlocked() gate, so the same rules
// apply whether we're deciding to schedule a countdown or deciding, when it
// fires, whether the world changed underneath it.
function autoPlaySnapshot() {
  return {
    sessionRevealed,
    openingDone,
    deckPresenting,
    autoPlayEnabled,
    heldAfterBack: autoPlayHeldAfterBack,
    isPaused,
    sessionEnded,
    deckPausedAfterGoodbye,
    visitorSpeaking,
    replyPending,
    typing: !!el.chatInput.value.trim(),
    avatarSpeaking,
    sessionSpeaking: !!session?.speaking,
    responsePending,
  };
}
function cancelAutoPlay() {
  clearTimeout(autoPlayTimer);
  autoPlayTimer = null;
  hideCountdown();
}
function scheduleAutoPlay(delay = AUTO_PLAY_DELAY_MS) {
  cancelAutoPlay();
  const blockers = autoPlayBlockers(autoPlaySnapshot());
  if (blockers.length) {
    addDebugEntry(`autoplay held: ${blockers.join(', ')}`);
    return;
  }
  const wait = visitorInQnA || lastAvatarTextEndedWithQuestion ? AUTO_PLAY_AFTER_QUESTION_MS : delay;
  showCountdown(wait);
  autoPlayTimer = setTimeout(() => {
    cancelAutoPlay();
    if (autoPlayBlocked(autoPlaySnapshot()) || currentSlideNum >= totalSlides()) return;
    goToSlide(currentSlideNum + 1, 'autoplay');
  }, wait);
}
// Local mic voice activity: held while the visitor is plainly still talking, and
// released VISITOR_SILENCE_MS after the mic goes quiet. Capped by
// VISITOR_SPEAKING_MAX_MS so steady background noise can't hold autoplay forever.
function releaseVoiceHold() {
  clearTimeout(visitorSilenceTimer);
  clearTimeout(visitorSpeakingMaxTimer);
  visitorSilenceTimer = null;
  visitorSpeakingMaxTimer = null;
  visitorSpeaking = false;
}
function onLocalVoice(speaking) {
  if (speaking) {
    clearTimeout(visitorSilenceTimer);
    visitorSilenceTimer = null;
    if (!visitorSpeaking) {
      visitorSpeaking = true;
      cancelAutoPlay();
      visitorSpeakingMaxTimer = setTimeout(releaseVoiceHold, VISITOR_SPEAKING_MAX_MS);
    }
    return;
  }
  if (!visitorSpeaking || visitorSilenceTimer) return;
  visitorSilenceTimer = setTimeout(releaseVoiceHold, VISITOR_SILENCE_MS);
}
// A barge-in or server-detected speech means a reply is coming even when local
// voice detection stays silent. Capped by REPLY_PENDING_MAX_MS so a reply that
// never arrives can't hold autoplay forever.
function holdForReply() {
  replyPending = true;
  cancelAutoPlay();
  clearTimeout(replyPendingTimer);
  replyPendingTimer = setTimeout(releaseReplyHold, REPLY_PENDING_MAX_MS);
}
function releaseReplyHold() {
  clearTimeout(replyPendingTimer);
  replyPendingTimer = null;
  replyPending = false;
}
// A real visitor turn (not a barge-in noise blip) means the deck is genuinely in
// use, and puts the current slide into Q&A mode for the next countdown.
function noteVisitorTurn() {
  visitorNavigatedSinceMessage = false;
  deckPresenting = true;
  visitorInQnA = true;
  cancelAutoPlay();
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
  cancelAutoPlay();
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
    speakInterrupting(`${RESUME_CUE_PREFIX} The viewer has resumed. Briefly continue where you left off.`);
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

// Keeps captions as low as possible (TV-caption style): sits just above the
// chat log's actual current footprint (collapsed, growing, or dragged away),
// rather than always reserving room for the chat log's max possible height.
function updateCaptionOffset() {
  clampChatLogWrapperPosition();
  const slideRect = el.slideWrapper.getBoundingClientRect();
  const chatRect = el.chatLogWrapper.getBoundingClientRect();
  const floor = Math.max(16, slideRect.height * 0.03);
  const dockedToBottom = Math.abs(slideRect.bottom - chatRect.bottom) < 40;
  const offset = dockedToBottom ? Math.max(floor, slideRect.bottom - chatRect.top + 16) : floor;
  el.slideWrapper.style.setProperty('--caption-bottom', `${Math.round(offset)}px`);
}
new ResizeObserver(() => updateCaptionOffset()).observe(el.chatLogWrapper);

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
    updateCaptionOffset();
  }
  function onUp() {
    if (dragging && didDrag) suppressClick = true;
    dragging = false;
    el.chatLogWrapper.classList.remove('dragging');
    clampChatLogWrapperPosition();
    updateCaptionOffset();
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
    updateCaptionOffset();
  });
}

// ── Widget token + appInit prefetch ──
// Fired at page load (see init()) so the token mint + appInit round-trip
// overlaps the welcome/disclaimer dwell time instead of blocking after the
// Start click. preloadAvatar() just awaits the same promise.
let appInitPromise = null;

function prefetchAppInit() {
  if (appInitPromise) return appInitPromise;
  appInitPromise = (async () => {
    if (WIDGET_ID === 'WIDGET_ID_UNSET') {
      throw new Error('WIDGET_ID is not set. Build with node engine/bundle.mjs (it reads the widget id from .provisioning-state.json, or pass --widget-id).');
    }
    const mgmt = new Management({ partnerId: PARTNER_ID });
    addDebugEntry('startup: requesting widget token');
    let token = await mgmt.sessions.createWidgetToken({ widgetId: WIDGET_ID });
    addDebugEntry('startup: widget token acquired');
    let init;
    try {
      init = await mgmt.application.appInit(token.ks);
      addDebugEntry('startup: appInit ok (first try)');
    } catch (err) {
      if (err.status === 401 || err.code === 'unauthorized') {
        token = await mgmt.sessions.createWidgetToken({ widgetId: WIDGET_ID });
        init = await mgmt.application.appInit(token.ks);
        addDebugEntry('startup: appInit ok (retry after 401)');
      } else {
        throw err;
      }
    }
    return init;
  })();
  appInitPromise.catch(() => {}); // swallow here; preloadAvatar()'s own await surfaces the real error
  return appInitPromise;
}

// ── SDK session wiring ──
// Split into two phases so the socket/media handshake overlaps the welcome and
// disclaimer dwell time instead of blocking after the visitor's acknowledge
// click. preloadAvatar() runs on Continue; startSession() runs on acknowledge.
let avatarPreloadPromise = null;
function preloadAvatar() {
  if (avatarPreloadPromise) return avatarPreloadPromise;
  avatarPreloadPromise = (async () => {
    const video = document.createElement('video');
    video.autoplay = true;
    video.playsInline = true;
    el.avatarPip.insertBefore(video, el.avatarPip.firstChild);

    const audio = document.createElement('audio');
    audio.autoplay = true;
    audio.style.display = 'none';
    document.body.appendChild(audio);

    const init = await prefetchAppInit();

    // A read-only peek at the SAME memory record Presenter itself owns (see
    // presenter-memory.js). This is join-time, before Presenter exists, so the
    // avatar's opening greeting can reference the resume point right away,
    // not only once Presenter's own later page_context injection runs.
    const resumeSlide = peekResumeSlide(window.localStorage, Date.now, totalSlides());
    const resumeLabel = resumeSlide ? SLIDE_DATA[resumeSlide - 1]?.title : undefined;

    session = new KalturaAvatarSession({
      token: init.ks,
      conversationManagerUrl: init.conversationManagerUrl,
      srsBaseUrl: init.srsBaseUrl,
      turnServerUrl: init.turnServerUrl,
      // The SDK does not detect Firefox itself, and Firefox needs ICE policy 'all' on
      // the video channel instead of the default 'relay'.
      isFirefox: /firefox/i.test(navigator.userAgent),
      videoEl: video,
      audioEl: audio,
      socketFactory: (url, opts) => window.io(url, opts),
      noiseProcessor: gatedMicProcessor,
      toolSpiralLimit: 3,
      requireDisclosureAck: true,
      requestVars: resumeSlide ? { resume_slide: resumeSlide, resume_label: resumeLabel || '' } : {},
    });

    presenter = new Presenter({
      session,
      slides: SLIDE_DATA,
      context: PRESENTER_CONTEXT,
      onSlideChange,
      storage: window.localStorage,
      toolCallName: TOOL_NAMES.nav,
      deckOutline: true,
      extraMemory: (questions) => ({
        interests: cleanInterests(questions),
        contactDeclined: contactDeclined && !contactSubmitted,
      }),
      restoreMemory: (m) => {
        let contactProvided = false;
        try { contactProvided = !!window.localStorage.getItem(CONTACT_STORAGE_KEY); } catch { /* storage unavailable */ }
        return {
          interests: cleanInterests(m.interests),
          ...(contactProvided ? { contact_provided: true } : {}),
          ...(!contactProvided && m.contactDeclined ? { contact_declined: true } : {}),
        };
      },
    });

    const presenterGoTo = presenter.goTo.bind(presenter);
    presenter.goTo = (n, reason = 'user') => {
      if (contactModalOpen) return;
      if (isWithinCooldown(contactClosedAt, Date.now(), NAV_BLOCK_AFTER_CONTACT_MS)) return;
      // A manual move to an earlier slide holds autoplay so it doesn't send the
      // visitor straight back to where they just asked to leave.
      if (reason !== 'autoplay' && reason !== 'resume' && n !== currentSlideNum) {
        autoPlayHeldAfterBack = n > 1 && n < currentSlideNum;
        if (autoPlayHeldAfterBack) cancelAutoPlay();
      }
      pendingNavNudge = reason;
      presenterGoTo(n, reason);
    };

    registerSessionEvents(session, video);

    if (TOOL_NAMES.contact) {
      session.onToolCall(TOOL_NAMES.contact, (args) => openContactModal(args?.reason || 'agent'));
    }
    if (TOOL_NAMES.endSession) {
      session.onToolCall(TOOL_NAMES.endSession, () => {
        if (visitorNavigatedSinceMessage) addDebugEntry('end-session call ignored: the visitor navigated after their last message');
        else handleGoodbye();
      });
    }
    session.onToolCall(TOOL_NAMES.nav, (args, call) => {
      if (!call.toolMetadata?.waitForResponse || !call.toolMetadata.id) return;
      // Presenter's own nav handler (registered ahead of this one, since
      // `presenter = new Presenter(...)` above already wired it) runs first and,
      // for a 'resume' call, has already resolved the real target and moved the
      // deck there. Ack the slide actually landed on, not the tool call's arg.
      const ackSlide = args?.reason === 'resume' ? presenter.current : args?.slide_num;
      session.respondToTool(call.toolMetadata.id, navAckPayload(SLIDE_DATA, ackSlide));
    });

    addDebugEntry('startup: session.connect() called');
    try {
      await session.connect();
      addDebugEntry('startup: session.connect() resolved');
    } catch (err) {
      if (sessionRevealed) showToast('Could not connect to the avatar. Please refresh.', 'error');
      throw err;
    }
  })();
  return avatarPreloadPromise;
}

async function startSession() {
  await preloadAvatar();
  sessionRevealed = true;
  if (pendingDisclosureText) {
    showToast(pendingDisclosureText, 'info');
    pendingDisclosureText = null;
  }

  await session.acknowledgeDisclosure();
  disclosureAcked = true;
  resolveDisclosureAcked();

  const micErrors = {
    mic_permission_denied: 'Microphone access was denied. Allow it in your browser settings to talk with the avatar.',
    mic_not_found: 'No microphone was found on this device.',
    mic_in_use: 'Your microphone is being used by another app.',
  };
  addDebugEntry('startup: session.startMic() called');
  session.startMic()
    .then(() => addDebugEntry('mic started'))
    .catch((err) => {
      showToast(micErrors[err.code] || micErrors[err.name] || 'Could not start the microphone.', 'warn');
    });

  addDebugEntry('startup: presenter.start() called');
  await presenter.start();
  addDebugEntry('startup: presenter.start() resolved');
  updateSlideUI(1);

  captions = new CaptionService(session, { replacements: CAPTION_MAP });
  captions.onCaption(({ text, clear }) => {
    if (!ccEnabled) return;
    el.captionText.textContent = clear ? '' : toReadableText(text);
  });
}

function registerSessionEvents(sess, video) {
  // Media readiness needs BOTH: a decoded video frame actually on screen, and
  // the SDK's own 'mediaReady' (audio/video tracks attached). Either alone can
  // still show a stale or not-yet-synced frame.
  let frameReady = false;
  let mediaReady = false;
  const revealAvatar = () => {
    if (!frameReady || !mediaReady) return;
    clearConnectTimeout();
    el.avatarLoading.classList.add('hidden');
  };
  const awaitNewFrame = () => {
    frameReady = false;
    if (typeof video.requestVideoFrameCallback === 'function') {
      video.requestVideoFrameCallback(() => {
        frameReady = true;
        addDebugEntry('first video frame');
        revealAvatar();
      });
    } else {
      const onLoadedData = () => {
        video.removeEventListener('loadeddata', onLoadedData);
        frameReady = true;
        addDebugEntry('first video frame');
        revealAvatar();
      };
      video.addEventListener('loadeddata', onLoadedData);
    }
  };
  awaitNewFrame();
  sess.on('videoMetadata', ({ videoWidth, videoHeight } = {}) => addDebugEntry(`video metadata: ${videoWidth}x${videoHeight}`));

  sess.on('stateChange', ({ state } = {}) => {
    addDebugEntry(`state: ${state}`);
    if (state === 'connecting' && sessionRevealed) showToast('Connecting to the avatar…', 'info');
  });
  sess.on('connectivityChanged', ({ channel, state } = {}) => addDebugEntry(`connectivity[${channel}]: ${state}`));
  sess.on('streamReady', () => addDebugEntry('stream ready'));
  sess.on('track', ({ track } = {}) => addDebugEntry(`track received: ${track?.kind}`));
  let connectTimeoutId = null;
  const clearConnectTimeout = () => { clearTimeout(connectTimeoutId); connectTimeoutId = null; };
  const armConnectTimeout = () => {
    clearConnectTimeout();
    connectTimeoutId = setTimeout(() => {
      addDebugEntry('avatar connect timed out waiting for mediaReady');
      showAvatarFailed("Couldn't reach the avatar. Refresh the page to try again.");
    }, AVATAR_CONNECT_TIMEOUT_MS);
  };
  const showAvatarConnecting = () => {
    el.avatarLoading.classList.remove('failed');
    el.avatarLoading.classList.remove('hidden');
    el.avatarLoadingLabel.textContent = 'Connecting to the avatar…';
    armConnectTimeout();
  };
  const showAvatarFailed = (message) => {
    clearConnectTimeout();
    el.avatarLoadingLabel.textContent = message;
    el.avatarLoading.classList.remove('hidden');
    el.avatarLoading.classList.add('failed');
    if (sessionRevealed) showToast(message, 'error', { sticky: true });
  };
  armConnectTimeout();
  sess.on('mediaReady', () => { mediaReady = true; revealAvatar(); });
  sess.on('micStarted', () => addDebugEntry('sdk: mic started (media flowing)'));
  sess.on('error', (err) => {
    addDebugEntry(`error: ${err?.message || err}`);
    showAvatarFailed('Something went wrong with the avatar connection. Refresh to try again.');
  });
  sess.on('warning', (warning) => {
    if (warning?.code === 'playback_blocked') {
      showToast("Click anywhere to enable the avatar's voice.", 'info');
      const onClick = () => { sess.startPlayback(); document.removeEventListener('click', onClick); };
      document.addEventListener('click', onClick, { once: true });
    } else if (warning?.code === 'mic_attach_failed') {
      showToast('The microphone could not be attached. Try muting and unmuting to retry.', 'warn');
    }
  });

  sess.on('avatarStartTalking', () => {
    avatarSpeaking = true;
    cancelAutoPlay();
    el.avatarPip.classList.add('thinking');
    addDebugEntry('avatar started talking');
  });
  sess.on('avatarStopTalking', () => {
    avatarSpeaking = false;
    el.avatarPip.classList.remove('thinking');
    addDebugEntry('avatar stopped talking');
    releaseReplyHold();
    openingDone = true;
    scheduleAutoPlay();
  });
  // An interrupted turn never gets avatarStopTalking. turnEnd schedules autoplay instead.
  sess.on('interrupted', () => { avatarSpeaking = false; el.avatarPip.classList.remove('thinking'); });
  sess.on('userStartedTalking', () => holdForReply());
  sess.on('localSpeakingChanged', ({ speaking } = {}) => onLocalVoice(speaking));
  sess.on('transcript', ({ type, text }) => {
    if (type === 'partial' || !text) return;
    if (type === 'user') {
      addDebugEntry(`user: ${text}`);
      // The SDK can batch a typed question together with a subsequent
      // app-injected speak() (a nav nudge, resume cue, etc.) into one
      // combined "user" turn, so strip our own instruction text first: an
      // app-only turn strips to nothing and is never real audience input.
      const viewerText = stripAppText(text);
      if (!viewerText) return;
      if (consumeTypedEcho(viewerText)) {
        // Already shown as a bubble when the user hit Send.
        if (awaitingTyped && typedTextsMatch(normalizeTyped(viewerText), awaitingTyped.norm)) awaitingTyped = null;
        return;
      }
      const words = viewerText.trim().split(/\s+/).length;
      micStats.turns++;
      if (words < 3) micStats.shortTurns++;
      if (avatarSpeaking) micStats.bargeIns++;
      appendChatMessage(viewerText, 'user');
      markUserInteraction();
      noteVisitorTurn();
      if (STAY_HERE_PHRASE_RE.test(viewerText)) setAutoPlayUI(false);
      if (TOOL_NAMES.endSession && GOODBYE_PHRASE_RE.test(viewerText)) handleGoodbye();
      else cancelGoodbyeGrace();
    } else {
      addDebugEntry(`avatar: ${text}`);
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
  sess.on('responsePending', () => {
    responsePending = true;
    el.avatarPip.classList.add('pending');
  });
  // Autoplay is scheduled from turnEnd, not responseSettled: the SDK settles on the
  // first output (a nav tool call counts), before the avatar has spoken.
  sess.on('responseSettled', () => {
    responsePending = false;
    el.avatarPip.classList.remove('pending');
  });
  sess.on('turnEnd', () => scheduleAutoPlay());

  sess.on('reconnecting', () => {
    showToast('Reconnecting…', 'warn');
    frameReady = false;
    mediaReady = false;
    // A cold reconnect re-runs the SDK's StV connect internally and fires a
    // fresh 'mediaReady', which is what actually hides this again. Without
    // re-showing it here first, the video element can render a stale or
    // not-yet-synced frame (an "odd face") in the gap before that event.
    // armConnectTimeout guards against a reconnect that stalls or fails
    // without ever getting there.
    showAvatarConnecting();
  });
  sess.on('reconnected', () => {
    showToast('Reconnected.', 'info');
    sess.startPlayback();
    awaitNewFrame();
  });
  // No dedicated E2E test: forcing a live backend stall on demand isn't
  // possible from the client. resendIfStalled/resendTyped share their guards
  // (count === 1, awaitingTyped.resent) with the client-pure.test.mjs coverage.
  sess.on('brainStalled', ({ count }) => resendIfStalled(count));
  sess.on('capacityChanged', () => {});
  sess.on('toolSpiralDetected', () => addDebugEntry('tool spiral detected'));
  sess.on('toolSpiralRecovering', () => addDebugEntry('tool spiral recovering'));
  sess.on('spiralRecovered', () => addDebugEntry('tool spiral recovered'));

  sess.on('disclosure', (info) => {
    if (!info?.text) return;
    if (sessionRevealed) showToast(info.text, 'info');
    else pendingDisclosureText = info.text;
  });
  sess.on('timeWarning', ({ remainingTime }) => {
    showToast(`This session is ending in about ${Math.max(1, Math.round((remainingTime || 0) / 1000))}s.`, 'warn');
  });
  sess.on('timeExpired', () => { clearConnectTimeout(); showSessionEnded('expired'); });
  sess.on('ended', () => { clearConnectTimeout(); if (!pageUnloading) showSessionEnded(goodbyePending ? 'goodbye' : 'error'); });
}

// ── Event binding ──
function bindEvents() {
  el.btnContinue.addEventListener('click', () => {
    el.welcomeStep.classList.add('hidden');
    el.disclaimerStep.classList.remove('hidden');
    el.disclaimerScroll.scrollTop = 0;
    // Fire-and-forget: the disclaimer dwell time overlaps the socket/media
    // handshake. startSession() awaits this same promise on the acknowledge
    // click, and preloadAvatar()'s own error path is gated on sessionRevealed
    // so a preload failure here doesn't toast over the disclaimer.
    preloadAvatar().catch(() => {});
  });
  el.btnStart.addEventListener('click', async () => {
    el.startOverlay.classList.add('hidden');
    try {
      await startSession();
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
  el.slideSeek.addEventListener('change', () => {
    const n = Number(el.slideSeek.value);
    if (Number.isInteger(n)) { markUserInteraction(); goToSlide(n, 'jump'); }
  });
  el.slideLabel.addEventListener('click', () => {
    el.slideLabel.classList.add('hidden');
    el.slideJumpInput.classList.remove('hidden');
    el.slideJumpInput.focus();
    el.slideJumpInput.select();
  });
  function revealSlideLabel() {
    el.slideJumpInput.classList.add('hidden');
    el.slideLabel.classList.remove('hidden');
  }
  el.slideJumpInput.addEventListener('change', () => {
    const n = Number(el.slideJumpInput.value);
    if (Number.isInteger(n)) { markUserInteraction(); goToSlide(n, 'jump'); }
  });
  el.slideJumpInput.addEventListener('blur', revealSlideLabel);
  el.slideJumpInput.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === 'Escape') revealSlideLabel(); });

  el.btnAutoplayToggle.addEventListener('click', () => {
    autoPlayHeldAfterBack = false;
    setAutoPlayUI(!autoPlayEnabled);
  });

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
    el.btnMute.setAttribute('aria-label', micMuted ? 'Unmute avatar audio' : 'Mute avatar audio');
    el.iconUnmuted.classList.toggle('hidden', micMuted);
    el.iconMuted.classList.toggle('hidden', !micMuted);
    const audioEl = document.querySelector('audio');
    if (audioEl) audioEl.muted = micMuted;
  });
  el.btnMicMute.addEventListener('click', () => {
    if (micPausedForForm || !session) return;
    viewerMicMuted = !viewerMicMuted;
    if (viewerMicMuted) session.mute(); else session.unmute();
    el.btnMicMute.setAttribute('aria-pressed', String(viewerMicMuted));
    el.btnMicMute.setAttribute('aria-label', viewerMicMuted ? 'Unmute your microphone' : 'Mute your microphone');
    el.iconMicOn.classList.toggle('hidden', viewerMicMuted);
    el.iconMicOff.classList.toggle('hidden', !viewerMicMuted);
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
  el.btnCloseTranscript.addEventListener('click', () => el.transcriptPanel.classList.add('hidden'));
  el.btnDownloadTranscript.addEventListener('click', () => {
    const lines = [...el.transcriptBody.querySelectorAll('.transcript-entry')].map((n) => n.textContent);
    const mic = micStatsSummary();
    if (mic) lines.push('', '=== mic stats (levels and counts only) ===', ...Object.entries(mic).map(([k, v]) => `${k}: ${v}`));
    const blob = new Blob([lines.join('\n')], { type: 'text/plain' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'debug-log.txt';
    a.click();
    URL.revokeObjectURL(a.href);
  });
  el.btnClearMemory.addEventListener('click', () => {
    memoryCleared = true;
    presenter?.clearMemory?.();
    showToast('Memory cleared.', 'info');
  });

  document.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape') {
      if (document.activeElement === el.chatInput) el.chatInput.blur();
      else el.transcriptPanel.classList.add('hidden');
      return;
    }
    if (ev.target.tagName === 'INPUT' || ev.target.tagName === 'TEXTAREA') return;
    if (ev.key === 'c' || ev.key === 'C') el.btnCc.click();
    if (ev.key === 't' || ev.key === 'T') el.btnTranscript.click();
    if (ev.key === 'ArrowRight') el.btnNext.click();
    if (ev.key === 'ArrowLeft') el.btnPrev.click();
    if (ev.key === 'Home') { markUserInteraction(); goToSlide(1, 'user'); }
    if (ev.key === 'End') { markUserInteraction(); goToSlide(totalSlides(), 'user'); }
    if (ev.key === ' ') { ev.preventDefault(); togglePause(); }
  });

  window.addEventListener('resize', clampChatLogWrapperPosition);

  window.addEventListener('beforeunload', () => {
    pageUnloading = true;
    // A deliberate "clear memory" click means the visitor wants a fresh start,
    // so don't let this handler write a new memory record right after.
    if (!memoryCleared) presenter?.saveMemory();
    presenter?.destroy();
    session?.disconnect();
  });
}

// ── Boot ──
async function init() {
  prefetchAppInit(); // fire now so it overlaps page load + the welcome/disclaimer dwell time

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
  applyBranding();
  applyDisclosure();
  applyPrivacy();
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
