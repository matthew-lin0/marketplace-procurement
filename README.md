# marketplace-procurement

A browser extension that tells you what a used-goods listing does not say.

Point it at a Facebook Marketplace or Craigslist listing and it works out what the
thing actually is from the photos, recovers specs the seller never mentioned,
spots accessories visible in frame but absent from the text, surfaces what
long-term owners complain about, and assembles a negotiating position with the
evidence attached.

**No model training anywhere.** Off-the-shelf Claude models plus retrieval plus
hand-authored taxonomy YAML. Where this repo says "dev split" and "holdout split"
it means iterating on prompts and taxonomy text, not fitting weights. The holdout
exists because a human editing prompts against the same 30 listings overfits them
just as reliably as gradient descent would.

## Why

Four failure modes recur when buying used goods:

1. **Unstated identity.** "Home gym, barely used," no model. You can't tell a 3x3
   11-gauge rack from an 80s Weider without knowing what to look for in the photos.
2. **Unknown salience.** You don't know which attributes matter. A scientist
   pricing a used CO2 incubator may not know copper vs stainless chamber lining is
   decision-relevant, and the listing will never say. It's only visible in a photo.
3. **No access to owner knowledge.** Spec sheets say what a machine does when new,
   not which part cracks at year three or whether the pulleys are still made.
4. **No basis for negotiating.** No idea what it's worth, no comps at hand, no
   evidence to justify a lower offer. So you pay asking, or lowball blind and get
   ignored.

## Status

