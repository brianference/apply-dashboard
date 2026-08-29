/**
 * Domains Brian does not want, read out of the DESCRIPTION rather than guessed
 * from the title.
 *
 * CRITERIA.md has listed healthcare, construction and architecture as skips
 * since the beginning. Nothing enforced them. `filter-to-criteria.mjs` holds an
 * industry regex and is a standalone script that no part of the pipeline
 * imports, and `requirementsGate` checked role, location, salary and security
 * products only. So SmarterDx's "Group Product Manager, SmarterDenials" sat in
 * the queue at 70 percent: the title says nothing, the company name says
 * nothing, and the only place it is stated is the description, which asks for
 * "6 years of product management experience within B2B, healthtech
 * environments".
 *
 * A security clearance was in HARD_BLOCKERS but only cost 40 points off the
 * success score. A clearance Brian does not hold is not a weak posting, it is
 * an impossible one.
 *
 * THE TRAP THIS EXISTS TO AVOID: almost every US posting says "medical, dental
 * and vision" and "health insurance" in its benefits paragraph. Counting the
 * word "health" would rule out most of the list. Benefits language is removed
 * before anything is matched, and that removal is tested in both directions.
 */

/**
 * Benefits boilerplate, which mentions health without being about health.
 * Stripped before any domain matching so it cannot trigger a rule-out.
 */
const BENEFITS_NOISE = new RegExp([
  'health (insurance|benefits?|coverage|care coverage|savings account|reimbursement)',
  'medical,? (and )?dental', 'dental,? (and )?vision', 'vision,? (and )?dental',
  'medical,? dental,? (and )?vision', 'mental health', 'behavioral health',
  'healthcare (benefits?|coverage|plan)', 'health and wellness', 'wellness (stipend|benefit)',
  'paid parental leave', '\\bhsa\\b', '\\bfsa\\b', '\\b401\\(?k\\)?\\b',
  'life insurance', 'disability insurance', 'employee assistance program',
  /* Legally required notices, by name. US employers must post these, and
     their TITLES contain the exact words these rules look for. Elastic was
     ruled out as requiring a clearance because its footer links the
     "Employee Polygraph Protection Act". The Family and Medical Leave Act
     carries "Medical" the same way. */
  'employee polygraph protection act', '\\beppa\\b',
  'family and medical leave act', '\\bfmla\\b',
  'americans with disabilities act', 'know your rights', 'e-?verify',
  'equal employment opportunity', 'pay transparency', 'uniformed services employment'
].join('|'), 'gi');

/**
 * Phrases that settle the domain on their own, and terms that only count in
 * numbers. Modelled on securitySignals: a decisive phrase needs no repetition,
 * a vague one needs several.
 */
const DOMAINS = [
  {
    name: 'healthcare',
    decisive: new RegExp([
      'health ?tech', 'healthcare (company|platform|technology|provider|system|organi[sz]ation)',
      'digital health', 'clinical (workflow|documentation|decision|trial|operations|data)',
      'electronic health record', '\\behr\\b', '\\bemr\\b',
      'revenue cycle', 'claims adjudication', 'prior authori[sz]ation',
      'payer[s]? (and|,) provider', 'provider network', 'care delivery',
      'patient (care|outcomes?|records?|safety|engagement|journey)',
      'telehealth', 'medicaid', 'medicare', 'hospital system', 'health system',
      'life sciences', 'medical device', 'pharmaceutical', 'biotech',
      'value-based care', 'population health', 'utili[sz]ation management'
    ].join('|'), 'i'),
    /* HIPAA counts, but only alongside other signals: it names a compliance
       framework as often as a healthcare product. Vanta, whose whole business
       is compliance automation, was ruled out by it on its own. */
    weak: /\b(patient|patients|clinician|clinicians|clinical|physician|physicians|nurse|nurses|hospital|hospitals|diagnosis|diagnostic|healthcare|medical|hipaa)\b/gi,
    weakThreshold: 4
  },
  {
    name: 'construction',
    decisive: new RegExp([
      'construction (management|software|industry|tech|technology|company|projects?)',
      'general contractor', 'sub ?contractor', 'job ?site', 'preconstruction',
      'building information model', '\\bbim\\b', 'architecture firm',
      'architectural (practice|firm|design)', 'built environment',
      'trade contractor', 'punch list'
    ].join('|'), 'i'),
    weak: /\b(construction|contractor|contractors|jobsite|blueprint|blueprints|architect|architects|foreman)\b/gi,
    weakThreshold: 4
  }
];

/**
 * A clearance requirement. Decisive on a single mention: a posting that asks
 * for one either requires it or does not, and it is not a matter of degree.
 */
const CLEARANCE = new RegExp([
  'security clearance', 'ts/sci', 'top secret', '\\bsecret clearance\\b',
  'public trust', 'polygraph', 'dod clearance', 'active clearance',
  'ability to obtain (and maintain )?a? ?clearance'
].join('|'), 'i');

/**
 * Remove benefits language so it cannot be mistaken for a domain signal.
 *
 * @param {string} text
 * @returns {string}
 */
export function withoutBenefits(text) {
  return String(text || '').replace(BENEFITS_NOISE, ' ');
}

/**
 * Which excluded domain a posting belongs to, if any.
 *
 * The company name and title are searched alongside the description, because
 * "Parsley Health" states its domain in its name and nowhere else. The
 * description is what settles the cases neither of those can.
 *
 * @param {{title?: string, company?: string}} job
 * @param {string|null} jd the description, when it could be read
 * @returns {{ruled: boolean, domain: string, why: string}}
 */
export function domainSignals(job, jd) {
  const parts = [job && job.title, job && job.company, jd].filter(Boolean).join('\n');
  const text = withoutBenefits(parts);

  if (CLEARANCE.test(text)) {
    const hit = text.match(CLEARANCE);
    return { ruled: true, domain: 'clearance', why: `requires a clearance: "${hit[0].trim()}"` };
  }

  for (const domain of DOMAINS) {
    const decisive = text.match(domain.decisive);
    if (decisive) {
      return { ruled: true, domain: domain.name, why: `"${decisive[0].trim()}"` };
    }
    const weak = text.match(domain.weak) || [];
    if (weak.length >= domain.weakThreshold) {
      return { ruled: true, domain: domain.name, why: `${weak.length} ${domain.name} terms` };
    }
  }
  return { ruled: false, domain: '', why: '' };
}

/** The domains a signed-in account can switch back on. */
export const TOGGLEABLE_DOMAINS = ['healthcare', 'construction', 'clearance'];
