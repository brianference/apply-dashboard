/**
 * The words on the About, Terms, Privacy and Contact pages.
 *
 * Structured sections rather than one blob, so the page renders headings and
 * lists instead of a wall of paragraphs, and so a section can change without
 * touching markup.
 *
 * EVERY STATEMENT HERE IS TRUE OF THIS APP. It was written from what the code
 * does - the tables that exist, the third parties actually called, the one
 * cookie actually set - not from a template. Boilerplate about cookies that are
 * not set is as wrong as omitting a disclosure.
 */

/** Changed when the substance changes, not on every deploy. */
export const LAST_UPDATED = "28 August 2026";

/** @typedef {{heading: string, body?: string[], list?: string[]}} Section */

/** @type {{title: string, intro: string[], sections: Section[]}} */
export const ABOUT = {
  title: "About AI PM Jobs",
  intro: [
    "A job list for product managers working on AI, and a place to keep track of what you actually applied to.",
    "It exists because the useful signal about a posting - what it pays, whether it is genuinely remote, whether it is a product role at all - is buried in the description, and no job board reads it for you."
  ],
  sections: [
    {
      heading: "Where the postings come from",
      body: [
        "Twice a day the pipeline reads employers' own public job boards directly: Greenhouse, Ashby and Lever, currently 269 companies. It also reads the public feeds of Himalayas, WeWorkRemotely, RemoteOK and Jobspresso.",
        "Nothing is taken from behind a login, and no posting is invented. A listing that cannot be read is recorded as unread rather than guessed at."
      ]
    },
    {
      heading: "What happens to a posting before you see it",
      list: [
        "The description is fetched from the employer's own board and read.",
        "The published pay band is extracted from that description. A band whose START is below the floor is ruled out, however high its top goes. An absent band is treated as unknown, never as acceptable.",
        "Location and role rules are applied: remote and US-eligible or in Arizona, product management rather than program or engineering management.",
        "What remains is ranked against a resume, and the reason for each rank is shown on the row."
      ]
    },
    {
      heading: "What this is not",
      list: [
        "Not a job board. Applications go to the employer's own site, and nothing is submitted on your behalf from here.",
        "Not affiliated with any employer named on it.",
        "Not a guarantee a posting is open. Listings go stale, get filled and get withdrawn, and this list can lag reality.",
        "Not a salary data source. The bands shown are the numbers the employer published, quoted as found."
      ]
    },
    {
      heading: "Honest limitations",
      list: [
        "Coverage is only as wide as the boards being read. A company hiring elsewhere will not appear.",
        "Pay is known only when the employer publishes it. Many do not, and those rows show no band.",
        "A rank is an opinion produced by matching a description against a resume. It is a starting point for your judgement, not a substitute for it.",
        "Aggregator listings often hide the employer's real application URL. Where it could not be resolved, the link goes to the aggregator."
      ]
    }
  ]
};

