# marketplace-eval

A measurement rig, not a product. It answers one question:

**Can current models reliably extract what a marketplace listing does not say?**

About 60 real listings get captured from Facebook Marketplace and Craigslist, run
through a six-stage pipeline, and scored on six separate capabilities. Each
capability has a numeric gate written in advance and a documented fallback if it
misses. The deliverable is a report telling you which features to build, which to
cut, and whether to aim at general consumer goods or a curated vertical.

**No model training anywhere.** Off-the-shelf Claude models plus retrieval plus
hand-authored taxonomy YAML. "Dev split" and "holdout split" refer to iterating on
prompts and taxonomy text, not to fitting weights — the holdout exists because a
human editing prompts against the same 30 listings overfits them just as reliably
as gradient descent would.

## Why

Four failure modes recur when buying used goods:

1. **Unstated identity.** "Home gym, barely used," no model. You can't tell a 3x3
   11-gauge rack from an 80s Weider without knowing what to look for in the photos.
2. **Unknown salience.** You don't know which attributes matter. A scientist
   pricing a used CO2 incubator may not know copper vs stainless chamber lining is
   decision-relevant — and the listing will never say. It's only visible in a photo.
3. **No access to owner knowledge.** Spec sheets say what a machine does when new,
   not which part cracks at year three or whether the pulleys are still made.
4. **No basis for negotiating.** No idea what it's worth, no comps at hand, no
   evidence to justify a lower offer. So you pay asking, or lowball blind and get
   ignored.

## Setup

```bash
npm install
npm run baseline     # measures CLI harness overhead — do this first
```

Runs on a **Claude Code subscription by default**, no API key needed. It drives the
authenticated `claude` CLI in print mode (`--output-format json`, `--json-schema`,
vision via the Read tool).

Two things about that backend, both handled but worth knowing:

- **Every call carries Claude Code's own system prompt** — measured at ~18.6k cached
  tokens on this machine. A two-word reply reports ~$0.003. `npm run baseline`
  measures it; the report subtracts it and shows raw vs adjusted vs API-equivalent
  side by side.
- **It's an agent loop, not one API call.** Reading an image takes several turns.
  Latency and token counts are *not* comparable to what a shipped extension would
  pay. Re-measure with `--backend=api` (needs `ANTHROPIC_API_KEY`) before trusting
  the cost gate.

## Verify it works

```bash
npm test              # 50 tests, no network
npm run smoke         # end-to-end vs the live CLI, ~30s
npm run smoke -- --full   # all six stages, ~5 min
```

`smoke` synthesizes a listing whose only image is a nameplate reading
`ACME / MODEL PX-1235`, then checks three things: ablation scrubs the model string
everywhere before any model call, the vision path can read small printed text, and
**T5 does not invent owner reports for a product that does not exist.** ACME PX-1235
has no web presence — findings for it would be pure fabrication, which is the
failure this whole harness exists to detect.

Last full-tier run: all eight stages, zero errors, model read `PX-1235` off the
nameplate at 0.78 confidence, T5 returned zero findings, T6 declined to price with
no comps. ~$0.60 API-equivalent per listing, ~5 min wall clock.

## Collect the dataset

The 60 listings are yours to capture — the extension runs in your own logged-in
browser session, which is the entire point of that approach.

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

## Run the eval

```bash
npm run eval -- --split=dev                 # iterate here
npm run eval -- --split=dev --ablations     # 13 configs
npm run eval -- --split=holdout             # ONCE, at the end
```

Throttled and checkpointed: subscription limits are built for interactive use, and
every completed listing is written to disk so a rerun resumes rather than restarting.

## What's being tested

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

## Guardrails that are mechanical, not judged

Enforced in code so the metrics mean something:

- **Ablation verification.** Every model string, plus alias variants and bare brand
  tokens, scrubbed from title, description, rendered text, JSON-LD, *and image
  filenames* — then asserted clean. Any leak throws `AblationLeakError` instead of
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
- **Different judge model.** T5 attribution support is judged by a different model
  than generated the claim, because a self-judging scorer rubber-stamps itself. The
  quote-match layer underneath it is purely mechanical (fetch URL, substring match)
  and is the one to trust more.
- **Run health.** A run where every extraction errored says so at the top of the
  report instead of rendering a tidy table of "no data" gates.

## The number that decides the product

