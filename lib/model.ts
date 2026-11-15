// Launch Radar model: one sealed snapshot in, one ranked board out.
//
// The board ranks protocols that record no token yet by what a launch would be worth if the
// protocol's record stayed as it is. Every figure comes from the snapshot itself:
//
//   peers      tokenised protocols (a market cap and a TVL on record) set the price of TVL:
//              ratio = mcap_usd / tvl_usd. A category's multiple is the median ratio of its
//              tokenised members, shrunk toward the global median by the member count, so a
//              category with two wild members cannot price a launch on its own:
//                multiple_c = (n_c * median_c + K * median_all) / (n_c + K),  K = 6
//              clamped to [0.02, 3.0]. A category with no tokenised member uses median_all.
//   implied    = tvl_usd * multiple_c * growth * maturity * breadth, whole dollars
//   growth     = 1 + clamp(change_7d, -50, 100) / 100 * 0.35   (no reported change: 1)
//   maturity   = 0.70 + 0.30 * min(age_days, 1095) / 1095      (age unknown: 365 days)
//   breadth    = 1 + 0.03 * min(chains - 1, 5)
//
// Age is the days between the snapshot's as_of and the day DefiLlama first tracked the protocol:
// the record of how long it has run with no token. No protocol name is ever special-cased; one
// function scores every row, and the same function is printed in the dashboard.
//
// The board covers the snapshot's whole watchlist (the floor) and adds early rows: pre-token
// protocols below the floor that pass the same screen the house applies at the floor (no bridge,
// staking-product or exchange categories, no versioned names, no wrapped/staked product names,
// no exchange-prefixed names). Tokenised protocols are never ranked; the dashboard sets them
// aside with the market caps the snapshot records.

/** The snapshot's protocol entry: exactly the ten fields the sealed input carries. */
export interface SnapshotProtocol {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
}

/** The whole snapshot document. */
export interface Snapshot {
  as_of: string;
  source: string;
  floor_usd: number;
  protocols: SnapshotProtocol[];
  watchlist: string[];
}

/** The model's constants, printed in the dashboard so a reader can recompute any row. */
export interface ModelConstants {
  shrink_k: number;
  multiple_min: number;
  multiple_max: number;
  growth_weight: number;
  growth_floor: number;
  growth_cap: number;
  maturity_floor: number;
  maturity_range: number;
  maturity_days: number;
  unknown_age_days: number;
  breadth_per_chain: number;
  breadth_max_extra: number;
}

export const MODEL: ModelConstants = {
  shrink_k: 6,
  multiple_min: 0.02,
  multiple_max: 3,
  growth_weight: 0.35,
  growth_floor: -50,
  growth_cap: 100,
  maturity_floor: 0.7,
  maturity_range: 0.3,
  maturity_days: 1095,
  unknown_age_days: 365,
  breadth_per_chain: 0.03,
  breadth_max_extra: 5,
};

/** The model's version label: the dashboard names it and the board carries it. */
export const MODEL_VERSION = 'radar-2';

/** The most rows the board carries: the whole watchlist, then the strongest early rows. */
export const BOARD_CAP = 300;

/** How many live-token protocols the dashboard's Live view carries, by market cap. */
export const LIVE_ROWS = 24;

/** One category's peer evidence: how many tokenised members priced it, and the multiple used. */
export interface CategoryMultiple {
  category: string;
  peers: number;
  median: number;
  multiple: number;
}

/** One row of board.json: the ranked board's row. */
export interface BoardRow {
  rank: number;
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
  token_status: 'pre-token';
  on_watchlist: boolean;
  age_days: number | null;
  implied_value_usd: number;
  score: number;
  band: string;
  evidence: string;
  model: {
    category_multiple: number;
    category_peers: number;
    growth_pct: number;
    growth_multiplier: number;
    maturity_multiplier: number;
    breadth_multiplier: number;
    age_days: number | null;
  };
  farm_steps: string[];
}

