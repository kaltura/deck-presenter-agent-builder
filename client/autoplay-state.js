// Autoplay must not advance the deck while any of these hold. Kept as one pure
// function over a plain snapshot object, so the gate is testable without a live
// session, a DOM, or real timers. app.js builds the snapshot from its own state
// and passes it in every time it checks (scheduling a countdown, and again when
// that countdown's timer fires).
/**
 * @param {object} state
 * @param {boolean} state.sessionRevealed the disclaimer is acknowledged and the avatar is live
 * @param {boolean} state.openingDone the scripted opening line has finished
 * @param {boolean} state.deckPresenting the deck has actually started (a reply or a nav happened)
 * @param {boolean} state.autoPlayEnabled the visitor hasn't turned autoplay off
 * @param {boolean} state.heldAfterBack a manual move to an earlier slide is still in effect
 * @param {boolean} state.isPaused the visitor paused the avatar
 * @param {boolean} state.sessionEnded the session already ended
 * @param {boolean} state.deckPausedAfterGoodbye a goodbye was detected and the grace period is running
 * @param {boolean} state.visitorSpeaking local mic voice activity is in progress
 * @param {boolean} state.replyPending a reply from the avatar is expected soon
 * @param {boolean} state.typing the visitor has unsent text in the chat box
 * @param {boolean} state.avatarSpeaking the avatar is currently talking (local flag)
 * @param {boolean} state.sessionSpeaking the session reports the avatar as speaking
 * @param {boolean} state.responsePending the session is generating a response
 * @returns {boolean} true when autoplay must not run right now
 */
export function autoPlayBlocked(state) {
  const s = state || {};
  return !s.sessionRevealed
    || !s.openingDone
    || !s.deckPresenting
    || !s.autoPlayEnabled
    || !!s.heldAfterBack
    || !!s.isPaused
    || !!s.sessionEnded
    || !!s.deckPausedAfterGoodbye
    || !!s.visitorSpeaking
    || !!s.replyPending
    || !!s.typing
    || !!s.avatarSpeaking
    || !!s.sessionSpeaking
    || !!s.responsePending;
}

// A visitor who asks to stay on the current slide shouldn't have to repeat it
// every countdown: this turns autoplay off for the rest of the session. Plain
// generic English phrasing only, not tied to any deck's own wording.
export const STAY_HERE_PHRASE_RE = /\b(stay (?:on|here|put)|hold on this slide|don'?t (?:move|advance|skip|leave)|do not (?:move|advance|skip)|please (?:wait|hold)|remain (?:on|here))\b/i;
