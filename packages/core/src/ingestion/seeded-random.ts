// ---------------------------------------------------------------------------
// Deterministic pseudo-random numbers (FEAT-104 TASK-003).
//
// Module invariant: pure, no Node built-ins, no `Math.random`. The profiler's
// reservoir sampling is seeded from the file's SHA-256 so the same file always
// yields the same profile — that is what lets a re-run be compared with the
// original, and what makes a person's consent to a payload mean something.
// Not cryptographic, and never used for anything security-relevant.
// ---------------------------------------------------------------------------

/**
 * Hash a string to four 32-bit words (cyrb128).
 *
 * @param text Any string, typically `<sha256>:<table>:<column>`.
 * @returns Four unsigned 32-bit integers.
 */
export function hash128(text: string): [number, number, number, number] {
  let h1 = 1779033703;
  let h2 = 3144134277;
  let h3 = 1013904242;
  let h4 = 2773480762;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    h1 = h2 ^ Math.imul(h1 ^ code, 597399067);
    h2 = h3 ^ Math.imul(h2 ^ code, 2869860233);
    h3 = h4 ^ Math.imul(h3 ^ code, 951274213);
    h4 = h1 ^ Math.imul(h4 ^ code, 2716044179);
  }
  h1 = Math.imul(h3 ^ (h1 >>> 18), 597399067);
  h2 = Math.imul(h4 ^ (h2 >>> 22), 2869860233);
  h3 = Math.imul(h1 ^ (h3 >>> 17), 951274213);
  h4 = Math.imul(h2 ^ (h4 >>> 19), 2716044179);
  h1 ^= h2 ^ h3 ^ h4;
  h2 ^= h1;
  h3 ^= h1;
  h4 ^= h1;
  return [h1 >>> 0, h2 >>> 0, h3 >>> 0, h4 >>> 0];
}

/**
 * Create a seeded generator (sfc32) returning floats in [0, 1).
 *
 * @param seed Any string; the same seed always yields the same sequence.
 * @returns A function producing the next number.
 * @example const next = seededRandom('abc'); next() === seededRandom('abc')()
 */
export function seededRandom(seed: string): () => number {
  let [a, b, c, d] = hash128(seed);
  return () => {
    a >>>= 0;
    b >>>= 0;
    c >>>= 0;
    d >>>= 0;
    let t = (a + b) | 0;
    a = b ^ (b >>> 9);
    b = (c + (c << 3)) | 0;
    c = (c << 21) | (c >>> 11);
    d = (d + 1) | 0;
    t = (t + d) | 0;
    c = (c + t) | 0;
    return (t >>> 0) / 4294967296;
  };
}
