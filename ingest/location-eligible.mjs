/**
 * Is a posting acceptable to Brian?
 *
 * Two standing rules, both given on 2026-08-25 after a posting slipped through:
 *   LOCATION - remote (US-eligible) or Arizona. Nothing else.
 *   ROLE     - product management. Not engineering management.
 *
 * Both were caught by him rather than by the system: a San Francisco-only
 * Amplitude role reached the top of his list at 75%, and a "Senior Engineering
 * Manager, Enterprise AI Product" sat in a list meant for product roles. The
 * scoring rubric ranked them well because the rest of the posting matched; a
 * rank is not a filter, so these are enforced separately.
 *
 * The hard part of the location rule is that "remote" and a city name appear
 * together constantly and mean opposite things:
 *   "New York, San Francisco or Remote"          -> remote is an OPTION, eligible
 *   "Remote (San Francisco, CA)"                 -> remote FROM the Bay Area, not
 *   "Hybrid / FullTime / San Francisco / Remote" -> remote is an option, eligible
 * A bracket straight after the word remote is a RESTRICTION; a city listed
 * beside remote is a choice. Anything unreadable is ineligible rather than
 * assumed fine -- failing closed keeps a wrong posting off the list, and the
 * cost of that is one job he can add back by hand.
 *
 * @module
 */

/** Where he can work on site. */
const HOME = /\barizona\b|\baz\b|phoenix|scottsdale|tempe|chandler|\bmesa\b|gilbert|glendale|peoria|cave creek/i;

/** Wording that means the role can be done from anywhere in the US. */
const REMOTE = /\bremote\b|work from home|\bwfh\b|anywhere|distributed|telecommute|virtual/i;

/** The whole US offered, in any of the ways postings word it. */
const US_WIDE = /\busa?\b|u\.s\.|united states|nationwide|anywhere|worldwide/i;

/** A remote role fenced to somewhere he is not. */
const FENCED = /remote[^a-z0-9]{0,4}\(([^)]*)\)|remote\s*[-–—:]\s*([a-z .,]+)|remote only,\s*([a-z .,]+)|remote\s+in\s+([a-z .,]+)/i;

/** Countries and regions that exclude a US-based candidate. */
const NOT_US = /\b(canada|toronto|vancouver|montreal|ottawa|calgary|edmonton|winnipeg|quebec|india|bangalore|bengaluru|hyderabad|pune|chennai|mumbai|delhi|gurgaon|noida|kolkata|philippines|manila|indonesia|jakarta|vietnam|hanoi|thailand|bangkok|malaysia|kuala lumpur|mexico|guadalajara|brazil|sao paulo|argentina|buenos aires|colombia|bogota|chile|santiago|peru|lima|costa rica|united kingdom|england|london|manchester|edinburgh|ireland|dublin|france|paris|germany|berlin|munich|hamburg|frankfurt|spain|madrid|barcelona|portugal|lisbon|porto|italy|milan|rome|netherlands|amsterdam|utrecht|rotterdam|belgium|brussels|poland|warsaw|krakow|czech|prague|hungary|budapest|romania|bucharest|sweden|stockholm|norway|oslo|denmark|copenhagen|finland|helsinki|estonia|tallinn|latvia|lithuania|switzerland|zurich|geneva|austria|vienna|greece|athens|turkey|istanbul|russia|ukraine|kyiv|israel|tel aviv|dubai|uae|abu dhabi|saudi|qatar|south africa|cape town|johannesburg|nigeria|lagos|kenya|nairobi|egypt|cairo|singapore|japan|tokyo|osaka|korea|seoul|china|shanghai|beijing|shenzhen|hong kong|taiwan|taipei|australia|sydney|melbourne|brisbane|perth|new zealand|auckland|emea|apac|latam|anz)\b/i;

/** A US place that is not his, used only when no remote wording appears. */
const US_ELSEWHERE = /\b(new york|nyc|brooklyn|san francisco|bay area|palo alto|mountain view|sunnyvale|san jose|santa clara|cupertino|oakland|los angeles|san diego|seattle|bellevue|redmond|portland|denver|boulder|austin|dallas|houston|chicago|boston|cambridge|atlanta|miami|orlando|tampa|charlotte|raleigh|durham|nashville|detroit|minneapolis|philadelphia|pittsburgh|washington|arlington|mclean|reston|baltimore|salt lake|las vegas|kansas city|columbus|cleveland|indianapolis|milwaukee|omaha|new jersey|connecticut|virginia|maryland|colorado|california|oregon|texas|florida|georgia|illinois|massachusetts|north carolina|pennsylvania|ohio|michigan|minnesota|missouri|tennessee|utah|nevada|new mexico|idaho|montana|wyoming|iowa|kansas|nebraska|oklahoma|arkansas|louisiana|mississippi|alabama|kentucky|indiana|wisconsin|west virginia|delaware|rhode island|vermont|maine|new hampshire|alaska|hawaii|\bca\b|\bny\b|\bnc\b|\bwa\b|\btx\b|\bfl\b|\bil\b|\bma\b|\bco\b|\bga\b|\bva\b|\bpa\b|\boh\b|\bmi\b|\bmn\b|\bor\b|\but\b|\bnv\b)\b/i;