`co2_incubator` deliberately has **no taxonomy file**, and must not get one.

- **Zero-shot gap within 15 points** of the seeded average → the engine
  generalizes; "general consumer goods" is viable.
- **Larger gap** → the taxonomy files are doing the work, and this is a
  hand-curation business. Pivot to curated verticals, likely lab equipment, where
  willingness to pay is higher anyway.

Writing an incubator taxonomy to improve the numbers destroys the only experiment
that answers the product question.

## Data boundary

```
data/listings/     LOCAL ONLY, gitignored, never pushed
data/manifest.json committed — URLs, timestamps, hashes. No pixels
data/labels/       committed — hand labels, the expensive part
```

```bash
npm run check:data-boundary   # run before the first push
```

Snapshots contain other people's listing photos and descriptions: faces, house
interiors, enough detail to locate a seller. Pushing them anywhere — including a
private repo — puts scraped marketplace content on a third-party server, and git
history makes that hard to undo.

Which makes the dataset **irreplaceable and unbacked by design**: listings vanish
within days, so a snapshot you lose is gone permanently. Keep a Time Machine or
external-drive backup. Not cloud sync.

## Layout

```
src/schema/          zod schemas — Attribute carries provenance
src/taxonomy/data/   per-category YAML (data, not code)
src/capture/         snapshot store + ablation utilities
src/extractor/       the pipeline; same code an extension would ship
  client/            CliClient (subscription) | ApiClient (metered)
  stages/            T1-T6
  prompts.ts         all prompt text, one reviewable file
src/eval/            runner, scorers, report, sink, smoke test
ext/                 MV3 capture extension (~150 lines, no product logic)
```

The extension is deliberately almost selector-free. Craigslist never remodels
(stable ids like `#titletextonly`); Facebook Marketplace generates class names fresh
every deploy (`x1i10hfl x1qjc9v5 …`), so selector-based adapters rot in weeks.
Instead it dumps rendered text, JSON-LD, and every plausible gallery image and lets
the extractor structure it — per-site code shrinks to roughly one selector, and it
fails gracefully (a bit less text) instead of silently (wrong field).

## T5 retrieval and quote verification

Retrieval is plain web search with `site:` filters seeded from each taxonomy's
`communities` list. That finds Reddit content fine.

**Verification is where it gets subtle.** The attribution scorer fetches each cited
URL and substring-matches the verbatim quote. Measured on a live comment thread:

| URL | HTTP | Usable text |
|---|---|---|
| `www.reddit.com/.../comments/...` | 200 | **37 chars** (JS shell) |
| `old.reddit.com/.../comments/...` | 200 | **~48,000 chars** |
| `www.reddit.com/....json` (no auth) | 403 | — |

Both HTML cases return 200, so a naive fetcher reports success and then fails every
quote match against nothing. That would read as "the model fabricates citations"
when the real problem is a blind verifier. Two guards, both tested:

- `verifiableUrl()` rewrites `reddit.com` → `old.reddit.com`, which serves static HTML.
- A 200 with under 500 usable characters counts as a **fetch failure** (reported
  separately, excluded from the denominator), not as a missing quote. Entities are
  fully decoded, including numeric ones like `&#32;`, since a raw entity in the
  stripped text causes the same spurious mismatch.

`redditApiFetcher()` is an optional upgrade: set `REDDIT_CLIENT_ID` and
`REDDIT_CLIENT_SECRET` (a "script" app at `reddit.com/prefs/apps`) and it pulls clean
comment bodies via OAuth, falling back to the default fetcher on any failure. Not the
default, because the default needs no credentials and was measured working. Worth
switching to for durability, since `old.reddit.com` is not guaranteed permanent.

## Deliberately out of scope

Comparison UI, live TCA calculators (U-Haul rates, freight quotes), the passive
corpus store and its dedup/retrieval logic, any server component. T6's comps and
logistics costs are hand-supplied per listing via `data/labels/`, which is what lets
T6 be evaluated before the corpus exists.

One constraint to design around from the start: keep the corpus local-first, limited
to pages the user actually visited, with no automated search querying and no
server-side aggregation. That is what makes passive indexing defensible under
marketplace ToS, and it is also cheaper. Worth a lawyer's read before the corpus
ships. T5's forum retrieval is a separate question: API *access* is permitted, while
*grounding a commercial product* on the content is licensed separately — an issue for
productization, not for running the eval.