/** @type {{title: string, intro: string[], sections: Section[]}} */
export const TERMS = {
  title: "Terms of Use",
  intro: [
    "Plain terms for a small product. Using the site means accepting them.",
    "The one that matters most: the listings here are collected from public sources, may be out of date, and are not an offer of employment from anyone."
  ],
  sections: [
    {
      heading: "The service",
      body: [
        "AI PM Jobs shows product-management postings gathered from public job boards, ranks them, and lets a signed-in account record which ones it applied to and what came back. An account may also publish a portfolio page.",
        "Accounts are free. There is no paid tier and nothing is charged."
      ]
    },
    {
      heading: "Listings are a snapshot, not an offer",
      body: [
        "Every posting is a copy of what a public board showed when it was read. Postings close, change and get withdrawn without notice. The pay bands, locations and requirements shown are the employer's words as published, not a representation by this site.",
        "Confirm the details on the employer's own page before relying on them. Nothing here creates any relationship between you and any employer named."
      ]
    },
    {
      heading: "Eligibility and your account",
      list: [
        "You must be old enough to enter a contract where you live, and at least 16.",
        "One person per account. Keep your password to yourself.",
        "You are responsible for what is published from your account, including anything on your portfolio page.",
        "Accounts publishing unlawful material, impersonating someone, or used to attack the service may be removed."
      ]
    },
    {
      heading: "Acceptable use",
      list: [
        "Do not scrape, bulk-download or resell the listings.",
        "Do not attempt to reach another account's data, or to probe, disrupt or overload the service.",
        "Do not upload anything you do not have the right to publish.",
        "Automated access beyond ordinary browsing is not permitted."
      ]
    },
    {
      heading: "Your content stays yours",
      body: [
        "Your resume text, links, photo and portfolio remain yours. Publishing a portfolio allows this site to display it at its public address, and nothing more. Deleting it withdraws that.",
        "The site's own code, wording and design are not yours to reuse."
      ]
    },
    {
      heading: "Third parties",
      body: [
        "Hosting and the database are Cloudflare. Transactional email is Brevo. Typefaces load from Google Fonts. Repository details on a portfolio come from the GitHub API. Their own terms govern their services."
      ]
    },
    {
      heading: "No warranty",
      body: [
        "The service is provided as it is, without warranty of any kind. It may be unavailable, may contain errors, and may show listings that are wrong or gone. It is not career, financial or legal advice."
      ]
    },
    {
      heading: "Limitation of liability",
      body: [
        "To the extent the law allows, this site is not liable for indirect or consequential loss, or for lost opportunities, arising from its use. Nothing here excludes liability that cannot lawfully be excluded."
      ]
    },
    {
      heading: "Availability and changes",
      body: [
        "This is a small project run by one person. It may change, break or stop, and features may be withdrawn without notice.",
        "These terms may change. The date above says when they last did, and continuing to use the site accepts the current version."
      ]
    },
    {
      heading: "Governing law and contact",
      body: [
        "These terms are governed by the laws of the State of Arizona, United States. Questions go through the contact page."
      ]
    }
  ]
};