/** The dashboard's view of one board row: the same figures, the same plan, the same evidence. */
export interface RadarRow {
  rank: number;
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  listed_at: string | null;
  age_days: number | null;
  on_watchlist: boolean;
  category_multiple: number;
  growth_multiplier: number;
  maturity_multiplier: number;
  breadth_multiplier: number;
  implied_value_usd: number;
  score: number;
  band: string;
  evidence: string;
  farm_steps: string[];
}

/** A live-token protocol: it already trades, so the board shows the market's own value. */
export interface LiveRow {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  mcap_usd: number | null;
  change_7d: number | null;
  tvl_multiple: number | null;
}

/** Everything the dashboard renders, from the snapshot. */
export interface RadarData {
  as_of: string;
  source: string;
  floor_usd: number;
  snapshot_sha256: string;
  commit: string;
  model: ModelConstants;
  model_version: string;
  global_multiple: number;
  watchlist_size: number;
  board_size: number;
  early_size: number;
  live_size: number;
  multiples: CategoryMultiple[];
  rows: RadarRow[];
  live: LiveRow[];
}

/** Why the snapshot is not one this model can score. */
export class SnapshotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SnapshotError';
  }
}

const DAY_MS = 86_400_000;

const round4 = (n: number): number => Math.round(n * 1e4) / 1e4;

