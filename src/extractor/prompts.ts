import type { CategoryTaxonomy, ListingSnapshot } from '../schema/index.js';
import { renderTaxonomyForPrompt } from '../taxonomy/index.js';

/**
 * All prompt text lives here so a prompt change is a reviewable diff in one
 * file, and so the ablation switches (with/without visual tells, text-only,
 * images-only) are visible side by side.
 */

export const SYSTEM_APPRAISER = `You are an experienced appraiser of used goods, working for the BUYER.

Your job is to tell the buyer what a listing does not say. You care about two
failure modes above all others:

1. Confidently stating something you cannot actually determine. A wrong spec is
   worse than a blank field, because the buyer will act on it.
2. Missing something that is plainly visible in a photo.

Rules you always follow:
- Abstaining is a valid, valued answer. "I cannot determine this from these
  photos" is a useful output, not a failure.
- Every claim about a physical attribute must be traceable to a specific image
  or a specific quote. If you cannot point at evidence, do not make the claim.
- Calibrate confidence honestly. A confidence of 0.9 means you would be right
  nine times out of ten on listings like this one.`;

export function listingContext(
  snapshot: ListingSnapshot,
  opts: { includeText: boolean } = { includeText: true },
): string {
  if (!opts.includeText) {
    return `<listing>\nCategory: ${snapshot.category}\nAsking price: ${
      snapshot.priceUsd !== null ? `$${snapshot.priceUsd}` : 'not stated'
    }\n(Listing text withheld for this run — rely on the images.)\n</listing>`;
  }

  return `<listing>
Category: ${snapshot.category}
Marketplace: ${snapshot.marketplace}
Asking price: ${snapshot.priceUsd !== null ? `$${snapshot.priceUsd}` : 'not stated'}
Location: ${snapshot.locationText ?? 'not stated'}

Title: ${snapshot.title}

Description:
${snapshot.description}
</listing>`;
}

// --- T1: identify ----------------------------------------------------------

export function identifyPrompt(
  snapshot: ListingSnapshot,
  taxonomy: CategoryTaxonomy | null,
  opts: { includeText: boolean; includeVisualTells: boolean },
): string {
  const tax = renderTaxonomyForPrompt(taxonomy, {
    includeVisualTells: opts.includeVisualTells,
  });

  return `${listingContext(snapshot, opts)}

${tax ? `${tax}\n` : ''}
Identify the brand, model, and generation of the primary item in this listing.

Some of the listing text may have been redacted and replaced with [REDACTED].
Do not try to infer what was redacted from surrounding context — work from the
images and the remaining text.

How to work:
1. Look for a nameplate, badge, serial plate, or silkscreened model number in
   the photos. Model numbers are physically printed on most equipment; they are
   usually just small. Check the places they are conventionally placed for this
   kind of item.
2. If no printed identifier is legible, identify distinguishing design features
   and match them to a product line.
3. If you can only get to a family ("a Rogue-style 3x3 power rack") rather than
   an exact model, say so in the family field and abstain on the exact model.

Set abstained=true when you cannot name a specific model with real confidence.
An honest abstention is worth more than a plausible guess: a wrong model
identification poisons every downstream step, because specs and owner reports
retrieved for the wrong model look credible while being irrelevant.

Report confidence as your honest probability that the exact model is correct.`;
}

// --- Crop-and-zoom ---------------------------------------------------------

export function nameplateLocatePrompt(snapshot: ListingSnapshot): string {
  return `${listingContext(snapshot)}

Find the regions of these images most likely to contain a printed identifier:
a nameplate, model badge, serial plate, silkscreened model number, spec sticker,
or manufacturer logo with a model line.

For each candidate, give the image index and a normalized bounding box
[x0, y0, x1, y1] where 0,0 is the top-left corner and 1,1 is the bottom-right.
Pad the box slightly beyond the text so nothing is cut off.

Prefer a few high-value regions over many speculative ones. If no image plausibly
contains printed text, return an empty list.`;
}

// --- T2: attributes --------------------------------------------------------