/** @type {{title: string, intro: string[], sections: Section[]}} */
export const PRIVACY = {
  title: "Privacy",
  intro: [
    "What this site stores, why, and who else sees it. Written from what the code does.",
    "The short version: an email address and a password you choose, whatever you put in your own profile, and which jobs you marked. No analytics, no advertising, no tracking pixels, and nothing sold."
  ],
  sections: [
    {
      heading: "What is collected",
      list: [
        "Your email address, so an account can exist and be recovered.",
        "Your password, stored only as a salted and peppered hash. The password itself is never written down and cannot be read back, by anyone.",
        "Session records: a hash of the session cookie, when it was created, last used, and when it expires. The cookie value itself is not stored.",
        "Sign-in attempts, for rate limiting: the address tried and a hash of the connecting IP. These are deleted after 24 hours.",
        "Whatever you put in your profile: display name, headline, location, LinkedIn and GitHub links, resume text and filename, and a photo if you upload one.",
        "Which postings you marked as applied, and any outcome you record against them."
      ]
    },
    {
      heading: "What is NOT collected",
      list: [
        "No analytics of any kind. There is no Google Analytics, no Plausible, no tracking pixel and no advertising script on any page.",
        "No payment details. Nothing is charged.",
        "No location beyond the text you type into your own profile.",
        "No contacts, calendar, or anything from other services.",
        "Your data is never sold, rented, or shared for advertising."
      ]
    },
    {
      heading: "Why each thing is held",
      list: [
        "Email and password hash: to authenticate you, and for nothing else.",
        "Session records: to keep you signed in, and to let a session be revoked.",
        "Sign-in attempts: to stop password guessing. That is the only reason an IP hash exists here, and it is why they are deleted daily.",
        "Profile and portfolio: because you asked for them to be shown.",
        "Applied marks and outcomes: so your own list is accurate to you."
      ]
    },
    {
      heading: "Who else receives it, by name",
      list: [
        "Cloudflare - hosts the site and the database. Account and profile data lives in Cloudflare D1.",
        "Brevo - sends the activation and password-reset emails, and so receives your address and the message. Mail is sent from no-reply@txeas.com.",
        "Google Fonts - pages load typefaces from fonts.googleapis.com and fonts.gstatic.com, so Google receives your IP address and browser details on page load. Nothing else is sent to Google.",
        "GitHub - repository details on a portfolio are fetched by the server, not by your browser, so GitHub does not see visitors to this site."
      ]
    },
    {
      heading: "Cookies and local storage",
      list: [
        "One cookie: __Host-session. It keeps you signed in, is HttpOnly and Secure, expires after 14 days, and is cleared when you sign out. There are no advertising or analytics cookies.",
        "Local storage in your own browser holds your theme choice and, on the job list, your column widths, collapsed sections, and any mark not yet saved. It stays on your device and is sent nowhere except when a mark is recorded."
      ]
    },
    {
      heading: "What is public",
      body: [
        "A portfolio page is public by design, and anyone with its address can read it. Your name, headline, location, links, photo and the resume sections you allow appear there.",
        "Your email address and phone number are NOT published. Contact details are stripped from the resume text before any of it reaches a public page."
      ]
    },
    {
      heading: "Where it lives and how long",
      list: [
        "Data is stored in Cloudflare D1 and served from Cloudflare's global network, so it may be processed outside your country, including in the United States.",
        "Account, profile and applied marks are kept until you delete them or ask for the account to be removed.",
        "Sessions expire after 14 days. A reset link expires in one hour and an activation link in 24. Sign-in attempt records are deleted after 24 hours."
      ]
    },
    {
      heading: "Your rights",
      body: [
        "Depending on where you live you may have the right to see the data held about you, correct it, delete it, take a copy, or object to its use. Most of that is immediate: the profile page shows and edits everything held about you, and a photo is removed with one click.",
        "For anything the pages do not cover, including deleting an account entirely, ask through the contact page and it will be actioned within 30 days."
      ]
    },
    {
      heading: "Children",
      body: [
        "This is not for children. Accounts are not knowingly created for anyone under 16, and any such account found will be deleted."
      ]
    },
    {
      heading: "Security",
      list: [
        "Passwords are hashed with PBKDF2 over an HMAC of the password and a server-side pepper that is not stored in the database.",
        "The session cookie is HttpOnly, so page scripts cannot read it, and only its hash is stored.",
        "Writes require a matching origin, and repeated failed sign-ins lock an account temporarily.",
        "No system is perfectly secure, and this one is run by one person."
      ]
    },
    {
      heading: "Changes and contact",
      body: [
        "Material changes are reflected in the date at the top of this page. Privacy questions and requests go through the contact page."
      ]
    }
  ]
};

/** @type {{title: string, intro: string[], sections: Section[]}} */
export const CONTACT = {
  title: "Contact",
  intro: [
    "One person runs this. Here is how to reach him and what to expect."
  ],
  sections: [
    {
      heading: "How to get in touch",
      body: [
        "Message Brian Ference on LinkedIn at linkedin.com/in/brianference. That is the reliable route and the one that is checked."
      ]
    },
    {
      heading: "What to include",
      list: [
        "A wrong or stale listing: the company, the role title, and what is wrong with it.",
        "Something broken: the page, what you did, and what happened instead.",
        "An account problem: the address on the account, and never your password."
      ]
    },
    {
      heading: "Privacy requests",
      body: [
        "To see, correct, export or delete the data held about you, say so explicitly and it will be actioned within 30 days. Most of it you can do yourself on the profile page."
      ]
    },
    {
      heading: "What response to expect",
      body: [
        "This is a side project, not a company with a support desk. Expect a reply within a few days, and understand that not every request can be met."
      ]
    },
    {
      heading: "Reporting a security problem",
      body: [
        "If you find a way to reach another account's data, bypass sign-in, or otherwise break the security of this site, report it through LinkedIn rather than publishing it, and it will be looked at the same day it is seen.",
        "Please do not run automated scans against the site. It is one small deployment, and load testing it is indistinguishable from attacking it."
      ]
    },
    {
      heading: "For employers",
      body: [
        "If a posting attributed to your company is wrong, stale, or you would rather it were not listed, say so and it will be removed. Listings are read from your own public job board, so correcting it at the source also fixes it here on the next run."
      ]
    }
  ]
};
