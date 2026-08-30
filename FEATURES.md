# Features and their test coverage

A running list of what this product does and what actually proves each part
works. It exists so a gap is visible rather than assumed: a row with no test
named against it has not been checked, and saying so is the point.

Update this in the same commit as the feature. `node tests/check-coverage.mjs`
fails when a test named here does not exist on disk, so the table cannot quietly
drift away from reality.

**Automated** names a file that runs and exits non-zero on failure.
**Seen** means a rendered screenshot of the deployed page was opened and looked
at, which is the only thing that catches layout. Both matter; neither replaces
the other. Three defects in this repo passed every assertion and were caught
only by the screenshot: a page that rendered blank under a working header, a
dead gap in the mobile invitation, and a portfolio showing another person's
projects.

## Job pipeline

| Feature | Automated | Seen | Notes |
|---|---|---|---|
| Read employers' boards twice a day | `ingest/test-sync.mjs` | n/a | 269 companies in `ingest/companies.json`, plus eight source modules in `ingest/sources/` |
| Rank a posting against the resume | `ingest/test-fit.mjs` | n/a | Inverse document frequency over the cached descriptions |
| Location and role eligibility | `ingest/test-location.mjs` | n/a | Remote or Arizona, product roles only |
| Pay floor rules a posting out | — | — | **Gap.** `ingest/salary-sweep.mjs` has no test. Its write loop threw on the first rejected row and abandoned the rest, reporting 205 bands found while saving 7 |
| Off-focus domain penalty | `ingest/test-off-focus.mjs` | n/a | Marketing costs 25 points; product marketing is excluded outright as a different family |
| Healthcare, construction and clearance excluded | `ingest/test-domain.mjs` | yes | Read from the DESCRIPTION. Fixtures include the two false positives it produced first: Vanta (HIPAA as a compliance framework) and Elastic (the Employee Polygraph Protection Act notice) |
| Advanced search puts them back | — | yes | **Gap.** Switches are covered by a browser check that is not yet in the repo |
| Apply queue ordering | `apply/test-order.mjs` | n/a | Carries a known-bad block that runs the retired comparator and asserts it fails |
| Stat tiles match their rows | `apply/test-counts.mjs` | yes | Runs against production in CI |
| Resolve an aggregator link to the employer's form | `ingest/test-resolve-by-board.mjs` | n/a | |

## Accounts

| Feature | Automated | Seen | Notes |
|---|---|---|---|
| Register through the API | `tests/third-party-signup.mjs` | n/a | Checks the ROW, not the status code: registration answers 200 either way so it cannot leak which addresses exist |
| Register through the real form | `tests/browser-signup.mjs` | yes | 24 checks, drives the browser |
| Password minimum of 15 characters | `tests/browser-signup.mjs` | yes | Refused before anything is sent, and no row is written |
| A duplicate address cannot be detected | `tests/browser-signup.mjs` | n/a | Byte-identical message, no second row |
| Activation link signs them in | both signup tests | yes | |
| Sign-in refused before activation | `tests/third-party-signup.mjs` | n/a | |
| Password reset by email | `tests/third-party-signup.mjs` | partial | The link is exercised; inbox delivery is confirmed in Brevo's log, not here |
| Registration rate limit | `tests/browser-signup.mjs` | n/a | 5 per hour per IP; a burst of 7 is checked to create fewer than 7 |
| The header identity is the caller's own | `tests/browser-signup.mjs` | yes | Added after `/api/auth/me` was found reading `WHERE id = 1` and handing every stranger the owner's name and photo |
| Origin-checked writes | — | n/a | **Gap.** Verified by hand with curl; no test file |

## The list

| Feature | Automated | Seen | Notes |
|---|---|---|---|
| Signed-out preview of the job list | `tests/third-party-signup.mjs` | yes | |
| Signup invitation above the full-time table | `tests/promo-strip.mjs` | yes | Both widths, including the mobile gap that assertions missed |
| Marking a job is private to the account | both signup tests | n/a | The shared row is re-read afterwards and must still say `queued` |
| Header search and the `/` shortcut | — | yes | **Gap.** Verified by screenshot only |
| Filter chips | — | yes | **Gap.** No test |

## Onboarding

| Feature | Automated | Seen | Notes |
|---|---|---|---|
| First-run spotlight tour | `tests/tour.mjs` | yes | Five steps at 1280 and 390; the overlap check was confirmed to FAIL when the popover is forced onto the cutout |
| Runs once per account | `tests/tour.mjs` | yes | `profile.tour_seen_at`, marked on finish or skip, never on open |
| Replay from the account menu | `tests/tour.mjs` | yes | Does not re-mark seen |
| `POST /api/tour/seen` is guarded | — | n/a | 401 without a session and 403 on a bad origin, both checked by hand against production |
| Step screenshots | `tests/tour-shots.mjs` | yes | Regenerates every step at both widths |

## Profile and portfolio

| Feature | Automated | Seen | Notes |
|---|---|---|---|
| Private profile, own row only | `tests/browser-signup.mjs` | yes | |
| Photo upload, resized in the browser | — | yes | **Gap.** No test; the CSP `blob:` failure was found by hand |
| Custom portfolio address | `tests/portfolio-addresses.mjs` | yes | Shape, reserved words and collision are enforced server-side |
| `/portfolio/<handle>` serves the page | `tests/portfolio-addresses.mjs` | yes | Both with and without a trailing slash |
| A portfolio shows only its own account | `tests/portfolio-addresses.mjs` | yes | Name, resume text AND the project list |
| Contact details never reach a public page | — | yes | **Gap.** `stripContact` has no unit test |
| The owner's projects still render | `tests/portfolio-addresses.mjs` | yes | A fix that hid them from everyone would pass every other check |

## Pages

| Feature | Automated | Seen | Notes |
|---|---|---|---|
| About, Terms, Privacy, Contact | — | yes | **Gap.** Word and section counts were measured once by hand |
| Footer on every page | — | yes | **Gap.** |
| Light default, dark on toggle | — | yes | **Gap.** No automated theme check |

## Known gaps, gathered

The rows marked **Gap** above, in one place, so they can be worked through:

1. The pay floor has no test, and it is the rule that decides what is shown.
2. The advanced-search switches are verified by a browser run and a screenshot, but that check is not yet a file in `tests/`.
2. `stripContact` has no unit test, and it is what keeps a phone number off a
   public page.
3. Header search, filter chips, theme toggle and the legal pages are verified by
   screenshot only.
4. Origin-checked writes and photo upload are verified by hand.

## Running them

```bash
CF_D1_TOKEN=<token> node tests/third-party-signup.mjs
CF_D1_TOKEN=<token> node tests/browser-signup.mjs
node tests/promo-strip.mjs
node tests/portfolio-addresses.mjs
node tests/check-coverage.mjs
```

The two signup tests create a throwaway account and delete it again. They clear
their own registration attempts first, because the limiter would otherwise
refuse them silently and every later step would fail for a reason that has
nothing to do with the product.
