# Workday, screen by screen

Written from driving Cisco's Product Manager, Cloud Platform (Data & Telemetry)
(Remote) all the way to **Application Submitted** on 2026-08-25, one screen at a
time with Brian watching. Every item below is something that actually broke, not
something that might.

The pattern worth keeping: **when a run stops one field short, hold the browser
open, walk it manually, and fix the driver from what you see.** Six real defects
came out of one supervised application. None had surfaced in dozens of
unattended runs, because a failed run closed its own window before anyone could
look at it.

---

## The lifetime rule

`finish()` closes the browser unless
`leaveOpen = !batchMode && HUMAN_TURN_STATES.has(state)`. In batch mode that is
**always false**, so every window a diagnosis needed had already gone.

- `--keep-open` now forces the browser to stay up regardless of outcome.
- The `wd-*` blocked states are in `HUMAN_TURN_STATES` so a standalone run leaves
  the window for a human.
- `apply/hold-open.local.mjs` owns a Chrome that never exits, on a **named**
  profile (`.hold-session`) so the sweep that kills `.apply-session-*` browsers
  cannot match it. Drive it with `apply/step.local.mjs`, `pick2`, `pick3`,
  `choose`, `checkbox`, `fill-nth`, `typeahead`, `click-text`, `click-error`.

## Clicking anything

Workday covers its buttons with an `aria-hidden` `div[data-automation-id="click_filter"]`.
A normal element click is intercepted and silently does nothing — Sign In looked
like it worked and did not.

**Click the button's coordinates**: `page.mouse.click(box.x + box.width/2, box.y + box.height/2)`.

Apply is an **anchor**, `a[data-automation-id="adventureButton"]`, not a button,
so a button-role lookup misses it entirely.

## Screen 1 - Start Your Application

The Apply click opens `div[data-automation-id="wd-popup-frame"]` containing
**Autofill with Resume** (`a[data-automation-id="autofillWithResume"]`) and
Apply Manually. A reporter that lists only page-level buttons shows nothing and
looks like the click failed.

Take Autofill with Resume: it parses the real PDF into Work Experience, which is
the only non-invented source for employment dates.

## Screen 2 - Create Account / Sign In

An account already exists per tenant. Click `signInLink`, fill `email` and
`password`, then click `signInSubmitButton` **by coordinates**.

Confirm sign-in by a utility menu whose text contains `@` — the create-account
form disappearing is not proof, and Autodesk renders a language picker with the
same `utilityMenuButton` id while signed out.

**Never print a field value without redacting.** A reporter dumped the account
password in full. `apply/redact.mjs` decides what is hidden, keyed on input
**type** and field **name**, and `apply/test-redact.local.mjs` fails if either
reporter stops redacting.

## Screen 3 - My Information

| Field | What goes wrong |
|---|---|
| `legalName--firstName` / `lastName` | Autofill writes the resume header in caps: **BRIAN**, **FERENCE**. Cisco raises "Verify that the field First Name is correctly capitalized because it contains more than 2 capital letters." It is an **alert, not an error**, so the field is never named in the validator output and no recovery fires. Fix: delete and **type** the profile spelling. `wdFill(..., { force: true })`. |
| `source` (How Did You Hear About Us) | `formField-source` is correct, but option lists are read **page-wide**, so the picker reported "options offered: United States of America (+1)" — the phone country code — and never answered. Press **Escape first** to dismiss a stale popup, then open. |
| `countryPhoneCode` | A **text** input, not a dropdown. Every select-based attempt clicked it forever. Type `United States of America (+1)`. |
| `countryRegion` (State) | Required. Escape, open, pick `Arizona`. |
| `phoneType` | Required. Always **Mobile**. |
| `candidateIsPreviousWorker` | A "were you ever employed by us" variant, worded per tenant ("Have you ever been issued a Cisco Employee ID..."). Answer **No**. Labels live in `label[for=id]`, not a wrapping label; `closest('label')` returns empty for every option. |

## Screen 4 - My Experience

