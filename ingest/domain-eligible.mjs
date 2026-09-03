/**
 * Domains Brian does not want.
 *
 * Healthcare and construction are read out of the DESCRIPTION rather than
 * guessed from the title. CRITERIA.md has listed them as skips since the
 * beginning. Nothing enforced them. `filter-to-criteria.mjs` holds an
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
 * Risk and compliance is the opposite decision. It is decided on the TITLE.
 * Healthcare searches title, company AND description because "Parsley Health"
 * states its domain in its name. Nearly every posting mentions compliance in
 * its legal boilerplate, and HIPAA on its own already ruled out Vanta. A
 * description search here would empty the list. Brian, 2026-09-02: these roles
 * are boring. The posting that prompted it was Jobgether's "Product Manager -
 * Risk Compliance" sitting at 73 percent.
 *
 * Hardware is a DESCRIPTION-decided domain, like healthcare. The title
 * "Staff Product Manager (vMetal)" says nothing. Brian, 2026-09-02, on
 * vCluster Labs sitting at 59 percent: i don't want hardware.
 *
 * Treating `silicon` or `bare metal` as decisive on a single mention was
 * wrong four times out of five. TLDR's only "silicon" sat inside an inc.com
 * URL; Camunda listed one "bare-metal" as a deployment target beside
 * Kubernetes; Jobgether named silicon as a partner ecosystem; Vultr sells
 * bare metal as one of four cloud product lines. Only vCluster was genuine.
 * URLs are stripped before any pattern in this file is matched, decisive
 * phrases have to mean a hardware product, and a weak term needs 6 hits --
 * that threshold is what dropped vCluster (11) and kept Vultr (4) and
 * GitLab (3).
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
 * A link slug can decide a rule. TLDR "Product Manager, Applied AI" would
 * have been ruled out as hardware because the only "silicon" in the posting
 * sat inside https://www.inc.com/.../tldr-the-definitive-silicon-valley-tech-newsletter.
 * That is true of every pattern in this file, not only hardware, so URLs
 * come out before anything is matched.
 */
const URL_NOISE = /https?:\/\/[^\s<>"'\)\]]+/gi;

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
  },
  {
    name: 'hardware',
    decisive: new RegExp([
      'physical hardware', 'racks of bare metal', 'hardware lifecycle',
      'hardware engineering', 'hardware manufacturing', 'hardware design',
      'hardware roadmap', 'server hardware', 'firmware', '\\bpcb\\b',
      '\\basic\\b', '\\bfpga\\b', 'chip design', 'semiconductor',
      'device manufacturing', 'board bring-up'
    ].join('|'), 'i'),
    weak: /\b(bare[- ]metal|silicon|hardware|racks?|chassis|smartnics?|nics?|bmc|ipmi|redfish)\b/gi,
    /* 6 is the measured gap: vCluster had 11 weak terms, Vultr 4, GitLab 3.
       A lower threshold re-introduces the four false positives above. */
    weakThreshold: 6
  }
];

/**
 * A clearance requirement. Decisive on a single mention: a posting that asks
 * for one either requires it or does not, and it is not a matter of degree.
 */
const CLEARANCE = new RegExp([
  /* `ts/sci` without a word boundary matched the "ts/Sci" inside
     "Arts/Sciences" and ruled Inovalon "Senior Principal Product Manager
     - Infusion" out as a clearance requirement. TS/SCI as its own token
     still matches. */
  'security clearance', '\\bts/sci\\b', 'top secret', '\\bsecret clearance\\b',
  'public trust', 'polygraph', 'dod clearance', 'active clearance',
  'ability to obtain (and maintain )?a? ?clearance'
].join('|'), 'i');

/* Title only. Standalone "governance" is deliberately omitted: Webflow's
   "Staff Product Manager, Governance" is data governance, a different job.
   "governance, risk" is the GRC product phrase that cannot mean that. */
/* Title only, for the same reason risk-compliance is. Nearly every product
   description mentions marketing somewhere -- a stakeholder, an adjacent
   team, a go-to-market paragraph -- so matching the description would rule
   out most of the queue. The title is where a product's domain is declared.

   This was a 25-point OFF-FOCUS PENALTY until 2026-09-03, and the comment in
   fit-score.mjs named "Staff Product Manager, Marketing Pro" as the case that
   must NOT be excluded, on the reasoning that a product manager working on a
   marketing product is still a product manager. Brian settled it: remove them
   from everywhere. A penalty left that posting at 41 percent and at the top of
   his $165k-this-week view, which is not what "outside your focus" should
   look like. Exclusion and de-ranking are different answers, and he wanted
   the other one. */
