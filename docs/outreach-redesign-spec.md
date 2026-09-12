# Spec: three design variations for the outreach card

Build a single comparison page showing THREE structurally distinct designs for
the outreach card, so Brian can pick one (or mix: "layout of B, density of C").

## What you are redesigning

`https://apply-dashboard.pages.dev/outreach/` — the page that answers "who do I
message about this job". Read the live page and its source before designing:

- `web/outreach/index.html`
- `web/outreach/js/main.js` (card rendering, grouping, address derivation)
- `web/outreach/js/search-urls.js` (the four searches, the four openers)
- `web/outreach/css/outreach.css` (tokens — copy these, do not invent a palette)
- `web/outreach/data/contacts.json` (the real researched people)

Each card currently carries, in one vertical stack:

1. Rank chip, title, employer, pay band, age, "applied" tag, link to the posting
2. Four numbered LinkedIn searches, each with a one-line reason
3. "Named people": 3 to 9 people, each with name, verbatim title, a tag saying
   whether the link is a published profile or a name search, a `source` link, a
   free-text note, and for 3 of 9 employers a derived email address with a label
   giving the share and sample size it rests on
4. Four message openers in `<details>`, each with a body, a note and a copy
   button

**The problem to solve.** It is a long vertical scroll and everything has equal
weight. A card with nine named people is over 1000px tall. Brian works through
this list in a sitting, so the questions that matter are: who do I write to
first, what do I say, and has this one been done. The current design answers all
three at the same volume.

## Hard constraints — a variation that breaks any of these is rejected

1. **REAL DATA ONLY.** Fetch `/api/jobs` and `./data/contacts.json`. Never
   hand-author a person, a company, a rank, a pay band or an address. No lorem
   ipsum, no "John Smith", no placeholder avatars.
2. **Every named person keeps a visible `source` link.** A name without its
   source is the one thing this page must never show. Do not move it behind a
   hover or a tooltip only; it must be reachable without hovering.
3. **A derived email address keeps its label** stating the shape, the percentage
   and the sample size. It must not read as verified. Employers with no
   convention must still say so somewhere on the card.
4. **A profile link is only ever one present in `contacts.json` as `profile`.**
   Never construct a `linkedin.com/in/...` URL. Where there is none, the link is
   the name search already built by `namedSearch()`.
5. **Light is the default** whatever the OS prefers, matching the rest of the
   site. Use the tokens in `outreach.css`; support `:root[data-theme="dark"]`.
6. No external CSS or JS. No Tailwind CDN. No web fonts beyond the IBM Plex
   already linked.
7. Works at 375, 768 and 1280 with no horizontal scroll.
8. Every opener must still end in a question and be copyable.

## The three variations must be STRUCTURALLY different

Not the same component recoloured. Different information architecture. Pick the
three you believe are genuinely the best UX for this task; these are the
directions I think are most promising, but argue for something better if you see
it:

- **A: roster table.** The people become a dense, scannable table (name, title,
  why, source, address) with the searches collapsed to a single row of chips.
  Optimised for "scan ten employers fast".
- **B: one thing at a time.** The method becomes a stepper. Card shows step 1
  only; completing or skipping advances it. Optimised for "stop deciding, just
  work the list".
- **C: split detail.** Employer list on the left, selected employer's people and
  openers on the right, master-detail. Optimised for "compare and go deep".

## Deliverable

One file: `web/outreach/variations.html`, self-contained apart from the shared
tokens, that renders all three variations side by side with real data, each
labelled A/B/C with a one-line statement of what it optimises for and what it
gives up. Include a light/dark toggle for the whole page. Make each column
independently scrollable so a tall card does not stretch the page.

Do not modify any existing file. Do not deploy. Do not commit.

## When you are done

Report: the file path, what you changed your mind about while building, and
which of the three you would ship and why. Name the trade-off each one loses.