const bySlugAsc = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** A finite number, else `fallback`. */
function finite(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/** Whole dollars with thousands separators, for evidence sentences: 1234567 -> "1,234,567". */
function fmtInt(n: number): string {
  return String(Math.trunc(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/** A signed percent with two decimals, as the snapshot reports change_7d: 4.25 -> "+4.25%". */
function fmtPct(n: number): string {
  return `${n > 0 ? '+' : ''}${n.toFixed(2)}%`;
}

/** A whole day count from `listedAt` to `asOf`, clamped at zero; null when either date is absent or bad. */
export function ageDays(asOf: string, listedAt: string | null): number | null {
  if (listedAt === null) return null;
  const a = Date.parse(`${asOf}T00:00:00Z`);
  const b = Date.parse(`${listedAt}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.max(0, Math.floor((a - b) / DAY_MS));
}

/** The median of a non-empty list of numbers, sorted ascending first. */
function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/** Whether a protocol records no token at all. */
export function isPreToken(p: SnapshotProtocol): boolean {
  return p.mcap_usd === null && p.gecko_id === null && p.symbol === null;
}

/** DefiLlama's version-marker rule: a name ending in a release is a pool of another protocol. */
const VERSIONED = /\s(V\d+(\.\d+)?|v\d+(\.\d+)?|\d+\.\d+)$/;

/** Categories the house's watchlist screen sets aside: products of a token that already trades. */
const SCREENED_CATEGORIES = new Set(['Bridge', 'Canonical Bridge', 'Liquid Staking', 'Liquid Restaking', 'Restaked BTC', 'CEX']);

/** A name carrying a whole word wrapped, staked or staking is a product of another protocol. */
const PRODUCT_WORD = /\b(wrapped|staked|staking)\b/i;

/** A name beginning with an exchange's name is that exchange's own product. */
const EXCHANGE_PREFIX = /^(Binance|Coinbase|Bybit|Kraken|Bitget|OKX|Bitfinex|Gemini)(\s|$)/;

/** The house's watchlist screen, applied to the early radar below the floor as at it. */
export function passesScreen(p: SnapshotProtocol): boolean {
  if (p.category !== null && SCREENED_CATEGORIES.has(p.category)) return false;
  if (VERSIONED.test(p.name)) return false;
  if (PRODUCT_WORD.test(p.name)) return false;
  if (EXCHANGE_PREFIX.test(p.name)) return false;
  return true;
}

/**
 * The price of a dollar of TVL, from the snapshot's tokenised protocols: the global median
 * mcap/TVL and each category's shrunk median. Only protocols with both figures on record price
 * anything; a protocol whose token trades but records no market cap prices nothing.
 */
export function categoryMultiples(snapshot: Snapshot, model: ModelConstants = MODEL): { global: number; byCategory: Map<string, CategoryMultiple> } {
  const ratiosByCategory = new Map<string, number[]>();
  const all: number[] = [];
  for (const p of snapshot.protocols) {
    if (isPreToken(p) || p.mcap_usd === null || p.mcap_usd <= 0 || p.tvl_usd <= 0) continue;
    const ratio = p.mcap_usd / p.tvl_usd;
    all.push(ratio);
    const key = p.category ?? '';
    const list = ratiosByCategory.get(key);
    if (list === undefined) ratiosByCategory.set(key, [ratio]);
    else list.push(ratio);
  }
  const global = all.length > 0 ? median(all) : 0.25;
  const byCategory = new Map<string, CategoryMultiple>();
  for (const [category, ratios] of ratiosByCategory) {
    const med = median(ratios);
    const shrunk = (ratios.length * med + model.shrink_k * global) / (ratios.length + model.shrink_k);
    byCategory.set(category, {
      category,
      peers: ratios.length,
      median: round4(med),
      multiple: round4(Math.min(model.multiple_max, Math.max(model.multiple_min, shrunk))),
    });
  }
  return { global: round4(global), byCategory };
}

/** The multiple one protocol is priced at: its category's, or the global median when it has no priced peers. */
function multipleFor(p: SnapshotProtocol, multiples: { global: number; byCategory: Map<string, CategoryMultiple> }): { multiple: number; peers: number } {
  const entry = multiples.byCategory.get(p.category ?? '');
  if (entry === undefined) return { multiple: multiples.global, peers: 0 };
  return { multiple: entry.multiple, peers: entry.peers };
}

interface Scored {
  p: SnapshotProtocol;
  implied: number;
  multiple: number;
  peers: number;
  growthPct: number;
  growthMult: number;
  maturityMult: number;
  breadthMult: number;
  age: number | null;
}

/** One protocol's implied value and the factors that made it, under `model`. */
function scoreOne(p: SnapshotProtocol, asOf: string, multiples: { global: number; byCategory: Map<string, CategoryMultiple> }, model: ModelConstants): Scored {
  const age = ageDays(asOf, p.listed_at);
  const { multiple, peers } = multipleFor(p, multiples);
  const growthPct = Math.min(model.growth_cap, Math.max(model.growth_floor, finite(p.change_7d, 0)));
  const growthMult = 1 + (growthPct / 100) * model.growth_weight;
  const ageForModel = age ?? model.unknown_age_days;
  const maturityMult = model.maturity_floor + (Math.min(Math.max(ageForModel, 0), model.maturity_days) / model.maturity_days) * model.maturity_range;
  const breadthMult = 1 + model.breadth_per_chain * Math.min(Math.max(p.chains.length - 1, 0), model.breadth_max_extra);
  const implied = Math.max(1, Math.round(p.tvl_usd * multiple * growthMult * maturityMult * breadthMult));
  return { p, implied, multiple, peers, growthPct, growthMult, maturityMult, breadthMult, age };
}

/** The launch score's band, from the score alone. */
function bandFor(score: number): string {
  if (score >= 70) return 'Prime';
  if (score >= 50) return 'Strong';
  if (score >= 30) return 'Emerging';
  return 'Early';
}

/**
 * The 0-100 launch score: where the row stands on size, momentum and time-without-a-token among
 * the board's own rows. Deterministic in the snapshot; a reading aid beside the implied value,
 * never a second ranking (rank is by implied value alone).
 */
function launchScore(s: Scored, minLogTvl: number, maxLogTvl: number, model: ModelConstants): number {
  const logTvl = Math.log(Math.max(1, s.p.tvl_usd));
  const sizeNorm = maxLogTvl > minLogTvl ? (logTvl - minLogTvl) / (maxLogTvl - minLogTvl) : 0.5;
  const growthNorm = (s.growthPct - model.growth_floor) / (model.growth_cap - model.growth_floor);
  const ageNorm = Math.min(s.age ?? model.unknown_age_days, model.maturity_days) / model.maturity_days;
  const score = Math.round(100 * (0.55 * sizeNorm + 0.25 * growthNorm + 0.2 * ageNorm));
  return Math.min(100, Math.max(0, score));
}

/** The evidence sentence: only figures the snapshot itself carries, and the peer count that priced the row. */
function evidenceFor(s: Scored): string {
  const p = s.p;
  const chainList = p.chains.slice(0, 3).join(', ') + (p.chains.length > 3 ? ` and ${p.chains.length - 3} more` : '');
  const chains = p.chains.length === 0 ? 'no chain on record' : `${p.chains.length} chain${p.chains.length === 1 ? '' : 's'} (${chainList})`;
  const tracked = p.listed_at === null ? 'first tracked on an unrecorded date' : `first tracked ${p.listed_at}`;
  const age = s.age === null ? 'an unrecorded span' : `${fmtInt(s.age)} days`;
  const moved = p.change_7d === null ? 'reports no 7-day TVL change' : `moved ${fmtPct(p.change_7d)} over the last 7 days`;
  const peers = s.peers === 0
    ? `no tokenised ${p.category ?? 'uncategorised'} peer prices it, so the global peer median of ${s.multiple}x TVL applies`
    : `the snapshot's ${s.peers} tokenised ${p.category ?? 'uncategorised'} peer${s.peers === 1 ? '' : 's'} price${s.peers === 1 ? 's' : ''} TVL at a shrunk median of ${s.multiple}x`;
  return `${p.name} records $${fmtInt(p.tvl_usd)} of TVL across ${chains}, category ${p.category ?? 'uncategorised'}, ${tracked} — ${age} with no token on record. Its TVL ${moved}, and ${peers}.`;
}

/** A farm step: the action, what it costs, and how long it takes. */
export interface FarmStep {
  text: string;
  cost: string;
  time: string;
}

/** A step as one string: its action, then its cost and time, within the gate's 20..600 characters once trimmed. */
export function stepText(step: FarmStep): string {
  let s = `${step.text} Cost: ${step.cost}. Time: ${step.time}.`;
  if (s.length > 600) s = `${s.slice(0, 596)}...`;
  if (s.trim().length < 20) s = `${s} Hold the position and check the protocol's own page.`;
  return s;
}

/** The first chain a protocol names, or a neutral phrase. */
function chainOf(p: SnapshotProtocol): string {
  return p.chains.length > 0 ? p.chains[0]! : 'its main chain';
}

/** A second chain a protocol names, when it names one. */
function secondChainOf(p: SnapshotProtocol): string | null {
  return p.chains.length > 1 ? p.chains[1]! : null;
}

/** How much capital one farm position needs, from the protocol's own TVL. */
function capitalFor(p: SnapshotProtocol): number {
  if (p.tvl_usd >= 5_000_000_000) return 250;
  if (p.tvl_usd >= 1_000_000_000) return 150;
  if (p.tvl_usd >= 100_000_000) return 100;
  if (p.tvl_usd >= 10_000_000) return 75;
  return 50;
}

/** How long to hold, from the protocol's age: younger protocols get a longer qualifying window. */
function holdDaysFor(age: number | null): number {
  if (age === null) return 45;
  if (age < 180) return 60;
  if (age < 365) return 45;
  return 30;
}

/** The category's main action, in words a farmer can follow. */
function actionFor(p: SnapshotProtocol, capital: number, chain: string): string {
  const c = (p.category ?? '').toLowerCase();
  const name = p.name;
  if (c.includes('lend') || c.includes('cdp') || c.includes('collateral')) return `Supply $${capital} of USDC to ${name} on ${chain} and keep the position open.`;
  if (c.includes('dex') || c.includes('swap')) return `Provide $${capital} of liquidity to ${name}'s main pool on ${chain} and keep the position open.`;
  if (c.includes('bridge')) return `Bridge $${capital} of USDC to ${chain} through ${name} and use the bridged funds in its app.`;
  if (c.includes('staking') || c.includes('restak')) return `Stake $${capital} of the chain's staking asset through ${name} and keep the receipt.`;
  if (c.includes('perpetual') || c.includes('derivative') || c.includes('options')) return `Deposit $${capital} of USDC as margin on ${name} and open one small hedge.`;
  if (c.includes('prediction')) return `Fund $${capital} and place one market position on ${name}.`;
  if (c.includes('curator') || c.includes('allocator') || c.includes('risk')) return `Deposit $${capital} into a ${name} vault on ${chain} and keep the shares.`;
  if (c.includes('yield') || c.includes('farm')) return `Deposit $${capital} into ${name}'s main vault on ${chain} and keep the position open.`;
  if (c.includes('stable')) return `Mint or deposit $${capital} of the stable asset through ${name} on ${chain}.`;
  if (c.includes('rwa')) return `Mint $${capital} of the protocol's yield asset on ${chain} and hold it.`;
  if (c.includes('insurance')) return `Buy $${capital} of cover from ${name} on ${chain} and keep the policy.`;
  if (c.includes('launchpad')) return `Register the wallet with ${name} and take part in one sale or waitlist it runs on ${chain}.`;
  return `Deposit $${capital} of USDC into ${name} on ${chain} and keep the position open.`;
}

/** The category's second, compounding action: the step that makes the first one count twice. */
function secondActionFor(p: SnapshotProtocol, capital: number, chain: string): string {
  const c = (p.category ?? '').toLowerCase();
  const name = p.name;
  const small = Math.max(25, Math.round(capital / 2));
  if (c.includes('lend') || c.includes('cdp') || c.includes('collateral')) return `Borrow $${small} against the supply on ${name}, hold it a week, then repay in full so the wallet shows both sides of the market.`;
  if (c.includes('dex') || c.includes('swap')) return `Route one swap of about $${small} through ${name} on ${chain} so the wallet records trading activity as well as liquidity.`;
  if (c.includes('bridge')) return `Bridge about $${small} back through ${name}, or onward to a second chain it serves, so the wallet records a round trip.`;
  if (c.includes('staking') || c.includes('restak')) return `Claim any staking rewards ${name} shows and restake them once, so the position compounds on the record.`;
  if (c.includes('perpetual') || c.includes('derivative') || c.includes('options')) return `Roll the hedge once: close it and open a fresh one of the same size, so the wallet records repeat trading on ${name}.`;
  if (c.includes('prediction')) return `Take a second, smaller position in another market on ${name} so the wallet is active in more than one market.`;
  if (c.includes('curator') || c.includes('allocator') || c.includes('risk')) return `Move about $${small} of the deposit into a second ${name} vault on ${chain}, so the wallet holds shares of two vaults.`;
  if (c.includes('yield') || c.includes('farm')) return `Claim the rewards the position earns on ${name} and deposit them back once, so the wallet records a compound.`;
  if (c.includes('stable')) return `Supply about $${small} of the stable asset inside ${name}'s own app, where it offers a market for it, and hold both positions.`;
  if (c.includes('rwa')) return `Add about $${small} more of the yield asset on ${chain} a month later, so the wallet shows a repeat mint on ${name}.`;
  if (c.includes('insurance')) return `Renew or extend the cover on ${name} once before it lapses, so the wallet records a second policy period.`;
  if (c.includes('launchpad')) return `Complete every registration step ${name} lists for the sale, including any wallet check, before its deadline.`;
  return `Make a second, smaller deposit of about $${small} into ${name} on ${chain} a week after the first, so the wallet shows repeat use.`;
}

/**
 * A protocol's farm plan: seven steps, each an action with a cost and a time. The plan is derived
 * from the protocol's own record (category, chains, TVL, age), never from a hand-written list of
 * names, and board.json and the dashboard carry the same strings.
 */
export function farmSteps(p: SnapshotProtocol, age: number | null): FarmStep[] {
  const chain = chainOf(p);
  const second = secondChainOf(p);
  const capital = capitalFor(p);
  const hold = holdDaysFor(age);
  return [
    {
      text: `Use a fresh wallet that holds only the funds you plan to farm with, and keep its seed phrase offline.`,
      cost: 'under $3 of gas for the first transaction',
      time: '5 minutes',
    },
    {
      text: actionFor(p, capital, chain),
      cost: `$${capital} of capital and about $${capital >= 150 ? 8 : 4} of gas`,
      time: '15 minutes to set up',
    },
    {
      text: secondActionFor(p, capital, chain),
      cost: `about $${Math.max(25, Math.round(capital / 2))} of capital and about $3 of gas`,
      time: '15 minutes, a week after step 2',
    },
    {
      text: second === null
        ? `Repeat one qualifying action on ${p.name} each week — a deposit, a claim or a vote — so the wallet never goes quiet.`
        : `Use ${p.name} on ${second} as well as ${chain}: one small deposit or swap there, so the wallet is active on two of its chains.`,
      cost: 'about $2 of gas a week',
      time: '10 minutes a week',
    },
    {
      text: `Hold the position for at least ${hold} days so the activity is counted in more than one snapshot.`,
      cost: `the $${capital} stays in the position`,
      time: `${hold} days`,
    },
    {
      text: `Before you withdraw, open ${p.name}'s own points or rewards page and claim only from the link it publishes; never pay a third party to claim.`,
      cost: 'no fee to check, and never pay to claim',
      time: '10 minutes',
    },
    {
      text: `Keep a farm log — wallet, dates, amounts, transaction hashes — and unwind the position when a launch is announced or the record changes.`,
      cost: 'nothing but the log; unwinding costs normal gas',
      time: '5 minutes to log, 15 minutes to unwind',
    },
  ];
}

/** The protocols the board ranks, strongest first, with ranks 1..n. */
export function buildBoard(snapshot: Snapshot, model: ModelConstants = MODEL): BoardRow[] {
  const index = new Map(snapshot.protocols.map((p) => [p.slug, p]));
  const multiples = categoryMultiples(snapshot, model);
  const watchlist = new Set(snapshot.watchlist);

  const chosen = new Map<string, SnapshotProtocol>();
  for (const slug of snapshot.watchlist) {
    const p = index.get(slug);
    if (p !== undefined) chosen.set(slug, p);
  }
  const earlyCandidates = snapshot.protocols.filter(
    (p) => !chosen.has(p.slug) && isPreToken(p) && p.tvl_usd < snapshot.floor_usd && passesScreen(p),
  );
  const scoredEarly = earlyCandidates
    .map((p) => scoreOne(p, snapshot.as_of, multiples, model))
    .sort((a, b) => b.implied - a.implied || bySlugAsc(a.p.slug, b.p.slug));
  const earlySlots = Math.max(0, BOARD_CAP - chosen.size);
  for (const s of scoredEarly.slice(0, earlySlots)) chosen.set(s.p.slug, s.p);

  const scored = [...chosen.values()]
    .map((p) => scoreOne(p, snapshot.as_of, multiples, model))
    .sort((a, b) => b.implied - a.implied || bySlugAsc(a.p.slug, b.p.slug));
  const logTvls = scored.map((s) => Math.log(Math.max(1, s.p.tvl_usd)));
  const minLogTvl = logTvls.length > 0 ? Math.min(...logTvls) : 0;
  const maxLogTvl = logTvls.length > 0 ? Math.max(...logTvls) : 0;

  return scored.map((s, i) => {
    const score = launchScore(s, minLogTvl, maxLogTvl, model);
    return {
      rank: i + 1,
      slug: s.p.slug,
      name: s.p.name,
      category: s.p.category,
      chains: s.p.chains,
      tvl_usd: s.p.tvl_usd,
      change_7d: s.p.change_7d,
      mcap_usd: s.p.mcap_usd,
      listed_at: s.p.listed_at,
      gecko_id: s.p.gecko_id,
      symbol: s.p.symbol,
      token_status: 'pre-token' as const,
      on_watchlist: watchlist.has(s.p.slug),
      age_days: s.age,
      implied_value_usd: s.implied,
      score,
      band: bandFor(score),
      evidence: evidenceFor(s),
      model: {
        category_multiple: s.multiple,
        category_peers: s.peers,
        growth_pct: s.growthPct,
        growth_multiplier: round4(s.growthMult),
        maturity_multiplier: round4(s.maturityMult),
        breadth_multiplier: round4(s.breadthMult),
        age_days: s.age,
      },
      farm_steps: farmSteps(s.p, s.age).map(stepText),
    };
  });
}

/** The live-token protocols, by market cap, for the dashboard's Live view. */
export function liveRows(snapshot: Snapshot): LiveRow[] {
  return snapshot.protocols
    .filter((p) => !isPreToken(p) && p.category !== 'CEX')
    .sort((a, b) => (b.mcap_usd ?? 0) - (a.mcap_usd ?? 0) || b.tvl_usd - a.tvl_usd || bySlugAsc(a.slug, b.slug))
    .slice(0, LIVE_ROWS)
    .map((p) => ({
      slug: p.slug,
      name: p.name,
      category: p.category,
      chains: p.chains,
      tvl_usd: p.tvl_usd,
      mcap_usd: p.mcap_usd,
      change_7d: p.change_7d,
      tvl_multiple: p.mcap_usd !== null && p.mcap_usd > 0 && p.tvl_usd > 0 ? round4(p.mcap_usd / p.tvl_usd) : null,
    }));
}

/** A board row's form for data.js: the same figures and plan the board carries. */
function radarRow(row: BoardRow): RadarRow {
  return {
    rank: row.rank,
    slug: row.slug,
    name: row.name,
    category: row.category,
    chains: row.chains,
    tvl_usd: row.tvl_usd,
    change_7d: row.change_7d,
    listed_at: row.listed_at,
    age_days: row.age_days,
    on_watchlist: row.on_watchlist,
    category_multiple: row.model.category_multiple,
    growth_multiplier: row.model.growth_multiplier,
    maturity_multiplier: row.model.maturity_multiplier,
    breadth_multiplier: row.model.breadth_multiplier,
    implied_value_usd: row.implied_value_usd,
    score: row.score,
    band: row.band,
    evidence: row.evidence,
    farm_steps: row.farm_steps,
  };
}

/** Everything the dashboard renders, from the snapshot. `meta` carries the run's own record. */
export function buildRadar(
  snapshot: Snapshot,
  meta: { snapshot_sha256: string; commit: string },
  model: ModelConstants = MODEL,
): { board: BoardRow[]; radar: RadarData } {
  const board = buildBoard(snapshot, model);
  const live = liveRows(snapshot);
  const multiples = categoryMultiples(snapshot, model);
  const early = board.filter((r) => !r.on_watchlist).length;
  const radar: RadarData = {
    as_of: snapshot.as_of,
    source: snapshot.source,
    floor_usd: snapshot.floor_usd,
    snapshot_sha256: meta.snapshot_sha256,
    commit: meta.commit,
    model,
    model_version: MODEL_VERSION,
    global_multiple: multiples.global,
    watchlist_size: snapshot.watchlist.length,
    board_size: board.length,
    early_size: early,
    live_size: live.length,
    multiples: [...multiples.byCategory.values()]
      .sort((a, b) => b.peers - a.peers || bySlugAsc(a.category, b.category))
      .slice(0, 14),
    rows: board.map(radarRow),
    live,
  };
  return { board, radar };
}

/** The snapshot out of a file's text, refused unless it is the shape the model scores. */
export function parseSnapshot(text: string): Snapshot {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new SnapshotError('snapshot.json is not JSON');
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new SnapshotError('snapshot.json is not a JSON object');
  const o = raw as Record<string, unknown>;
  if (typeof o.as_of !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(o.as_of)) throw new SnapshotError('snapshot.json has no as_of date');
  if (typeof o.source !== 'string') throw new SnapshotError('snapshot.json has no source');
  if (typeof o.floor_usd !== 'number' || !Number.isSafeInteger(o.floor_usd) || o.floor_usd <= 0) throw new SnapshotError('snapshot.json has no floor_usd');
  if (!Array.isArray(o.protocols)) throw new SnapshotError('snapshot.json has no protocols array');
  if (!Array.isArray(o.watchlist) || o.watchlist.some((s) => typeof s !== 'string')) throw new SnapshotError('snapshot.json has no watchlist of slugs');
  const protocols = o.protocols.map((v, i) => {
    if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new SnapshotError(`snapshot.json's protocol ${i} is not an object`);
    const p = v as Record<string, unknown>;
    if (typeof p.slug !== 'string' || typeof p.name !== 'string' || typeof p.tvl_usd !== 'number' || !Number.isFinite(p.tvl_usd)) {
      throw new SnapshotError(`snapshot.json's protocol ${i} lacks a slug, a name or a TVL`);
    }
    return {
      slug: p.slug,
      name: p.name,
      category: typeof p.category === 'string' ? p.category : null,
      chains: Array.isArray(p.chains) ? p.chains.filter((c): c is string => typeof c === 'string') : [],
      tvl_usd: p.tvl_usd,
      change_7d: typeof p.change_7d === 'number' && Number.isFinite(p.change_7d) ? p.change_7d : null,
      mcap_usd: typeof p.mcap_usd === 'number' && Number.isFinite(p.mcap_usd) ? p.mcap_usd : null,
      listed_at: typeof p.listed_at === 'string' ? p.listed_at : null,
      gecko_id: typeof p.gecko_id === 'string' ? p.gecko_id : null,
      symbol: typeof p.symbol === 'string' ? p.symbol : null,
    };
  });
  return {
    as_of: o.as_of,
    source: o.source,
    floor_usd: o.floor_usd,
    protocols,
    watchlist: o.watchlist as string[],
  };
}

/** Why a board is not one the gate will take, or null: coverage, size, ranks, order, values, farm steps. */
export function boardIssue(board: BoardRow[], snapshot: Snapshot): string | null {
  if (board.length < 100 || board.length > 4000) return `the board holds ${board.length} rows, outside 100..4000`;
  const slugs = new Set<string>();
  for (const r of board) {
    if (slugs.has(r.slug)) return `slug ${r.slug} appears twice`;
    slugs.add(r.slug);
  }
  const known = new Set(snapshot.protocols.map((p) => p.slug));
  for (const r of board) if (!known.has(r.slug)) return `slug ${r.slug} is not one of the snapshot's protocols`;
  const missing = snapshot.watchlist.filter((s) => !slugs.has(s));
  if (missing.length > 0) return `the board misses ${missing.length} watchlist slug${missing.length === 1 ? '' : 's'}: ${missing.slice(0, 5).join(', ')}`;
  for (let i = 0; i < board.length; i++) {
    const r = board[i]!;
    if (r.rank !== i + 1) return `row ${i + 1} carries rank ${r.rank}`;
    if (i > 0 && r.implied_value_usd > board[i - 1]!.implied_value_usd) return `row ${i + 1} outranks row ${i} on implied value`;
    if (!Number.isSafeInteger(r.implied_value_usd) || r.implied_value_usd <= 0 || r.implied_value_usd > 100_000_000_000_000) {
      return `${r.slug} has implied value ${r.implied_value_usd}`;
    }
    if (r.farm_steps.length < 3 || r.farm_steps.length > 12) return `${r.slug} has ${r.farm_steps.length} farm steps`;
    for (const s of r.farm_steps) {
      const trimmed = s.trim().length;
      if (trimmed < 20 || trimmed > 600) return `${r.slug} has a farm step of ${trimmed} trimmed characters`;
    }
  }
  if (board.length >= 2 && board[0]!.implied_value_usd === board[board.length - 1]!.implied_value_usd) {
    return 'every row shares one implied value: a board that ranks nothing by value is not a ranking';
  }
  return null;
}

/** A compact data.js: the dashboard's whole dataset as one script, no fetch and no network. */
export function dataScript(radar: RadarData): string {
  return `window.RADAR=${JSON.stringify(radar)};\n`;
}