export function specLookupPrompt(
  brand: string,
  model: string,
  generation: string | null,
  taxonomy: CategoryTaxonomy | null,
): string {
  const keys = taxonomy?.attributes.map((a) => a.key).join(', ') ?? '(no taxonomy for this category — decide which attributes matter)';

  return `Look up the manufacturer specifications for:
  Brand: ${brand}
  Model: ${model}
  Generation: ${generation ?? 'unspecified'}

Find the attributes that matter for a used-purchase decision. For this category
those are: ${keys}

Search for a manufacturer spec sheet or an authoritative product page. For each
attribute you find:
- Record the value exactly as the source states it.
- Set source to "spec_lookup" and put the source URL in evidence.url.
- Put the sentence you took it from in evidence.quote, verbatim.

If you cannot find an authoritative source for an attribute, omit it rather than
filling it in from memory. Only mark an attribute source as "model_prior" if you
are stating it from your own knowledge with no source — and prefer omitting it.

For anything you could not determine, add a question to questionsForSeller,
phrased so the buyer can paste it directly into a message.`;
}

export function visualAttributePrompt(
  snapshot: ListingSnapshot,
  taxonomy: CategoryTaxonomy | null,
  opts: { includeVisualTells: boolean },
): string {
  const tax = renderTaxonomyForPrompt(taxonomy, {
    includeVisualTells: opts.includeVisualTells,
  });

  return `${listingContext(snapshot)}

${tax ? `${tax}\n` : ''}
Determine what you can about this item's decision-relevant attributes from the
photos, and generate seller questions for what you cannot.

For each attribute you report:
- source must be "photo_inference" when you read it off an image, and
  evidence.imageIndex must name the image. A claim with no image cited will be
  discarded.
- source must be "listing_text" when the listing states it, with the sentence in
  evidence.quote.
- Do not report an attribute you are inferring from the product category in
  general rather than from this specific item.

Attributes you cannot determine are not failures — put a specific, answerable
question in questionsForSeller for each one. Phrase questions so the buyer can
paste them directly into a message to the seller.`;
}

// --- T3: inclusions --------------------------------------------------------

export function inclusionsPrompt(snapshot: ListingSnapshot): string {
  return `${listingContext(snapshot)}

Examine every photo and catalogue two things:

1. ITEMS that appear to be part of the sale but are not mentioned in the listing
   text. Bundled accessories, extra parts, additional equipment in frame. These
   are frequently worth more than the seller's discount, and sellers routinely
   forget to mention them.
2. CONDITION issues visible in the photos: damage, wear, rust, tears, missing
   parts, aftermarket modifications.

Look at the whole frame, not just the subject. Check the background, the floor,
and the edges of each photo.

For each finding:
- imageIndex is required. It must be the index of the image where you can
  actually see this. A finding without a valid image index will be discarded.
- Set mentionedInText=true if the listing text refers to it, false if the text
  is silent. The unmentioned ones are the valuable ones.
- Estimate a used dollar value where you reasonably can, otherwise null.

Do not list the primary item itself. Do not list things you assume are included
by convention — only what you can see.`;
}

// --- T4: salience ----------------------------------------------------------

export function saliencePrompt(
  snapshot: ListingSnapshot,
  taxonomy: CategoryTaxonomy | null,
  attributeKeys: string[],
): string {
  const tax = renderTaxonomyForPrompt(taxonomy);
  return `${listingContext(snapshot)}

${tax ? `${tax}\n` : ''}
Available attribute keys: ${attributeKeys.join(', ') || '(none extracted)'}

Rank the attributes by how much they should influence THIS buyer's decision on
THIS listing, most important first. Consider the asking price, the condition,
and what is already known versus still unknown.

An attribute that is already settled matters less than one that is unknown and
could swing the decision. Return only keys, in rank order, plus a brief
rationale for the ordering.`;
}

// --- T5: sentiment ---------------------------------------------------------

export function sentimentPrompt(
  brand: string,
  model: string,
  generation: string | null,
  communities: string[],
): string {
  const siteFilters = communities.length
    ? communities.map((c) => `site:${c}`).join(' OR ')
    : '(no seeded communities for this category — search broadly)';

  return `Research what owners actually say about:
  Brand: ${brand}
  Model: ${model}
  Generation: ${generation ?? 'unspecified'}

Search these communities first: ${siteFilters}
Then search more broadly if needed.

You are researching a USED purchase, not a retail one. Retail reviews are close
to useless here. What matters is:
- What wears out or breaks, and at roughly what age or mileage
- What to inspect before handing over money
- Whether parts are still available, and what replacements cost
- Which generation had a known problem
- Anything an owner wishes they had known before buying

Rules that determine whether a finding is usable:
1. Every citation needs a VERBATIM quote from the page, copied exactly. Do not
   paraphrase, tighten, or clean up the quote. A finding whose quote cannot be
   found at its URL will be discarded.
2. Do not turn "mine squeaked once" into "known bearing defect." Represent the
   strength of the claim as the source actually states it, and set
   consensusStrength accordingly: single_report, several, or widespread.
3. appliesToGeneration is required. Advice about a 2014 unit routinely does not
   apply to the 2023 revision, and forum threads rarely date themselves clearly.
   If you cannot establish which generation a report refers to, write "unknown"
   — do not guess.
4. Prefer findings that change a pre-purchase decision. General praise is
   permitted but should be the exception, not the bulk of your output.

Set conditionedOnModel to the exact brand and model you researched, so the buyer
can reject the premise if the identification was wrong.`;
}

