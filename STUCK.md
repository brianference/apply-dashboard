# Stuck: what needs a human, and why

Written 2026-08-25. Everything here has been attempted repeatedly by the runner
and will not clear on its own. Each entry says what was tried and what would
actually unblock it, so none of it has to be re-diagnosed.

## Needs Brian, and nothing else — 5 postings, ~3 minutes

**Capital One (4 postings) and Vanguard (1)** are waiting on account
verification emails sent to brianference@protonmail.com.

The accounts EXIST and their passwords are stored in
`apply/workday-accounts.local.json`. The tenant created them and then refused to
sign in until the emailed link is clicked. Every later run gets a silent refusal
with no error text at all, which is why the credential carries a sticky
`pendingVerification` flag — the evidence arrives exactly once, on the run that
created the account.

Click the three links (Capital One, Vanguard, ServiceTitan) and the next run
picks all of them up unattended.

## Needs a supervised walkthrough — 1 posting

**HPE — Senior Inbound Product Manager, VME/Morpheus.** Reaches step 3 of 6 with
every question answered and then will not advance. No error banner, no named
field. Four separate wordings were added to `WD_QUESTIONS` for this posting and
each one cleared; the stall is something else.

This is the exact shape the Cisco walkthrough cracked: hold the browser open,
walk it a screen at a time, and read what the page is actually showing. See
`apply/WORKDAY-PLAYBOOK.md`, "When a run stops one screen short".

## Blocked by the employer, not by the driver

**Adobe (2 postings)** — `wd-auth-blocked`. Adobe reaches the wizard from a
stale cookie, then drops the session mid-application and lands on a signed-out
job-search page carrying a create-account form. The driver now refuses to trust
a reachable wizard as proof of being signed in, and signs in properly instead —
but Adobe still will not hold the session. Nothing false was recorded: both runs
correctly reported `submitted-unconfirmed` rather than counting.

**Vantage Data Centers** — the requisition is gone. Workday serves its 404 page.
Marked `posting-closed`.

## Walls that gate volume, not individual postings

| Wall | Postings | What clears it |
|---|---|---|
| Greenhouse one-time email code | ~73 | A supervised code relay: the runner fills and submits, the board emails a code, Brian pastes it into a file, the runner finishes. `--wait-for-code` with `--code-file`. |
| Lever hCaptcha | ~39 | One click each. The form fills COMPLETELY first — these runs report `still required and empty: (none)` before halting, so every one is a captcha away from submitted. |
| Aggregator listings | ~41 | Nothing. Himalayas hides the outbound link behind `/signup/talent`, WeWorkRemotely locks its apply button behind account registration, Monster serves a DataDome wall. 0 of 104 resolved to a real form. |
| Employer rate limits | ~17 | Time. |

## Ambiguous, and deliberately not counted

**~20 Ashby postings** show `submitted-unconfirmed`: the submit was clicked, no
confirmation text appeared, and no error banner appeared either. Vanta submitted
cleanly in the same run, so Ashby does produce confirmation text when it works —
which suggests these did not go through.

They are NOT recorded as applied. That is the correct default: a false positive
here means a job Brian never applied to disappears off his list forever.
