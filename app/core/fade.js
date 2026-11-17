// Fading out old lines: how visible a line is, from how old it is. A line (with its translation) is fully visible until it is
// `sec` seconds old, then fades for `ms` milliseconds, then it is gone. Port of fade.py.
export const STEP = 0.02;           // the fade goes in steps of this size (50 steps)

// age in seconds, sec: the option (0 = never fades), ms: how long the fade takes -> 1.0 (visible) .. 0.0 (gone)
export function alpha(ageS, sec, ms) {
  if (sec <= 0 || ageS <= sec) return 1.0;
  if (ms <= 0) return 0.0;
  const a = 1.0 - (ageS - sec) * 1000.0 / ms;
  return a <= STEP ? 0.0 : pyRound(a / STEP) * STEP;
}

// Python's round(): halves go to the even number
function pyRound(x) {
  const r = Math.round(x);
  return Math.abs(x % 1) === 0.5 && r % 2 !== 0 ? r - 1 : r;
}
