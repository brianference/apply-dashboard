# The outreach method

What `/outreach/` does, where each piece came from, and the two rules that decide
what is allowed on the page.

## The two rules

**A name needs a source.** Nothing in the jobs database knows who a hiring
manager is. Every name on the page was read on a primary source, and the page
shows a link to the page it was read on. Aggregator and scraper sites
(RocketReach, ZoomInfo, Comparably, Apollo, Lusha) are not evidence of current
employment and are not used.

**A link needs a provenance.** A `linkedin.com/in/` link appears only when the
person published that exact URL somewhere public. Otherwise the link is a search
scoped to their name and employer, which resolves to the real profile without
constructing anything. A guessed slug is either a 404 or a stranger's profile
presented as the hiring manager, and the two are indistinguishable by looking.

`tests/outreach.mjs` enforces both. It reads `web/outreach/data/contacts.json`
and fails on any rendered profile link absent from that file, on any person
rendered without a source, and on any person whose link neither is their
declared profile nor carries their own quoted name.

## Where the method came from

### Aakash Gupta's LinkedIn post

Source: `linkedin.com/feed/update/urn:li:activity:7504051227832451072`, read
2026-09-11. Five minutes of LinkedIn per company: open the company, go to
People, search the function the role sits in, find the two or three people who
posted about that team or opening in the past month. If nobody has, work through
a recruiter's connections inside the company. Message **before** applying.

This supplies the four numbered steps on every card, in that order, and the
three message shapes: work product, relatability, free offering. Its constraint
is the part a personalised template loses first, so it is tested: every opener
ends in a question answerable in one sentence.

### jobcopilot.com/how-to-find-hidden-jobs

Read 2026-09-11. Thinner than the title suggests: mostly a walkthrough of their
own paid contact lookup. Three things in it were worth taking.

**Kept: the connect-then-message sequence.** Connect on LinkedIn with *no* note,
then send the message once the connection is accepted. An invitation carrying a
pitch gets declined; a bare one is usually accepted, and the message then
arrives from a connection rather than a stranger. This is on the card.

**Kept, rewritten: the cold intro.** Their template ends `I have attached my
resume for reference` with no question in it. A resume attached to a cold first
message asks the reader to do the work and gives them nothing to answer. The
page's fourth opener, "Before the opening", keeps their *timing* idea -- reach an
employer before a posting is public -- and replaces the ending with one question
answerable in a word.

**Rejected: their answer on addresses.** Their whole method for finding a hiring
manager's email is to spend credits inside their product. They name no address
pattern, no verification method and no alternative tool. So that part was built
from evidence instead, below.

## Addresses, derived and labelled as derived

Every git commit carries the author's address in its metadata, and a public
repository publishes it. People put their work address there themselves, by
committing. `ingest/email-sweep.mjs` reads those, filters to the employer's own
domain, and derives the *shape* the employer uses.

What gets stored is a shape and a count. **No address is ever written to this
repository**, which is public. The page applies the shape to a name in the
reader's browser and labels the result with the share and the sample size it
rests on.

Two floors, because a confident answer derived from nothing is worse than no
answer:

- at least **4 unique** addresses on the domain
- at least **70%** of them agreeing on one shape

Counting *unique addresses* rather than occurrences is the whole measurement.
Measured both ways on `docker.com`, occurrences said 54 of 54 agreed; unique
addresses said 17 of 19. The second is the real figure and the first is one
prolific committer counted thirty times.

Current readings, from `node ingest/email-sweep.mjs`:

| Employer | Shape | Evidence | Shown? |
|---|---|---|---|
| Docker | `first.last` | 17 of 19 unique (89%) | yes |
| ZipRecruiter | `first` | 12 of 14 unique (86%) | yes |
| LawnStarter | `first.last` | 7 of 7 unique (100%) | yes |
| Jerry | none established | 60% of 5, under the floor | no |
| Arity, MoneyGram, BillingPlatform, Clarium, Lexipol | none established | no public repo exposes an address on the domain | no |

Jerry is the case that earns the floor. Without it the page would have shown
`menghan.li@getjerry.com` with no hedge, when their own evidence points at
`first`. That exact address is what the known-bad proof produces when the floor
is removed.

## Re-running it

```
node ingest/email-sweep.mjs --dry     # print what it would write
node ingest/email-sweep.mjs           # write the shapes into contacts.json
node ingest/test-email-pattern.mjs    # the module and its floors
node tests/outreach.mjs <url>         # the page, against a real build
```

The sweep re-checks itself after writing: it greps the file it just wrote for
anything address-shaped and exits non-zero if an individual address landed
there.

## Adding an employer

Add a key to `contacts.json` under `companies`, matching the employer name as
the jobs database spells it. Each person needs `name`, `title` **verbatim as the
source states it**, `source`, and `why`. Set `profile` only for a URL the person
published themselves; otherwise leave it `null` and the page builds a name
search. Then add the employer to `EMPLOYERS` in `ingest/email-sweep.mjs` and run
it, which fills in the address shape or records honestly that none could be
established.

A card with researched people is promoted past the per-group rank cut, because a
card with a person to write to is worth more than a card with four searches.
