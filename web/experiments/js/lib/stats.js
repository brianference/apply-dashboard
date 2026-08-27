/**
 * The arithmetic of comparing two arms, and the honesty about when not to.
 *
 * The whole point of this module is the last function. A dashboard that prints
 * "arm A: 15%, arm B: 8%" over eight applications each has said something
 * false with real numbers, and it is the most persuasive kind of false thing
 * because nothing about it looks made up.
 */

/**
 * Wilson score interval for a proportion. Preferred over the normal
 * approximation because the counts here are small and near zero, which is
 * exactly where the normal approximation produces intervals that run below 0.
 *
 * @param {number} successes
 * @param {number} trials
 * @param {number} [z] 1.96 for 95 percent
 * @returns {{point: number, low: number, high: number}} proportions in 0..1
 */
export function wilson(successes, trials, z = 1.96) {
  if (!trials) return { point: 0, low: 0, high: 1 };
  const p = successes / trials;
  const z2 = z * z;
  const denom = 1 + z2 / trials;
  const centre = (p + z2 / (2 * trials)) / denom;
  const spread = (z / denom) * Math.sqrt((p * (1 - p) + z2 / (4 * trials)) / trials);
  return { point: p, low: Math.max(0, centre - spread), high: Math.min(1, centre + spread) };
}

/**
 * Trials needed PER ARM to have a fair chance of detecting a difference of
 * this size, at 80 percent power and 5 percent significance.
 *
 * The standard two-proportion sample size. It is here so the page can say the
 * number out loud rather than leaving the reader to assume their 13
 * applications were enough.
 *
 * @param {number} baseline expected rate in the control arm, 0..1
 * @param {number} lift absolute difference to detect, 0..1
 * @returns {number} trials per arm, rounded up
 */
export function trialsNeededPerArm(baseline, lift) {
  const p1 = Math.min(Math.max(baseline, 0.0001), 0.9999);
  const p2 = Math.min(Math.max(baseline + lift, 0.0001), 0.9999);
  if (p1 === p2) return Infinity;
  const zAlpha = 1.96;
  const zBeta = 0.84;
  const pBar = (p1 + p2) / 2;
  const numerator = zAlpha * Math.sqrt(2 * pBar * (1 - pBar)) + zBeta * Math.sqrt(p1 * (1 - p1) + p2 * (1 - p2));
  return Math.ceil((numerator * numerator) / ((p2 - p1) * (p2 - p1)));
}

/**
 * What this comparison is entitled to claim.
 *
 * Two arms are only called apart when their intervals do not overlap. With the
 * volumes a single job search produces they almost never will, and saying so
 * is the correct output, not a failure of the page.
 *
 * @param {{successes: number, trials: number}} a
 * @param {{successes: number, trials: number}} b
 * @returns {{verdict: string, detail: string, separated: boolean}}
 */
export function readOut(a, b) {
  if (!a.trials || !b.trials) {
    return { verdict: "no data yet", separated: false, detail: "One arm has no applications recorded." };
  }
  const wa = wilson(a.successes, a.trials);
  const wb = wilson(b.successes, b.trials);
  const separated = wa.low > wb.high || wb.low > wa.high;
  if (separated) {
    return {
      verdict: "the arms differ",
      separated: true,
      detail: "The 95 percent intervals do not overlap, which is unusual at this volume. Check the assignment dates before believing it."
    };
  }
  const baseline = Math.max((a.successes + b.successes) / (a.trials + b.trials), 0.02);
  const need = trialsNeededPerArm(baseline, baseline);
  return {
    verdict: "cannot tell them apart",
    separated: false,
    detail: `The intervals overlap. Detecting even a doubling of the ${(baseline * 100).toFixed(0)} percent baseline would take about ${need} applications in EACH arm, against ${a.trials} and ${b.trials} now.`
  };
}