The resume parse fills job titles and dates and **leaves Company blank**, which
is the "The field Company is required and must have a value" that stopped every
strict tenant. It also mangles rows: division names land in Company
("Oracle Cloud Infrastructure"), employers end up inside the title
("Project Manager / Scrum Master, Customer IT | SRP"), and "SEO" appears as an
employer.

Fill `companyName[i]` from `apply-profile.local.json` `experience.history`,
which is parsed from the attached PDF with PyMuPDF. The automation id is on a
`formField-` **wrapper**, not the input.

**Education**: Cisco's `school` is a `multiSelectContainer` search whose lookup
returns "No Items." for every query — the tenant's school list is broken. With
education already on the resume, delete the empty row (its own Delete button)
and move on.

## Screen 5 - Application Questions

Tenant questions carry **opaque GUID field ids**, so match on the label text.
Cisco's five:

| Question | Answer |
|---|---|
| Legally authorized to work | Yes |
| Will you require sponsorship | No |
| Years of relevant experience | highest band offered (`4+ years`) |
| Government official / employed by a government entity | No (Brian's instruction) |
| Family or close personal relationship at the company | No |

Escape regex metacharacters before matching an option: an option literally named
`4+ years` turned `^\s*4+ years\s*$` into "one or more 4s" and matched nothing.

## Screen 6 - Voluntary Disclosures

Decline everywhere the form allows it. Wordings seen: `Do Not Wish to Disclose
(Candidate ONLY)`, `I do not wish to self-identify`, `I choose not to disclose
(United States of America)`, and NVIDIA's `Decline to State`.

Long lists are **virtualised**: an exact match finds nothing because the row is
not painted. Scroll the option into view first (`pick3`).

## Screen 7 - Self Identify, then Review

`name` and a **date**. The date is three segment inputs
(`dateSectionMonth-input` / `Day` / `Year`) that **auto-advance after two
digits**, so typing `08 25 2026` produced `2/2/2006`. There is no calendar icon
inside the field group on this tenant. Set each segment with `fill()`, never
`type()`, and read all three back before saving.

`disabilityStatus` is a choice group: "I do not want to answer".

Review has **Submit**, not Save and Continue. Confirmation is a modal reading
**Application Submitted**, and My Applications shows the row with status
`Application Received`.

---

## When a run stops one screen short

1. Stop the orchestrator so nothing sweeps Chrome.
2. `node apply/hold-open.local.mjs "<url>"`.
3. Walk it with `step`/`pick2`/`pick3`/`choose`/`checkbox`.
4. Ask Brian to fix anything the driver cannot reach, and watch what he does.
5. Fold the fix into `workday-drive.mjs` and add the wording to `WD_QUESTIONS`.

**Check for live processes before saying you have paused.** A rejected tool call
does not kill a process that already started; `date2.local.mjs` kept clicking the
date field after I said I had stopped.

---

## The five-approaches rule

**When a step is blocked, try five genuinely different approaches before
recording a blocked state.** Overnight there is nobody to ask, so a run that
gives up on the first failure retires a posting for a problem that a different
technique clears. "Different" means a different mechanism, not the same click
with a longer timeout.

The approach ladder that actually worked on Workday, in order:

1. **Coordinate click** — `page.mouse.click(box.x + w/2, box.y + h/2)`. Beats
   the `aria-hidden` `click_filter` overlay, which silently swallows an element
   click and returns success.
2. **Click the overlay itself** — `click_filter` is the sibling that receives
   the real event on some tenants.
3. **Element click**, then **forced click** (`{ force: true }`) — for a control
   Playwright considers obscured but that is genuinely hittable.
4. **Keyboard** — Escape to dismiss a stale popup, then open and arrow/type.
   A leftover popup is why one picker read the phone country-code list.
5. **Scroll it into view first** — virtualised option lists do not paint rows
   outside the viewport, so an exact match finds a node that cannot be clicked.

Two rules that sit on top of the ladder:

- **Trust the readback, not the return value.** Every one of the five can
  report success and change nothing. Re-read the control's own text and treat
  "Select One" as a failure.
- **Escalate the mechanism, not the patience.** Retrying the same call with a
  bigger timeout is one approach tried twice, not two approaches.

`wdClick` and `wdSelect` in `apply/workday.mjs` implement this ladder. Anything
new that gets stuck gets a sixth rung added here, not a `sleep`.

---

## Second night, 2026-08-25: what an unattended run hits

The supervised Cisco walkthrough fixed what a human can see. These are the
things only a batch of thirty finds, each taken from a real runlog.

### The queue was empty and nobody noticed

Thirty of thirty-one postings carried a terminal `wd-*` state in
`evidence/apply/batch-ledger.json`, recorded by a driver that no longer existed.
An improved driver was handed nothing and reported "queue exhausted" after one
posting. Ledger entries now carry `driver`, a hash of `runner.mjs` +
`workday.mjs` + `workday-drive.mjs`, and a `wd-*` block written by a different
build re-opens. `submitted`, `skipped-already-applied`, `captcha-blocked` and
`employer-rate-limit` never re-open: those describe the POSTING, not the code.
Both directions are tested in `apply/test-ledger-stale.local.mjs`.

### The dates went into the wrong boxes

`11/2025` came back as `12/2011`. Same shape on every row: `06/2010 -> 12/2006`,
`01/2016 -> 12/2001`, `05/2006 -> 12/2005`. The year box got the month and the
month clamped to 12. It is a masked **MM/YYYY** pair that auto-advances after
two digits, so setting the segments separately cannot work.

**Type the whole date into the month segment** and let auto-advance carry it.
Then read the pair back -- the readback is what found this, because the log
said "experience 5 = title at company" either way.

Which technique a tenant accepts is a property of the **tenant**, so learn it on
the first date and reuse it. Running all four on seven rows cost about two
minutes and blew the 300s watchdog; Workday now gets 900s of its own.

### An unverified credential is worse than no credential

`tenantCredentials` wrote a generated password at GENERATION time, not after a
confirmed creation. Seven postings across four tenants reused a password that
was never registered. Credentials now carry `verified`, set only when a sign-in
actually succeeds.

The recovery ladder then found the real wall: Capital One and Vanguard answer a
successful create with **"An email has been sent to you. Please verify your
account."** The account now EXISTS with that password -- reporting a plain
failure threw it away and left a real account nobody could sign into, which is
strictly worse than never having tried. That case returns
`wd-email-verification`, persists the credential, and stops rather than creating
a second unverified account on the alternate address.

### Things that were there all along

| Symptom | What it actually was |
|---|---|
| ServiceTitan `wd-no-apply-path` | A social-login gate. The wizard was rendered the whole time behind **"Sign in with email"**. Take that one only, never the Google or LinkedIn buttons. |
| Autodesk "The field To is required" | Its "I currently work here" checkbox carries no `currentlyWorkHere` id, only the label. Without the tick there is no way to say Present. |
| `no option matching ^no$` | The option is "No, I have not". Relax the TAIL anchor to a word boundary, never the head. |
| "Please select your ethnicity" x4 | EEO fields on a page not named Voluntary Disclosures, so `fillDisclosures` never ran on it. |
| Cisco's family-relationship question | 250 characters of parenthetical before the word "employee", so no proximity window reaches it. The test had been passing against a paraphrase. |
| Autodesk `submitted-unconfirmed` | It was submitted. The check read the first 1500 characters and the confirmation modal renders after the Candidate Home content. Read the whole page. |
| Every Workday row showing a blank reason | `markBlocked` scraped only lines shaped `  ! ` and the driver reports on a `WORKDAY:` line. |

### Standing rules this produced

- **Trust the readback, never the return value.** Every click, fill and select
  can report success and change nothing.
- **Log what was OFFERED on a failed pick.** "no option matching ^no$" on its
  own is unusable in the morning.
- **A verdict is evidence about the code that produced it.** Pin it to that
  code, or it earns credit forever.