/**
 * @param {string|null|undefined} workType the posting's location text
 * @param {string} [title] the title, which sometimes carries "(Remote)"
 * @returns {{ok: boolean, why: string}}
 */
export function locationEligible(workType, title) {
  const text = ((workType || '') + ' ' + (title || '')).replace(/\s+/g, ' ').trim();
  if (!text) return { ok: false, why: 'no location given' };

  /* Arizona wins outright, remote or not: he can commute to it. */
  if (HOME.test(text)) return { ok: true, why: 'Arizona' };

  /* "Remote-Friendly (Travel-Required) | Washington, DC" is a hybrid role at a
     named office, not a remote one. The hyphenated form is marketing. */
  if (/remote[- ]friendly/i.test(text) && US_ELSEWHERE.test(text)) {
    return { ok: false, why: 'remote-friendly, but based at an office' };
  }

  if (!REMOTE.test(text)) {
    if (NOT_US.test(text)) return { ok: false, why: 'outside the US' };
    if (US_ELSEWHERE.test(text)) return { ok: false, why: 'on site, not Arizona' };
    /* "United States" with no city named cannot be an on-site requirement --
       there is nowhere to report to. Airbnb and Boulevard both list their
       postings this way and both are US-wide roles. */
    if (US_WIDE.test(text)) return { ok: true, why: 'US-wide, no city named' };
    return { ok: false, why: 'no remote wording and no Arizona' };
  }

  const fence = text.match(FENCED);
  /* Wellfound writes "Remote only, San Francisco", meaning remote SCOPED to the
     Bay Area. Without this the Felicis posting would have been added straight
     after Brian complained about exactly that shape. */
  const inside = fence ? (fence[1] || fence[2] || fence[3] || fence[4] || '').trim() : '';
  if (inside) {
    if (HOME.test(inside)) return { ok: true, why: 'remote, Arizona' };
    if (US_WIDE.test(inside)) return { ok: true, why: 'remote, US' };
    /* A fence only restricts if it names an actual PLACE. Rejecting on any
       bracketed text at all threw out a dozen good postings whose brackets held
       descriptive noise: "Remote - remoteType=Remote", "Remote (primary) -
       optional SF / Seattle / NYC", "Remote (unrestricted)", "TELECOMMUTE".
       Those are remote roles describing themselves, not restrictions. */
    const namesAPlace = US_ELSEWHERE.test(inside) || NOT_US.test(inside);
    if (namesAPlace && !US_WIDE.test(text)) {
      /* "optional SF / Seattle / NYC" lists offices you MAY use, which is not a
         restriction either. The giveaway is a word saying so. */
      if (!/optional|alternate|anchor|hub|or remote|primary/i.test(text)) {
        return { ok: false, why: 'remote but fenced to ' + inside.slice(0, 30) };
      }
    }
  }

  /* Remote, but only outside the US. */
  if (NOT_US.test(text) && !US_WIDE.test(text)) return { ok: false, why: 'remote outside the US' };
  return { ok: true, why: 'remote' };
}

/** Titles that are engineering management, not product management. */
const NOT_PRODUCT = /engineering manager|software engineer|\bswe\b|data engineer|platform engineer|devops|site reliability|\bsre\b|solutions architect|sales engineer|\bdesigner\b|\brecruiter\b|account executive|customer success|\bmarketing manager\b|program manager|project manager|scrum master|\banalyst\b|data scientist/i;

/** Titles that ARE product management, whatever else the string contains. */
const IS_PRODUCT = /product manager|product management|product lead|product owner|head of product|director of product|\bdirector,? product\b|vp of product|\bvp,? product\b|chief product officer|\bcpo\b|group product manager|\bgpm\b|technical product manager|\btpm\b|product sr\.? manager|senior director of product|sr\.? director of product|product, .*(platform|ai)|\bproduct.{0,14}(manager|management|lead|owner|director)\b/i;

/**
 * Is this a product-management role?
 *
 * "Senior Engineering Manager, Enterprise AI Product" contains the word
 * product and is not a product job, so the engineering test has to win when
 * both match.
 *
 * @param {string|null|undefined} title
 * @returns {{ok: boolean, why: string}}
 */
export function roleEligible(title) {
  const t = String(title || '').trim();
  if (!t) return { ok: false, why: 'no title' };
  if (NOT_PRODUCT.test(t)) return { ok: false, why: 'not a product role' };
  if (IS_PRODUCT.test(t)) return { ok: true, why: 'product' };
  return { ok: false, why: 'title does not say product management' };
}