| Piece | State |
|---|---|
| Extraction pipeline, T1-T6 | Built. 50 tests passing, typecheck clean |
| Guardrails (ablation, evidence, abstention) | Built, enforced in code |
| Capture extension | Capture only. No extraction call, no results UI |
| Eval harness (gates, scorers, report) | Built |
| Test corpus | **Empty. 0 of ~60 listings captured** |
| Shipping runtime | Not started. See [What shipping needs](#what-shipping-needs) |

The extraction core is written to ship, not to be rewritten later: `src/extractor/`
has no code dependency on `src/eval/`, so it lifts into the extension unchanged.
Everything blocking a usable tool is I/O and surface, listed below.

## What it does

| # | Capability | Fallback if it fails |
|---|---|---|
| T1 | Identify brand + model + generation from photos | Family-level ID plus seller questions |
| T2 | Recover unstated attributes (the copper-lining case) | Generate the question to ask the seller |
| T3 | Detect unmentioned inclusions (the dumbbells case) | None. If this fails the feature dies |
| T4 | Rank attribute salience | Hand-curate per category |
| T5 | Retrieve used-buying intelligence from forums | Show the spec sheet only |
| T6 | Assemble a negotiation position | Show comps and let the user reason |

**T1 is the bottleneck, and every downstream stage makes a wrong ID more expensive
rather than less.** Sentiment retrieved for a misidentified model launders the error
inside credible-looking owner testimony; a negotiation brief built on it sends the
buyer to a seller with confidently wrong comps. So T5 and T6 hard-refuse below the
T1 confidence threshold, and both carry the ID they're conditioned on so the user
can reject the premise.

Two tiers: `claude-haiku-4-5` triages every listing browsed, `claude-opus-5` runs
the full pipeline only on explicit compare. Thresholds live in `src/config.ts`.

## What shipping needs

The extractor currently runs under Node and drives the authenticated `claude` CLI.
An extension cannot spawn a process, so five things change:

1. **Model access.** `cliClient.ts:174` spawns `claude`. The ship path is
   `apiClient.ts` plus somewhere to hold a key: a local companion server or a
   hosted proxy. This is a cost decision as much as a technical one, since every
   call today rides a Claude Code subscription rather than metered tokens.
2. **Taxonomy bundling.** `taxonomy/index.ts:25` reads YAML off disk. Bundle it at
   build time instead.
3. **Sentiment cache.** `sentiment.ts:133` caches to the filesystem. Move to
   `chrome.storage` or IndexedDB.
4. **Images.** `apiClient.ts:35` reads image files from disk. In the extension they
   come from the page.
5. **Results UI.** `ext/` is a capture popup and nothing else today.

**T6 is blocked on more than plumbing.** Comps and logistics costs are hand-supplied
per listing via `data/labels/`, which is exactly what lets T6 be scored before a
corpus exists. A shipped tool has nobody to hand-supply them. T1 through T5 can ship
on the current architecture; T6 needs the passive corpus store, which is the
largest single unbuilt piece.

Also deferred, and fine to defer: comparison UI, live TCA calculators (U-Haul rates,
freight quotes).

## How we know it works

The eval harness is the test apparatus for the extension, not a separate project.
About 60 real listings get captured, run through the pipeline, and scored on six
capabilities. Every gate is written in `src/config.ts` in advance, before seeing
results, which is what makes the numbers capable of saying "don't ship this stage."

```bash
npm test                    # 50 tests, no network
npm run smoke               # end-to-end vs the live CLI, ~30s
npm run smoke -- --full     # all six stages, ~5 min
npm run eval -- --split=dev                 # iterate here
npm run eval -- --split=dev --ablations     # 13 configs
npm run eval -- --split=holdout             # ONCE, at the end
```

`smoke` synthesizes a listing whose only image is a nameplate reading
`ACME / MODEL PX-1235`, then checks three things: ablation scrubs the model string
everywhere before any model call, the vision path can read small printed text, and
**T5 does not invent owner reports for a product that does not exist.** ACME PX-1235
has no web presence, so findings for it would be pure fabrication, which is the
failure this harness exists to catch.

Last full-tier run: all six stages, zero errors, model read `PX-1235` off the
nameplate at 0.78 confidence, T5 returned zero findings, T6 declined to price with
no comps. ~$0.60 API-equivalent per listing, ~5 min wall clock.

The eval runner is throttled and checkpointed, because subscription limits are built
for interactive use and every completed listing is written to disk so a rerun
resumes rather than restarting.

### Guardrails that are mechanical, not judged

These are product safety rails first and scoring aids second. Enforced in code:

- **Ablation verification.** Every model string, plus alias variants and bare brand
  tokens, scrubbed from title, description, rendered text, JSON-LD, *and image
  filenames*, then asserted clean. Any leak throws `AblationLeakError` instead of
  silently scoring an open-book test.
- **Evidence requirements.** A `photo_inference` claim with no `imageIndex` is
  dropped. A `spec_lookup` claim with no URL is dropped. An inclusion citing an
  image that doesn't exist is dropped.
- **Lever grounding.** Every T6 lever must resolve to a real T2/T3/T5 finding id, so
  grounding is checked mechanically rather than judged. Should be 100% by
  construction; anything less means the validator is broken.
- **T6 abstention.** Fewer than 3 comps forces `insufficient_data` with no point
  estimate, in code, regardless of what the model returns.
- **Signed fair-value error.** Bias reported separately from spread. Over-estimating
  fair value costs the buyer money; under-estimating just costs them a deal. A
  consistent high skew fails the gate even when absolute error looks fine.
- **Different judge model.** T5 attribution support is judged by `claude-sonnet-5`,
  not the model that generated the claim, because a self-judging scorer
  rubber-stamps itself. The quote-match layer underneath it is purely mechanical
  (fetch URL, substring match) and is the one to trust more.
- **Run health.** A run where every extraction errored says so at the top of the
  report instead of rendering a tidy table of "no data" gates.

### Collecting the test corpus

The listings are yours to capture: the extension runs in your own logged-in browser
session, which is the entire point of that approach.

```bash
npm run sink                        # local receiver on :7331
# load ./ext unpacked at chrome://extensions (developer mode)
# browse a listing, click the extension button, pick a category
```

**Fill in "stated model" whenever the listing says one.** That makes the listing
self-labeling: the string gets scrubbed from every field before the model sees
anything, then scored against. Free ground truth at whatever scale you capture.

Target ~10 per category, roughly 60/40 model-stated to model-less.

| Category | Split | What it stresses |
|---|---|---|
| Home gym racks | dev | Low brand legibility, bundled plates, logistics. The origin case |
| Bicycles | dev | High brand legibility, groupset tier drives most of the value |
| Cordless power tools | dev | Battery platform is the hidden decision factor |
| Sofas | holdout | Logistics and condition dominant, near-zero brand legibility |
| Laptops | holdout | Text-rich, specs often stated. Easy-mode control |
| **CO2 incubators** | holdout | **Zero-shot: no taxonomy file. The general-vs-vertical answer** |

### The number that decides how far this generalizes

`co2_incubator` deliberately has **no taxonomy file**, and must not get one.

- **Zero-shot gap within 15 points** of the seeded average, and the engine
  generalizes: the extension can target general consumer goods.
- **Larger gap**, and the taxonomy files are doing the work. That makes this a
  hand-curation business, so ship into curated verticals instead, likely lab
  equipment, where willingness to pay is higher anyway.

Writing an incubator taxonomy to improve the numbers destroys the only experiment
that answers this.

## Setup

```bash
npm install
npm run baseline     # measures CLI harness overhead, do this first
```

Development runs on a **Claude Code subscription by default**, no API key needed. It
drives the authenticated `claude` CLI in print mode (`--output-format json`,
`--json-schema`, vision via the Read tool). Two things about that backend, both
handled but worth knowing:

- **Every call carries Claude Code's own system prompt**, measured at ~18.6k cached
  tokens on this machine. A two-word reply reports ~$0.003. `npm run baseline`
  measures it; the report subtracts it and shows raw vs adjusted vs API-equivalent
  side by side.
- **It's an agent loop, not one API call.** Reading an image takes several turns.
  Latency and token counts are *not* comparable to what the shipped extension will
  pay. Re-measure with `--backend=api` (needs `ANTHROPIC_API_KEY`) before trusting
  any cost figure. The committed baseline was measured against `claude-haiku-4-5`,
  the triage model, not the full tier.

## Data boundary

```
data/listings/     LOCAL ONLY, gitignored, never pushed
data/manifest.json committed. URLs, timestamps, hashes. No pixels
data/labels/       committed. Hand labels, the expensive part
```

```bash
npm run check:data-boundary   # run before every push
```

Snapshots contain other people's listing photos and descriptions: faces, house
interiors, enough detail to locate a seller. Pushing them anywhere, including a
private repo, puts scraped marketplace content on a third-party server, and git
history makes that hard to undo.

Which makes the corpus **irreplaceable and unbacked by design**: listings vanish
within days, so a snapshot you lose is gone permanently. Keep a Time Machine or
external-drive backup. Not cloud sync.

## T5 retrieval and quote verification

Retrieval is plain web search with `site:` filters seeded from each taxonomy's
`communities` list. That finds Reddit content fine.

**Verification is where it gets subtle.** The attribution scorer fetches each cited
URL and substring-matches the verbatim quote. Measured on a live comment thread:

| URL | HTTP | Usable text |
|---|---|---|
| `www.reddit.com/.../comments/...` | 200 | **37 chars** (JS shell) |
| `old.reddit.com/.../comments/...` | 200 | **~48,000 chars** |
| `www.reddit.com/....json` (no auth) | 403 | |

Both HTML cases return 200, so a naive fetcher reports success and then fails every
quote match against nothing. That would read as "the model fabricates citations"
when the real problem is a blind verifier. Two guards, both tested:

- `verifiableUrl()` rewrites `reddit.com` to `old.reddit.com`, which serves static HTML.
- A 200 with under 500 usable characters counts as a **fetch failure** (reported
  separately, excluded from the denominator), not as a missing quote. Entities are
  fully decoded, including numeric ones like `&#32;`, since a raw entity in the
  stripped text causes the same spurious mismatch.

`redditApiFetcher()` is an optional upgrade: set `REDDIT_CLIENT_ID` and
`REDDIT_CLIENT_SECRET` (a "script" app at `reddit.com/prefs/apps`) and it pulls clean
comment bodies via OAuth, falling back to the default fetcher on any failure. Not the
default, because the default needs no credentials and was measured working. Worth
switching to for durability, since `old.reddit.com` is not guaranteed permanent.

## Legal constraints to design around

Two separate questions, both worth a lawyer's read before the extension ships
publicly:

- **The passive corpus.** Keep it local-first, limited to pages the user actually
  visited, with no automated search querying and no server-side aggregation. That is
  what makes passive indexing defensible under marketplace ToS, and it is also
  cheaper.
- **T5 forum content.** API *access* is permitted, while *grounding a commercial
  product* on the content is licensed separately. Not an issue for running the eval;
  it is an issue for shipping.

## Layout

```
src/schema/          zod schemas. Attribute carries provenance
src/taxonomy/data/   per-category YAML (data, not code)
src/capture/         snapshot store + ablation utilities
src/extractor/       the pipeline. Ships into the extension unchanged
  client/            CliClient (subscription) | ApiClient (metered)
  stages/            T1-T6
  prompts.ts         all prompt text, one reviewable file
src/eval/            runner, scorers, report, sink, smoke test
ext/                 MV3 extension. Capture only today
```

The extension is deliberately almost selector-free. Craigslist never remodels
(stable ids like `#titletextonly`); Facebook Marketplace generates class names fresh
every deploy (`x1i10hfl x1qjc9v5 …`), so selector-based adapters rot in weeks.
Instead it dumps rendered text, JSON-LD, and every plausible gallery image and lets
the extractor structure it. Per-site code shrinks to roughly one selector, and it
fails gracefully (a bit less text) instead of silently (wrong field).
