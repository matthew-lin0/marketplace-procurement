import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(here, '..');
export const DATA_DIR = path.join(REPO_ROOT, 'data');
export const LISTINGS_DIR = path.join(DATA_DIR, 'listings');
export const LABELS_DIR = path.join(DATA_DIR, 'labels');
export const REPORTS_DIR = path.join(DATA_DIR, 'reports');
export const RUNS_DIR = path.join(DATA_DIR, 'runs');
export const MANIFEST_PATH = path.join(DATA_DIR, 'manifest.json');
export const TAXONOMY_DIR = path.join(here, 'taxonomy', 'data');

export const SINK_PORT = 7331;

/**
 * Every decision threshold, in one place, written before we see any results.
 * The gates are the deliverable — this file is what makes the eval capable of
 * telling us not to build the product.
 */
export const GATES = {
  /** T1: precision within the high-confidence tier, at its coverage level. */
  t1ConfidentPrecision: 0.9,
  t1MinCoverage: 0.4,
  /** T2: claims contradicted by the true spec sheet. The kill metric. */
  t2MaxFabricationRate: 0.05,
  /** T3: inclusions visible in photos but absent from text. */
  t3MinRecall: 0.7,
  t3MinPrecision: 0.8,
  /** T5: mechanical quote match, then judged support. */
  t5MinQuoteMatch: 0.95,
  t5MinJudgedSupport: 0.9,
  t5MinActionableFraction: 0.5,
  /** T6: a fabricated comp is the failure most likely to embarrass a user in
   *  front of a seller who knows the market. Zero tolerance. */
  t6MaxFabricatedCompRate: 0,
  /** Signed, not absolute. Over-estimating fair value costs the user money;
   *  under-estimating just costs them a deal. Skew high fails even when the
   *  absolute error looks acceptable. */
  t6MaxFairValueBiasAbs: 0.1,
  /** The most decision-relevant number in the exercise: the difference
   *  between a general tool and a hand-curation business. */
  zeroShotMaxGapPoints: 15,
} as const;

/** Confidence at or above this counts as the "confident tier" for T1, and is
 *  the gate for running T5 and T6 at all. */
export const CONFIDENT_TIER_THRESHOLD = 0.75;

/** Fewer than this many real comps means T6 says `insufficient_data` and
 *  produces no point estimate. Refusing to produce a number is valid, and
 *  often correct. */
export const MIN_COMPS = 3;

/** A comp further away than this is not a comp for something that needs a
 *  U-Haul. Applied only when both comp and listing have a distance. */
export const MAX_COMP_DISTANCE_MILES = 150;

export const MODELS = {
  /** Runs on every listing browsed during passive indexing, so it has to be
   *  cheap. */
  triage: 'claude-haiku-4-5',
  /** Runs only on explicit compare. */
  full: 'claude-opus-5',
  /** Judges T5 attribution support. Deliberately a different model from the
   *  one that generated the claim — a scorer that judges support with the
   *  same model will happily rubber-stamp itself. */
  judge: 'claude-sonnet-5',
} as const;

/** Subscription-backed CLI runs share interactive rate limits, so the runner
 *  throttles and checkpoints rather than hammering. */
export const RUNNER = {
  concurrency: 2,
  delayBetweenCallsMs: 1_000,
  maxRetries: 3,
  retryBaseDelayMs: 5_000,
} as const;
