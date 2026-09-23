// Shared by client/app.js (bundled into the browser) and test/*.test.mjs.
// No AudioContext/DOM APIs here, so both can import it as-is.
//
// Pure math over the mic-level histogram: bin i counts raw-level samples
// taken at -i dBFS, one sample per stats tick.

// Raw level (dBFS) below which a share `q` of samples fell.
export function levelAt(hist, ticks, q) {
  let acc = 0;
  for (let i = 0; i <= 100; i++) {
    acc += hist[i];
    if (acc >= q * ticks) return -i;
  }
  return -100;
}

export function statsSummary(stats, tickMs, gateDb) {
  if (!stats.ticks) return null;
  const sec = Math.round(stats.ticks * tickMs / 1000);
  return {
    'gate threshold': `${gateDb} dBFS`,
    'sampled': `${Math.floor(sec / 60)}m${String(sec % 60).padStart(2, '0')}s (mic on, not muted)`,
    'raw level: floor / median / speech': `${levelAt(stats.hist, stats.ticks, 0.9)} / ${levelAt(stats.hist, stats.ticks, 0.5)} / ${levelAt(stats.hist, stats.ticks, 0.1)} dBFS`,
    'gate open': `${Math.round(100 * stats.openTicks / stats.ticks)}% of the time, ${stats.openings} openings`,
    'voice turns': `${stats.turns} (${stats.shortTurns} under 3 words, ${stats.bargeIns} while the avatar spoke)`,
  };
}
