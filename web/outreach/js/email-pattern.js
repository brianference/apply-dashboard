/**
 * Derive an employer's email-address PATTERN from public commit metadata.
 *
 * Brian, 2026-09-11, from jobcopilot.com/how-to-find-hidden-jobs/: that guide's
 * whole answer to "find the hiring manager's email" is to spend credits inside
 * their own product. It names no pattern, no verification method and no tool.
 * So this derives the pattern from evidence instead.
 *
 * WHERE THE EVIDENCE COMES FROM. Every git commit carries the author's email in
 * its metadata, and a public repository publishes it. People put their work
 * address there themselves, by committing. Reading it is not a leak; it is the
 * same field `git log` prints.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO. It never returns, stores or logs the
 * addresses it read. The output is a SHAPE plus a count: "first.last, agreed by
 * 17 of 19 unique addresses". A shape is a fact about the employer's mail
 * convention. The addresses themselves are personal data, and this repository
 * is public, so they stay out of it. The page applies the shape to a name in
 * the reader's browser and labels the result as derived, never as verified.
 *
 * WHY A FLOOR. Two unique addresses agreeing proves nothing, and counting
 * OCCURRENCES rather than unique addresses lets one prolific committer decide
 * the answer for a whole company. Measured both ways on docker.com, occurrences
 * said 54 of 54 agreed and unique addresses said 17 of 19. The second is the
 * true figure and the first is a person counted 30 times.
 */

/** The shapes worth recognising. Anything else is reported as other. */
const SHAPES = [
  /* TWO or more letters before the dot. `[a-z]+` also matches one, which made
     p.gronowski read as first.last and would have turned every initial-style
     employer into a dotted-full-name one. */
  ['first.last', /^[a-z]{2,}\.[a-z]+$/],
  ['f.last', /^[a-z]\.[a-z]+$/],
  ['first_last', /^[a-z]+_[a-z]+$/],
  ['flast', /^[a-z][a-z]{2,}$/],
  ['first', /^[a-z]+$/]
];

/**
 * Drop diacritics so a name maps to the ASCII local part mail systems use.
 *
 * "Manuel de la Peña" has to reach pena, not pe%C3%B1a.
 *
 * @param {string} value
 * @returns {string}
 */
export function asciiFold(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase();
}

/**
 * Which shape a local part has.
 *
 * `first` and `flast` both match a bare run of letters, so the order in SHAPES
 * matters: the two-part shapes are tested first, and a bare word is reported as
 * `first` because that is the commoner convention. A bare word is genuinely
 * ambiguous between the two and is treated as one bucket rather than guessed
 * apart.
 *
 * @param {string} local
 * @returns {string}
 */
export function localPartShape(local) {
  const value = asciiFold(local).trim();
  if (!value) return 'other';
  for (const [name, pattern] of SHAPES) {
    if (name === 'flast') continue;
    if (pattern.test(value)) return name;
  }
  return 'other';
}

/**
 * Split a display name into the parts a mail convention uses.
 *
 * Takes the first token as the given name and the LAST token as the family
 * name, so "Jean-Laurent de Morlhon" yields jeanlaurent and morlhon. A
 * particle-carrying name is genuinely ambiguous; the caller is told so rather
 * than having a guess hidden from it.
 *
 * @param {string} fullName
 * @returns {{ first: string, last: string, ambiguous: boolean }|null}
 */
export function nameParts(fullName) {
  const tokens = asciiFold(fullName)
    .replace(/[^a-z\s-]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
  if (tokens.length < 2) return null;
  const first = tokens[0].replace(/-/g, '');
  const last = tokens[tokens.length - 1].replace(/-/g, '');
  if (!first || !last) return null;
  /* More than two tokens means a middle name or a particle, and which token is
     the family name is then a convention rather than a fact. */
  return { first, last, ambiguous: tokens.length > 2 };
}

/**
 * Apply a derived shape to a name.
 *
 * @param {string} shape
 * @param {string} fullName
 * @param {string} domain
 * @returns {{ address: string, ambiguous: boolean }|null}
 */
export function addressFor(shape, fullName, domain) {
  const parts = nameParts(fullName);
  const host = asciiFold(domain).replace(/^@/, '').trim();
  if (!parts || !host) return null;
  const { first, last, ambiguous } = parts;
  const local = shape === 'first.last' ? `${first}.${last}`
    : shape === 'first_last' ? `${first}_${last}`
      : shape === 'f.last' ? `${first[0]}.${last}`
        : shape === 'flast' ? `${first[0]}${last}`
          : shape === 'first' ? first
            : null;
  if (!local) return null;
  return { address: `${local}@${host}`, ambiguous };
}

/**
 * Derive the shape an employer uses, from addresses already filtered to its
 * domain.
 *
 * @param {string[]} addresses raw addresses; deduplicated here, never returned
 * @param {{ minUnique?: number, minAgreement?: number }} [options]
 * @returns {{ ok: boolean, shape: string|null, unique: number, agree: number,
 *   pct: number, reason: string }}
 */
export function derivePattern(addresses, options = {}) {
  const minUnique = options.minUnique ?? 4;
  const minAgreement = options.minAgreement ?? 0.7;

  /* Unique addresses, not occurrences. This is the whole difference between a
     real figure and one prolific committer counted many times. */
  const unique = [...new Set(
    (addresses || [])
      .map((a) => asciiFold(a).trim())
      .filter((a) => a && a.includes('@') && !a.endsWith('users.noreply.github.com'))
  )];

  const tally = new Map();
  for (const address of unique) {
    const shape = localPartShape(address.split('@')[0]);
    if (shape === 'other') continue;
    tally.set(shape, (tally.get(shape) || 0) + 1);
  }

  const counted = [...tally.entries()].sort((a, b) => b[1] - a[1]);
  const total = unique.length;
  if (!total) return { ok: false, shape: null, unique: 0, agree: 0, pct: 0, reason: 'no addresses' };
  if (total < minUnique) {
    return {
      ok: false, shape: counted[0]?.[0] || null, unique: total,
      agree: counted[0]?.[1] || 0, pct: 0,
      reason: `only ${total} unique addresses, floor is ${minUnique}`
    };
  }
  if (!counted.length) {
    return { ok: false, shape: null, unique: total, agree: 0, pct: 0, reason: 'no recognised shape' };
  }

  const [shape, agree] = counted[0];
  const pct = Math.round((agree / total) * 100);
  if (agree / total < minAgreement) {
    return {
      ok: false, shape, unique: total, agree, pct,
      reason: `top shape only ${pct}% of ${total}, floor is ${Math.round(minAgreement * 100)}%`
    };
  }
  return { ok: true, shape, unique: total, agree, pct, reason: `${agree} of ${total} agree` };
}