const MARKETING_TITLE = /\bmarketing\b|\bdemand gen(eration)?\b|\bmartech\b|\bcampaign management\b/i;

const RISK_COMPLIANCE_TITLE = /\brisk\b|\bcompliance\b|\bregulatory\b|\bgrc\b|governance,\s*risk/i;

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
 * Remove URLs so a link slug cannot be mistaken for a domain signal.
 *
 * @param {string} text
 * @returns {string}
 */
export function withoutUrls(text) {
  return String(text || '').replace(URL_NOISE, ' ');
}

/**
 * Which excluded domain a posting belongs to, if any.
 *
 * Healthcare, construction and hardware search the company name and title
 * alongside the description, because "Parsley Health" states its domain in
 * its name and nowhere else, and "Staff Product Manager (vMetal)" states
 * hardware nowhere in the title. Risk and compliance is title-only -- see
 * RISK_COMPLIANCE_TITLE.
 *
 * @param {{title?: string, company?: string}} job
 * @param {string|null} jd the description, when it could be read
 * @returns {{ruled: boolean, domain: string, why: string}}
 */
export function domainSignals(job, jd) {
  const title = String((job && job.title) || '');
  /* Title-first, unlike healthcare. A description search for "compliance" or
     "regulatory" is the HIPAA/Vanta trap again: legal boilerplate would rule
     out the list. The phrases below can only describe a GRC role or product
     when they sit in the title. */
  const riskHit = title.match(RISK_COMPLIANCE_TITLE);
  if (riskHit) {
    return {
      ruled: true,
      domain: 'risk-compliance',
      why: `title names a risk/compliance role: "${riskHit[0].trim()}"`
    };
  }

  const marketingHit = title.match(MARKETING_TITLE);
  if (marketingHit) {
    return {
      ruled: true,
      domain: 'marketing',
      why: `title names a marketing product: "${marketingHit[0].trim()}"`
    };
  }

  const parts = [job && job.title, job && job.company, jd].filter(Boolean).join('\n');
  /* URLs first, then benefits. A slug can carry any word this file matches,
     not only silicon, which is why stripping is not hardware-specific. */
  const text = withoutBenefits(withoutUrls(parts));

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
export const TOGGLEABLE_DOMAINS = ['healthcare', 'construction', 'clearance', 'risk-compliance', 'hardware', 'marketing'];

/**
 * Queued rows whose title (or company, for the description-based domains)
 * now fails a domain rule. Submitted rows are history and are dropped here
 * so a later write cannot rewrite them -- Coinbase "Group Product Manager,
 * Compliance Agent Experience" and Vanta "Senior Product Manager, GRC
 * Platform" are the two that would otherwise be rewritten. Already-skipped
 * rows keep the reason they were skipped, so toggling a domain back on
 * cannot resurrect a San Francisco role that also happens to say Risk.
 *
 * @param {Array<Record<string, any>>} rows
 * @returns {Array<{row: Record<string, any>, domain: {ruled: boolean, domain: string, why: string}}>}
 */
export function rowsToDomainBlock(rows) {
  const out = [];
  for (const row of rows || []) {
    if (!row || row.status !== 'queued') continue;
    const domain = domainSignals(row, null);
    if (!domain.ruled) continue;
    out.push({ row, domain });
  }
  return out;
}

/**
 * The UPDATE that skips one domain-excluded row. Parameterised. The WHERE
 * clause refuses a submitted row even if the caller forgot to filter.
 *
 * @param {{dedupe_key: string}} row
 * @param {{domain: string, why: string}} domain
 * @returns {{sql: string, params: Array<string|number|null>}}
 */
export function domainBlockWrite(row, domain) {
  return {
    sql: `UPDATE jobs SET status = ?, blocked_reason = ?, blocked_detail = ?,
      excluded_domain = ?, blocked_at = ?,
      rank_pct = NULL, pay_tier = NULL
      WHERE dedupe_key = ? AND status != ?`,
    params: [
      'skipped',
      'off-criteria',
      `domain: ${domain.domain} - ${domain.why}`.slice(0, 400),
      domain.domain,
      new Date().toISOString(),
      row.dedupe_key,
      'submitted'
    ]
  };
}
