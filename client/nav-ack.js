// Shared by client/app.js (bundled into the browser), engine/eval.mjs, and
// test/*.test.mjs, so the eval grounds the agent exactly the way the client does.
//
// page_context reaches the model only on the next turn, so the nav tool's ack
// carries the landed slide's content to ground the answer in this same turn.
// `visual` is layout data for the renderer, not something the model should read.
export function navAckPayload(slides, slideNum) {
  const n = Number(slideNum);
  const slide = Number.isInteger(n) ? slides[n - 1] : undefined;
  if (!slide) return { ok: false, slide_num: slideNum ?? null };
  const content = { ...(slide.content || {}) };
  delete content.visual;
  return { ok: true, slide_num: n, title: slide.title, talking_points: slide.talking_points, content };
}
