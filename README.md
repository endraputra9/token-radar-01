# Launch Radar

A token launch radar for make.fun's token-radar-01 bounty. It reads the sealed
DefiLlama protocol snapshot and ranks the protocols that record no token yet by
what their launch would be worth if their record stayed as it is, each with the
steps to farm it.

## The model

One function prices every row, from the snapshot's own figures:

- **Peers.** Tokenised protocols with a market cap and a TVL on record set the
  price of TVL: `ratio = mcap_usd / tvl_usd`. A category's multiple is the
  median ratio of its tokenised members, shrunk toward the global median by
  member count (`(n * median + 6 * global) / (n + 6)`) and clamped to
  [0.02, 3.0]. A category with no priced peer uses the global median.
- **Implied value.**
  `tvl * category_multiple * growth * maturity * breadth`, whole dollars, where
  growth follows the 7-day TVL change (clamped to [-50, 100] percent, weight
  0.35), maturity follows the days since DefiLlama first tracked the protocol
  (0.70 + 0.30 * min(age, 1095) / 1095; unknown age counts 365), and breadth
  adds 3 percent per extra chain, up to five.
- **Board.** The snapshot's whole watchlist, plus the strongest pre-token
  protocols below the watchlist floor that pass the same screen the house
  applies at the floor (no bridge / liquid-staking / restaking / exchange
  categories, no versioned names, no wrapped or staked product names, no
  exchange-prefixed names), capped at 300 rows. Tokenised protocols are never
  ranked; the dashboard sets them aside with their recorded market caps.
- **Farm plans and evidence** are generated per row from that row's own record
  (category, chains, TVL, age). No protocol name is special-cased anywhere.

## Run

```
mkdir -p out
MAKEFUN_OUTPUT_DIR=out node main.ts --input <path-to-snapshot.json>
```

Writes `board.json`, `data.js`, `dashboard/`, `screenshots/` and `dossier.json`
(the last with `vendor/makefun-board.ts`, the kit's library, byte for byte).
The run is deterministic: the same snapshot bytes give the same output bytes.

## Layout

- `main.ts` — the entrypoint: input, outputs, dossier.
- `lib/model.ts` — the snapshot reader, the pricing model, the board, the farm
  plans, and the gate self-check.
- `dashboard/` — the static page (board, filters, detail view, live view).
- `screenshots/` — the board, a detail view and a filtered view.
- `vendor/makefun-board.ts` — make.fun's dossier library, copied from the kit.

## License

MIT — see `LICENSE`.