// --- T5 judge --------------------------------------------------------------

export function attributionJudgePrompt(
  claim: string,
  quote: string,
  pageText: string,
): string {
  return `A research tool made this claim about a used product:

CLAIM: ${claim}

It cited this quote as support:

QUOTE: ${quote}

Here is the text of the cited page:

<page>
${pageText.slice(0, 20_000)}
</page>

Answer two questions:
1. Does the quote actually appear on the page? Allow for whitespace and
   punctuation differences only.
2. Does the quote actually support the claim as stated? A quote saying one
   person's unit squeaked does NOT support a claim of a known defect. A quote
   about a different generation does NOT support a claim about this one.

Be skeptical. You are the check on a system that has an incentive to sound
authoritative. Err toward "not supported" when the connection requires
interpretation.`;
}

// --- T6: negotiation -------------------------------------------------------

export function msrpLookupPrompt(brand: string, model: string, generation: string | null): string {
  return `Look up the CURRENT retail/MSRP price for a new unit of:
  Brand: ${brand}
  Model: ${model}
  Generation: ${generation ?? 'unspecified'}

Search for the manufacturer's own product page, or a current major retailer
selling this as new. Only report a price if you find one from a source you can
cite.

Set found=true and fill in msrpUsd, url, and asOf (the year or date the price
was observed) only if you found a real current price with a real source. If you
cannot find this specific model being sold new today — discontinued, wrong
generation, or no source at all — set found=false and leave the other fields
null. Do not estimate or recall a price from memory: an unsourced number here
is worse than none, because it becomes an anchor for a real negotiation.`;
}

export function negotiationPrompt(
  snapshot: ListingSnapshot,
  compsBlock: string,
  findingsBlock: string,
  costsBlock: string,
  timingBlock: string,
  msrpBlock: string,
): string {
  return `${listingContext(snapshot)}

${compsBlock}

${findingsBlock}

${costsBlock}

${timingBlock}

${msrpBlock}

Assemble a negotiation position for the BUYER. This is evidence assembly, not
persuasion coaching. The buyer will be talking to a seller who may know this
market better than they do, so everything you produce must be something they can
stand behind if challenged.

Fair value:
- Prefer eBay sold prices when provided; those are real transactions. Set
  basis="ebay_sold".
- Asking-price comps are biased HIGH, twice over: asking prices sit above
  transaction prices, and stale listings are stale precisely because they are
  overpriced. If you only have asking comps, set basis="corpus_asking" and be
  conservative.
- If you have fewer than 3 valid comps AND a retail/MSRP price is provided
  above, you may estimate from that retail price depreciated for the condition
  shown in the findings above. Set basis="msrp_depreciated". This method has NO
  market signal at all — it does not know what buyers actually pay for a used
  one, only what a new one costs and what looks wrong in photos. Reflect that
  with a WIDE low/high range, not a tight one, and weight your point estimate
  well below MSRP: for mass-market goods, age, obsolescence, and demand erode
  used value far more than visible damage does, and none of that is visible in
  a photo. A confident-looking narrow range here would be worse than
  insufficient_data.
- If you have fewer than 3 valid comps and no retail price is available either,
  set basis="insufficient_data" and leave low/point/high null. Refusing to
  produce a number is a valid and often correct answer. Do not manufacture a
  range from thin data.

Levers:
- Every lever MUST reference a real finding id from the findings above via
  sourceFindingId. A lever you cannot trace to a finding will be discarded
  automatically.
- Do not invent leverage. Do not suggest claiming things that are not true, and
  do not script social tactics ("tell them you have cash today"). A seller who
  catches one fabricated claim ends the conversation.

Walk-away: fair value low, minus refurb cost, minus logistics cost.

Seller motivation: use only the timing data provided. Do not speculate about the
seller's circumstances.

Unknowns: what should the buyer resolve BEFORE making an offer at all?`;
}
