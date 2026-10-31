# Claude Code implementation plan: Bitcoin paper trading

Prepared October 31, 2026, against LLM-Swarm commit `57915dd`.

## 1. Product goal and scope

Build a Bitcoin trading application that consumes actual exchange market data, makes strategy decisions, and records realistic simulated orders, fills, cash, holdings, and profit or loss. The user can leave it running, inspect the evidence, and decide whether the strategy merits a later, tightly controlled trial with a real trading account.

The user experience should be: **real market, simulated money and orders, fully measured results**. The strategy uses the same decision and risk interfaces intended for eventual live execution. Every receipt and screen remains explicitly labeled `PAPER`; hiding the simulation from the model or operator is unnecessary.

This repository currently provides software-agent orchestration, model adapters, SQLite persistence, a daemon, MCP tools, and a local dashboard. It has no trading engine or demonstrated trading strategy. Treat trading as a new subsystem. Software correctness and trading performance require separate evidence. A profitable simulation cannot establish future profitability.

Deliver this plan through the paper-trading and evaluation phases first. Implement the later live adapter behind an explicit boundary, using fake transports for development. Do not activate live trading, request exchange trading credentials, fund accounts, or submit real orders while implementing this plan.

### Initial engineering defaults

These are editable simulation defaults, not recommendations for allocating real money.

| Decision               | Initial scope                                                                              |
| ---------------------- | ------------------------------------------------------------------------------------------ |
| Instrument             | Spot `BTC-USD`, one venue and one product per session                                      |
| Initial venue          | Coinbase Advanced Trade public market data; keep an adapter interface for another venue    |
| Funds                  | USD 10,000 simulated cash, zero BTC; configurable when creating a session                  |
| Position types         | Cash or long BTC; no leverage, borrowing, shorting, derivatives, or transfers              |
| First supported orders | Market orders modeled as immediate-or-cancel; partial execution and rejection supported    |
| Decision cadence       | Every completed five-minute bar; no LLM invocation per market tick                         |
| Execution data         | Synchronized live Level 2 book and trade feed; executable bid/ask prices                   |
| Initial strategies     | Cash, buy-and-hold controls, one simple deterministic rule, then an optional LLM candidate |
| Credentials            | Public market data requires no private exchange trading credentials                        |
| First release mode     | `paper` only; configuration requesting live execution fails explicitly                     |
| Storage                | Separate trading database and market recordings beneath a trading data directory           |

Exchange choice is an implementation assumption. Before eventual live use, confirm the user's venue, location eligibility, product availability, account permissions, actual fee tier, and chosen capital limits. These decisions do not block building the paper system.

## 2. What a successful first release looks like

The user starts a paper session, sees a current BTC price and feed health, and sees clearly labeled simulated balances. The candidate can buy, hold, and sell. Its orders incur modeled fees, spread, latency, and liquidity constraints. Restarting the daemon preserves the portfolio and pending order state without duplicate fills. A report compares net results against controls and explains why the evidence is insufficient, unfavorable, or eligible for human review.

Provide three distinct research workflows:

1. **Historical screening:** chronological candle-based research with explicitly simplified execution. Useful for rejecting weak ideas; insufficient for claims about exact fills.
2. **Recorded-market replay:** run the execution engine against captured quote/book/trade events with an injected clock and reproducible configuration.
3. **Forward paper trading:** make decisions prospectively on the live feed, then simulate their execution as subsequent market events arrive. This is the main strategy-observation mode.

An exchange sandbox is an API integration fixture, not a substitute for this experiment. Coinbase documents its Advanced Trade sandbox as static, predefined, mocked responses. Use production public market data with our own paper execution engine for the requested test. [Coinbase sandbox documentation](https://docs.cdp.coinbase.com/coinbase-app/advanced-trade-apis/sandbox)

## 3. Architecture and boundaries

```text
Production public market data
             |
     normalize + validate + record
             |
       synchronized market state
             |
     immutable decision snapshot
             |
   deterministic or LLM strategy
             |
      proposed target exposure
             |
    deterministic sizing + risk
             |
         approved order
             |
       simulated broker
             |
    journal + cash + BTC + fills
             |
  evaluation / reports / dashboard
```

The coding swarm may build and review this application. It must not serve as its trading event loop. Do not execute market decisions through coding-worker tools, Git worktrees, arbitrary commands, or self-modifying strategy code.

Use a separate `TradingService` hosted by the existing daemon. Keep paper trading operational when no coding job or model is running. A read-only status command, market recorder, deterministic strategy, or replay must not require an Ollama capability probe or invoke a paid model.

### Proposed code layout

```text
src/trading/
  domain.ts                 typed events, orders, fills, balances, state machines
  config.ts                 Zod validation and immutable session configuration
  service.ts                lifecycle, queries, reports, control methods
  runtime.ts                single-owner event loop and scheduling
  clock.ts                  real/replay clocks and deterministic ordering
  market/types.ts           venue-neutral public-data interface
  market/coinbase.ts        public Advanced Trade adapter
  market/book.ts            snapshot/update handling and health
  market/recorder.ts        raw recording and checksummed dataset manifests
  features.ts               causal features and completed bars
  execution/types.ts        broker interface and order lifecycle
  execution/paper.ts        simulated latency, liquidity, fills, cancellation
  portfolio/ledger.ts       exact arithmetic and transactional accounting
  risk.ts                   authoritative sizing and limits
  strategies/types.ts       bounded strategy interface
  strategies/baselines.ts   cash, buy-and-hold, deterministic rule
  strategies/llm.ts         structured proposals with no execution privileges
  evaluation/replay.ts      same engine, recorded events, replay clock
  evaluation/metrics.ts     PnL, drawdown, costs, controls, uncertainty
  evaluation/readiness.ts   versioned evidence requirements and findings
  store.ts                  TradingStore and its own migrations
  export.ts                 JSON/CSV/HTML reports and evidence manifest
```

Reuse the existing TypeScript, Zod, SQLite, logging, redaction, HTTP controls, and model-provider abstractions. Add dependencies only when needed, pin them in the lockfile, and document their purpose. Preserve current coding-agent functionality.

### Repository integration requirements

- `src/cli.ts`: add the proposed trading commands below before model negotiation for commands that do not need a model.
- `src/mcp/backend.ts`: its current backend methods derive from `Orchestrator`. Introduce a composite application backend or an independent trading backend instead of putting trading methods inside the coding scheduler.
- `src/mcp/server.ts`: register a small, explicitly selected paper toolset. Avoid a generic exchange-request or shell tool.
- `src/web/server.ts`: inject `TradingService` alongside the coding orchestrator. Preserve loopback binding, session-token checks, exact host/origin validation, and escaping of external content.
- `src/providers/`: reuse the API provider contracts through a trading-specific client. The current job-scoped call recorder requires a coding `jobId`; add session/decision-linked trading usage records rather than inventing coding jobs.
- `src/db/`: do not mix high-volume market events into the coding control database or reuse its scheduler lock. The trading database needs its own single-owner lease and additive migrations.
- `web/`: extend the existing dashboard without replacing the coding-agent views.

## 4. Data contracts and reproducibility

Define these contracts before parallel implementation. All money, quantities, prices, rates, and weights cross API/storage boundaries as validated decimal strings or documented integer units. Use fixed-scale integers or a decimal library for accounting, with explicit rounding. Do not use floating-point arithmetic to settle balances or fees. Floating point may be used for derived statistical indicators with documented tolerances.

```ts
interface MarketDataPort {
  stream(signal: AbortSignal): AsyncIterable<MarketEvent>;
}

interface StrategyPort {
  decide(snapshot: DecisionSnapshot, signal: AbortSignal): Promise<TradeIntent>;
}

interface BrokerPort {
  submit(order: ApprovedOrder): Promise<OrderReceipt>;
  cancel(orderId: string): Promise<OrderReceipt>;
  onMarket(event: MarketEvent): Promise<Fill[]>;
}
```

`TradeIntent` proposes `hold` or a target BTC portfolio weight, with `decisionId`, `snapshotId`, `validUntil`, and bounded rationale. A model does not supply trusted fill prices, rewrite balances, approve orders, select network endpoints, or change risk policy. `ApprovedOrder` is created only by deterministic sizing and risk code and carries the policy version, market snapshot reference, and idempotency key.

Store enough provenance to reconstruct every decision:

- Session ID, mode, venue, product, initial balances, UTC timestamps, source commit, dependency versions, and experiment purpose.
- Frozen strategy parameters, prompt/schema hash, model identity, provider route, risk policy, fee assumptions, fill-model version, and readiness policy.
- Exchange event time, local receipt time, processing ordinal, connection epoch, sequence metadata, and raw-event reference.
- Snapshot inputs, completed feature windows, model request/response hashes, latency, validation outcome, and reported token usage.
- Intent, accepted/rejected risk checks, reserved funds, order transitions, fills, fees, portfolio changes, and valuation marks.

Use tables such as `sessions`, `strategy_versions`, `market_segments`, `decisions`, `model_calls`, `risk_events`, `orders`, `fills`, `ledger_entries`, `valuations`, `experiments`, and `reports`. Enforce unique keys for source events, decisions, client order IDs, and fill IDs. Keep raw streams in compressed append-only segments with hashes and explicit retention limits; retain the segments needed by any published evaluation report.

One transaction must cover a fill's idempotency record, balance postings, reservation changes, order transition, and associated audit event. Never reset an existing session's ledger to make a new experiment. Create a new session with a parent reference instead.

Define independent state machines:

- Session lifecycle: `created`, `running`, `paused`, `stopped`, `failed`, `completed`.
- Feed health: `connecting`, `synchronizing`, `healthy`, `stale`, `gap`, `disconnected`.
- Order lifecycle: `submitted`, `accepted`, `partially_filled`, `filled`, `cancel_pending`, `cancelled`, `rejected`, `expired`.
- Evidence classification: `not_ready`, `insufficient_evidence`, `eligible_for_human_review`.

On restart, rebuild projections from durable events, verify ledger invariants, synchronize a fresh market snapshot, and resume only according to recorded lifecycle policy. A restart must never invent fills during an unobserved outage. An offline period invalidates continuous observation; identify it in reports.

### Concurrency and recording durability

Market ingestion, book updates, recording, existing-order handling, and stop controls must continue while a strategy is awaiting a model response. Never await an LLM inside the only feed-consumer loop. Permit one in-flight strategy decision per session, based on an immutable completed-bar snapshot. If another scheduled bar arrives meanwhile, use a documented skip/coalesce policy and audit the missed decision; do not accumulate an unbounded backlog.

Bind every pending response to its session generation, snapshot, and expiry. Increment the generation on pause, stop, or restart; late responses from an older generation cannot submit orders. Revalidate the newest healthy book and current portfolio after a response arrives. Use bounded queues. If ingestion overruns, recording fails, or disk space runs out, mark the coverage failure and pause new simulated orders rather than silently dropping data and reporting a continuous test. Expose these failures independently of model health.

Decisions, orders, and fills must reference durably recorded source events, not a buffer that can disappear after settlement. Define durable recording watermarks, atomic segment finalization and manifests, and recovery of partial segments. Include recorder delay in event availability. If evidence persistence fails, stop accepting dependent actions while preserving the transactional portfolio journal.

## 5. Public market data

Start with one well-tested Coinbase Advanced Trade adapter. Its public market-data WebSocket endpoint is `wss://advanced-trade-ws.coinbase.com`; most market channels are available without authentication. Subscribe promptly and handle each channel according to the current published contract. Do not connect to the private user-order endpoint in paper mode. [WebSocket overview](https://docs.cdp.coinbase.com/coinbase-app/advanced-trade-apis/websocket/websocket-overview)

Required implementation behavior:

1. Fetch product metadata and validate product identity, increments, minimum/maximum quantities and notionals, status, and trading restrictions. Freeze the applicable metadata with each session and record subsequent changes.
2. Consume Level 2 snapshots and updates, heartbeats, and trades. Normalize prices and quantities without losing precision. Maintain bids and asks independently.
3. Apply `new_quantity` as the absolute size at that level, not an additive delta; zero removes the level. The subscription channel and received message channel need not have identical names. Validate actual schemas with recorded fixtures. [Level 2 reference](https://docs.cdp.coinbase.com/api-reference/advanced-trade-api/websocket/level2)
4. Track connection epochs. On a required sequence gap, invalid snapshot, crossed book, excessive clock skew, or stale connection, reject new risk, discard the unreliable book, reconnect with bounded backoff, and wait for synchronization.
5. Coinbase's documentation currently differs on whether sequence counters are connection- or product-scoped. Resolve the adapter's behavior against the [current machine-readable specification](https://docs.cdp.coinbase.com/api-reference/advanced-trade-api/advanced-trade-asyncapi.json) and live read-only conformance capture. Never compare counters from different sockets or reconnect epochs. Treat uncertainty as unhealthy data rather than silently continuing. Conformance is a release gate before enabling simulated fills.
6. Do not infer aggressor direction directly from a trade `side` field without verifying its venue meaning; maker-side labels can invert this interpretation.
7. Separate last-trade price, best bid, best ask, midpoint, available depth, event time, and receipt time. A current-looking last price is not a guarantee of executable liquidity.
8. Use UTC internally. Detect duplicate and out-of-order messages. Do not mix venue prices into one synthetic executable book.
9. Historical REST candles are useful for warmup and candle research, not reconstruction of historic bid/ask, depth, or queue position. Paginate documented limits, persist provenance, and do not invent missing candles or order-book history.
10. Expose feed age, synchronization state, reconnects, gaps, book depth, and recording gaps to the user and risk engine.

Paper network access must use an allowlist of **method plus path plus host**. Public and private exchange APIs can share a host. Permit only required public `GET` resources and the public WebSocket; reject order creation, cancellation, transfers, and private-account routes. Tests must verify zero authenticated exchange calls and zero exchange mutation requests in paper mode, even when credential-shaped environment variables are present.

Use these documented public REST resources beneath `https://api.coinbase.com/api/v3/brokerage`, subject to implementation-time verification:

| Purpose             | Public GET path                                                                     |
| ------------------- | ----------------------------------------------------------------------------------- |
| Product constraints | `/market/products/BTC-USD`                                                          |
| Book sanity check   | `/market/product_book?product_id=BTC-USD&limit=50`                                  |
| Recent trades       | `/market/products/BTC-USD/ticker?limit=100`                                         |
| Candle warmup       | `/market/products/BTC-USD/candles` with explicit start, end, granularity, and limit |

Public REST responses are cached for one second, so use the synchronized WebSocket for execution inputs. The REST book does not document a sequence bridge into this WebSocket stream; do not splice a REST snapshot into buffered updates without proving alignment. Use its book for diagnostics and use the WebSocket snapshot for reconstruction. [REST endpoints](https://docs.cdp.coinbase.com/coinbase-app/advanced-trade-apis/rest-api), [public product book](https://docs.cdp.coinbase.com/api-reference/advanced-trade-api/rest-api/public/get-public-product-book)

REST candle requests currently return at most 350 buckets per request. WebSocket candles use five-minute buckets. Build pagination and complete-bar validation rather than assuming unlimited history. [Public candles](https://docs.cdp.coinbase.com/api-reference/advanced-trade-api/rest-api/public/get-public-product-candles), [WebSocket channel catalog](https://docs.cdp.coinbase.com/coinbase-app/advanced-trade-apis/websocket/websocket-endpoints)

## 6. Portfolio, simulated execution, and risk

### Accounting

- Maintain available/reserved USD and BTC separately. Quantize using the product's increments; reserve enough quote currency for buy fees.
- Choose and document a cost-basis method, such as weighted average. Track realized and unrealized PnL separately.
- Journal fees in their actual modeled currency. Never deduct both a fill fee and a second implied copy of that fee.
- Keep trading PnL and all-in operating PnL separate. Report known model/data costs; unknown costs remain unknown, not zero.
- Report a transparent marked equity series and an estimated executable liquidation value. If data is stale, label valuation stale; do not fabricate a current price.
- Use identical valuation and execution assumptions for comparisons, including the initial entry and final liquidation convention.

### Initial market-order model

The first credible release can support market orders only. Add resting limits after the market-order and accounting tests pass.

For a submitted order, record the actual decision completion time and an explicit additional execution delay. Fill only against an eligible book state available at or after simulated order arrival. Do not fill using the decision bar's closing price or a prior book snapshot that predates arrival.

Walk asks for buys and bids for sells. Consume level quantities, record each partial fill and fee, and cancel the unfilled remainder under the documented IOC model. Reject insufficient depth, invalid instrument quantities, or prices beyond a configured execution guard. If you model additional adverse slippage, document how it relates to observed depth. **Do not charge spread twice:** buying at ask and selling at bid already includes spread.

Simulated fills must not alter the source exchange feed. Track liquidity consumed by our own simulated orders within the execution model so concurrent orders cannot repeatedly fill against the same unchanged observed depth. Adopt a documented replenishment rule and flag the missing counterfactual market impact. Cap simulated participation and test worse liquidity scenarios.

Account for real model latency and conservative execution delay. Fast historical tests must not make an LLM's decision instantaneous. Retrospective model outputs may be replayed to reproduce an original run, but re-querying a model is a new experiment rather than deterministic replay.

For later limit-order support, a touched candle or touched quote is insufficient proof of a fill. Specify conservative queue-ahead and trade-through assumptions, partial fills, cancel races, and expiry. Public aggregate book data cannot establish exact queue position. Report this uncertainty explicitly. Broker paper systems themselves document important simulation omissions such as impact, latency slippage, and queue position. [Alpaca paper-trading limitations](https://docs.alpaca.markets/us/docs/paper-trading)

### Fees

Require explicit, versioned maker/taker assumptions and a source/as-of date. Initial market orders use the taker assumption. Do not copy Coinbase Exchange/Pro fees into an Advanced Trade configuration or treat example API values as actual account fees. Advanced Trade fees depend on the applicable account/product tier; the authenticated transaction summary can support a later account-specific check. Run cost stress scenarios around the assumed rate. [Advanced Trade fees](https://help.coinbase.com/en/coinbase/trading-and-funding/advanced-trade/advanced-trade-fees), [transaction-summary API](https://docs.cdp.coinbase.com/api-reference/advanced-trade-api/rest-api/fees/get-transaction-summary)

### Deterministic risk controls

Enforce limits before submission and revalidate current market conditions immediately before execution. The model cannot override a rejection. Include maximum position exposure, maximum order notional, available funds, maximum open reservations, rate of orders, spread/depth limits, intent expiry, feed health, daily loss, session drawdown, and operating-cost budget.

Illustrative paper defaults: maximum 20% BTC exposure, maximum 5% of session equity per order, pause new risk after a 2% UTC-day equity loss or 5% session drawdown. These values are placeholders to make implementation testable. Make them explicit, configurable, and frozen per session; do not present them as suitable live-account limits.

Specify whether limits include pending orders and fees; they should. Track day-start equity persistently across restarts and define drawdown from the high-water mark. Invalid outputs, timeouts, unavailable models, stale snapshots, and unknown state produce no new order. Holding an existing position is not the same as flattening it.

`pause` and `stop` disable new decisions and cancel outstanding simulated orders under documented rules. They retain inventory. An explicit paper `flatten` control may submit a separately recorded simulated liquidation once healthy executable data exists. A stale feed must not produce a fictional liquidation price.

## 7. Strategies and model behavior

Implement controls before the LLM candidate:

1. All cash, starting at the same time and capital.
2. BTC buy-and-hold, with entry/exit costs, as a market reference.
3. A matched-exposure BTC control using the candidate's permitted exposure budget.
4. One simple, fixed deterministic strategy, such as a predeclared trend rule. Its inclusion is a testing control, not a claim of profitability.

The LLM receives a bounded snapshot of causal features, available/reserved balances, current exposure, open orders, execution assumptions, risk limits, and completed bars. Give it API-provider access only: no shell, file editing, exchange credentials, arbitrary URLs, or coding tools. Reject CLI strategy providers in trading configuration; a prompt telling a host-process CLI not to edit files is not this isolation boundary. Validate output strictly with Zod; timeout, malformed output, invented snapshot references, or an expired decision produces `hold` and a recorded reason.

Use deterministic code to turn target weight into an executable quantity. Apply a minimum rebalance threshold to avoid fee-driven churn, and record why a target does not produce an order. LLM confidence is explanatory metadata, not calibrated evidence of expected profit.

Freeze the prompt, model route, strategy parameters, and decision cadence for an evaluation. Record any fallback model. An unexpected model change must pause a qualification experiment or start a separately labeled version; do not combine results as if the same strategy produced them. Never let the running candidate edit its own policy, tests, or score thresholds.

Historical LLM research has an additional limitation: a model may already know outcomes from its training data. Chronological slicing alone cannot remove that knowledge. Treat such results as exploratory and rely on untouched prospective paper observations for the candidate's main evidence.

## 8. Evaluation and readiness report

Create a registry of every experiment, including failures, abandoned variants, and parameter searches. Keep development, validation, and final held-out periods chronological. Fit any scaler or learned feature on past data only, purge overlap when labels or holding windows overlap, and reserve the final period from repeated tuning. Ordinary shuffled cross-validation is inappropriate for time-ordered outcomes. [Time-series splitting guidance](https://scikit-learn.org/stable/modules/generated/sklearn.model_selection.TimeSeriesSplit.html)

At minimum report:

- Starting cash, deposits/withdrawals if ever supported, ending cash/BTC, realized/unrealized PnL, fees, estimated liquidation value, and all-in operating PnL.
- Net return, time in market, exposure, turnover, completed round trips, open positions, maximum drawdown, and daily returns.
- Win rate with average win/loss and profit factor; mark undefined or infinite statistics explicitly.
- Absolute performance against cash and excess performance against the predeclared matched-exposure control; also show unrestricted BTC buy-and-hold for context.
- Rejections, partial fills, timeouts, feed outages, unknown costs, reconciliation discrepancies, and all model/provider changes.
- Sensitivity to worse fees, additional latency/slippage, thinner liquidity, and dropped/stale market segments.

For a 24/7 asset, document the UTC day boundary and annualization convention if reporting Sharpe. Do not annualize a tiny run into an earnings forecast. Use uncertainty estimates appropriate to serially dependent returns, such as a predeclared block bootstrap over daily returns with an explicit block length and sensitivity analysis. A hundred fills are not a hundred independent observations.

Keep selection bias visible. Trying many strategies and reporting only the winner overstates evidence; record all trials and, when sufficient data exists, assess multiple-testing adjustments such as the Deflated Sharpe Ratio. Do not calculate these methods when their assumptions or required inputs are missing. [Original backtest-overfitting research](https://www.davidhbailey.com/dhbpapers/backtest-prob.pdf), [Deflated Sharpe Ratio research](https://www.davidhbailey.com/dhbpapers/deflated-sharpe.pdf)

### Proposed qualification policy

Freeze the policy before the qualification period. The following thresholds are conservative engineering proposals for this project, not a scientific guarantee or a declaration that real money is safe.

| Gate                 | Required evidence                                                                                                                                                             |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Correctness          | Acceptance suite passes; no ledger discrepancy, duplicate settlement, unauthorized endpoint, or risk bypass                                                                   |
| Provenance           | Strategy, model, data, fee/fill assumptions, and costs identified; replay reproduces recorded outcomes                                                                        |
| Observation floor    | Initially require at least 60 calendar days of untouched forward observation and 100 completed round trips; insufficient frequency means continue observing, not force trades |
| Continuity           | No unexplained gaps; interruptions disclosed; a minimum continuous segment and coverage requirement fixed before the run                                                      |
| Net economics        | Positive net trading and all-in operating PnL; measured against the predeclared objective and controls                                                                        |
| Uncertainty          | Predeclared interval for the relevant excess-return metric supports the stated claim; otherwise classify as insufficient evidence                                             |
| Robustness           | Remains within the drawdown budget under specified cost/liquidity stresses and is not supported solely by a few outliers                                                      |
| Operational behavior | Reconnect, restart, cancellation, disk failure, slow model, and duplicate-message drills pass                                                                                 |
| Human review         | All assumptions and unresolved differences from real execution are visible; no automatic promotion                                                                            |

The floor does not establish adequate statistical power, market-regime coverage, or independent observations. Keep `insufficient_evidence` as a normal result even after the minimum duration. If the objective is lower drawdown rather than beating buy-and-hold, define that mandate before evaluation; do not change the objective after seeing the result.

For a claim of positive excess return, the initial uncertainty rule should require a predeclared one-sided 95% lower confidence bound above zero using dependence-aware sampling. Show assumptions and sensitivity to block length. This rule can still be unreliable with too little or unrepresentative data; missing prerequisites produce insufficient evidence rather than a forced pass.

Readiness must produce findings and linked evidence, not a single unexplained green score. It never changes a broker mode or grants access to funds.

Return two separate verdicts: `operationalCorrectness: pass|fail` and `strategyEvidence: not_ready|insufficient_evidence|eligible_for_human_review`. Show the individual hard-gate results alongside them. An application can be operationally correct while its strategy loses money; a profitable-looking strategy with faulty accounting fails operational review.

## 9. Dashboard, CLI, and MCP deliverables

Add a **Paper trading** dashboard view with an unmistakable `PAPER — SIMULATED FUNDS` label and these sections:

- Venue/product, latest trade, bid/ask, spread, feed age, synchronized/degraded state, recording coverage, and UTC timestamps.
- Initial/available/reserved cash, BTC quantity, exposure, net trading PnL, all-in PnL, drawdown, fees, and operating-cost completeness.
- Equity and control curves with consistent time axes and valuation assumptions.
- Order/fill blotter: decision time, submission/arrival/fill times, side, requested/filled quantity, price, fee, remaining amount, status, and reject reason.
- Decision explanation linked to exact snapshot, model/version, risk checks, and immutable audit events.
- Qualification progress and findings, including `insufficient_evidence` and uncertainty.
- Start, pause, resume, stop, and explicit simulated flatten controls. Starting over creates a new session.

Proposed commands, to be implemented rather than assumed present:

```text
node dist/cli.js paper start --config config/trading.paper.local.yaml
node dist/cli.js paper status SESSION_ID
node dist/cli.js paper pause SESSION_ID
node dist/cli.js paper resume SESSION_ID
node dist/cli.js paper stop SESSION_ID
node dist/cli.js paper replay DATASET_ID --config config/trading.paper.local.yaml
node dist/cli.js paper report SESSION_ID --output artifacts/trading/SESSION_ID
```

Implement a real subcommand parser for these arguments; the current CLI parser does not support arbitrary new flags. Control commands should attach to the daemon when a trading runtime already owns that database. Offline replay gets its own experiment database and must not claim the live paper session's lease.

Provide bounded `paper_start`, `paper_status`, `paper_pause`, `paper_resume`, `paper_stop`, and `paper_report` MCP tools in an opt-in toolset. Return compact status and paginated evidence. Validate all paths and IDs. No exchange-order RPC or live activation belongs in this paper toolset.

Export a human-readable HTML report, machine-readable JSON, CSV order/fill and valuation records, and an evidence manifest. Include the config hashes and uncertainty/assumption disclosures in the export. Keep private keys, credentials, and secrets out of logs, reports, browser state, source control, and prompts.

## 10. Implementation sequence and completion gates

Each phase must produce working code, meaningful tests, and updated run instructions. Do not complete a phase with mocks standing in for the production behavior named in its acceptance gate.

| Phase                    | Build                                                                                                          | Acceptance before proceeding                                                                                              |
| ------------------------ | -------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| 0. Contracts             | Types, config, ownership, frozen session identity, architecture decision record, protected acceptance fixtures | Paper-only config rejects live mode; dependency boundaries are testable; no credentials needed                            |
| 1. Ledger                | Exact amounts, balances/reservations, orders/fills, atomic journal, recovery                                   | Hand-calculated trade/fee examples reconcile; replay and duplicate delivery cannot create money or inventory              |
| 2. Market recorder       | Public adapter, metadata, L2 book, heartbeats/trades, storage, health                                          | Fixture and optional read-only live smoke demonstrate book sync, precision, gap detection, no private requests            |
| 3. Execution and risk    | Market IOC fills, depth/latency, fees, risk vetoes, restart/cancel behavior                                    | Deterministic replays match expected fills; stale/insufficient/duplicate/over-budget orders fail correctly                |
| 4. Strategy runtime      | Controls, causal features, deterministic candidate, bounded LLM adapter                                        | Candidate can trade a fixture end to end; malformed/slow/unavailable models produce no unauthorized action                |
| 5. Research engine       | Replay, chronological splits, experiment registry, costs, controls, uncertainty                                | Known synthetic profitable and losing strategies are scored correctly; no lookahead; all failed trials retained           |
| 6. Product surfaces      | Daemon integration, CLI/MCP, dashboard, reports                                                                | One documented command launches a paper experiment; browser controls, state persistence, and exports work                 |
| 7. Forward qualification | Frozen real-feed paper experiment and operational drills                                                       | Reports accumulate genuine prospective results; insufficient duration stays insufficient; no fabricated long-run evidence |
| 8. Live bridge           | Separate adapter, reconciliation, authenticated read-only checks, explicit arming design                       | Fake-transport contract tests pass; live order submission remains disabled until separate user activation                 |

Phases 1–3 are deterministic and should be verified before relying on any LLM output. UI work can proceed once contracts stabilize. A real 60-day observation requires 60 days; automated tests may verify qualification logic using synthetic timestamps, but those fixtures must never be presented as an actual qualification run.

If using LLM-Swarm to implement the plan, create scoped check commands for the ledger, feed, execution/risk, strategy, integration, and UI areas. Configure `protectedPaths` for independent acceptance fixtures. Use `verificationChecks` with explicit dependencies and disjoint file ownership; inherited checks rerun before handoff. Keep a complete integration gate. The framework's task verification proves implementation checks passed, not that a strategy has an economic edge.

## 11. Required adversarial acceptance tests

Use recorded exchange messages and fake clocks/transports in CI. Network smoke tests must be opt-in, read-only, and separate from the ordinary suite.

1. Buy then sell at unchanged bid/ask: equity falls by spread plus fees, not zero and not double-counted spread.
2. The market rises slightly but the round trip still loses after costs; the report must show the loss.
3. A loss-making candidate is correctly identified while BTC buy-and-hold wins, and vice versa under a different explicit fixture.
4. Partial fills consume depth, preserve outstanding quantity, and release only appropriate reservations on cancellation.
5. Two orders cannot spend the same USD or sell the same reserved BTC.
6. Duplicate orders/events/fills and retries after timeouts settle once; crash at every journal boundary preserves invariants.
7. Dust, minimum notional, product increments, fee rounding, insufficient fee reserves, and extreme prices behave correctly.
8. Book update absolute quantities, zero removals, maker-side trade labels, sequence scope, gaps, reconnect epochs, and crossed books have fixtures.
9. An incomplete bar, future event, or subsequently revised value cannot enter an earlier decision snapshot.
10. No fill predates the decision completion and simulated arrival; no fill occurs in an unobserved outage.
11. Slow models, stale intents, provider failover, malformed JSON, extreme target weights, and invented snapshot IDs cannot bypass risk.
12. Pause/stop/cancel during partial fill and restart does not silently flatten holdings or duplicate orders.
13. Editing strategy/model/fees/risk policy creates a new experiment version; prior results retain their original identity.
14. Cost reporting never substitutes zero for unavailable token/data charges; qualification cannot claim all-in profitability from incomplete cost evidence.
15. Paper mode refuses all authenticated/private exchange operations and every live configuration, including when exchange credentials exist in the environment.
16. Dashboard mode labels, controls, escaped external content, reports, and desktop/mobile layouts work in Playwright.
17. A short profitable fixture remains insufficient evidence; failed loss/stress gates cannot be overridden by the LLM or dashboard.
18. Recorded replay with the same events, config, recorded decisions, clock rules, and seed yields the same canonical financial journal and report-content hashes. Canonicalize event identities/ordinals and exclude export timestamps, machine paths, new replay-session IDs, and other run metadata from the comparison; retain that metadata separately for audit.
19. A deliberately blocked model call cannot stop book ingestion or pause/stop controls; a late response after a lifecycle change cannot place an order.
20. Queue saturation, recorder failure, and disk exhaustion pause new orders, preserve ledger consistency, and produce visible observation gaps.

Add generated/property tests for accounting conservation and idempotency. Keep fixture expected results independently calculated rather than generated by the same implementation under test.

## 12. Later controlled live-account transition

Design the broker interface now so strategy, sizing, risk, and reporting can be reused. Add live activation as a separate later workflow, not a hidden boolean or an automatic result of paper profit.

Required sequence:

1. User chooses an eligible venue/account and explicitly requests live activation.
2. Verify account/product metadata, actual fees, permissions, balances, and order constraints through the venue's current API documentation and authenticated read-only calls.
3. Use least-privilege credentials with withdrawals/transfers disabled; keep them outside the model and browser. Use a dedicated account/portfolio when supported.
4. Run a shadow stage that records intended orders and validates adapter/reconciliation behavior without submitting them.
5. Produce a dated approval artifact binding account, strategy/model hash, risk limits, maximum authorized capital, allowed product, broker identity, and operator.
6. Start a new, empty live session from real account balances. Never import simulated balances, pending orders, fills, or PnL into it.
7. Require a local explicit arming action. On restart, default to disarmed until account reconciliation succeeds and the configured operator policy permits resumption.
8. Begin only with the user's separately approved small canary limits. Compare actual fills, fees, rejects, and latency with the paper assumptions before any increase.

A live adapter must handle ambiguous submit outcomes: persist a client order ID before sending; after a timeout, query/reconcile rather than blindly resubmitting. Reconcile open orders, fills, balances, reservations, and manual account activity on startup and continuously. Unknown state pauses new orders. Cancellation is a request until acknowledged; a pending cancel can still fill. The kill switch must have explicit cancel/hold/flatten semantics and independent tests.

Live infrastructure tests use fake transports and sandbox schemas where appropriate. A sandbox's success does not supply market-performance evidence. Neither Claude Code nor the trading model may create its own authorization artifact, approve a larger capital limit, or promote a paper session automatically.

## 13. Definition of done and verification commands

The first delivery is done when a new user can follow the documentation to start a genuine live-data paper session, watch its simulated trades, stop and restart it, replay captured evidence, and export an honest performance report. It must also operate with a deterministic strategy while all LLM providers are unavailable.

Required project checks:

```text
npm run format:check
npm run lint
npm run typecheck
npm run build
npm test
```

Add a documented trading acceptance command and browser-test command. All existing coding-swarm tests must continue to pass. Read-only live feed tests must verify connection/schema behavior without claiming they test profitability; no real order calls belong in CI.

Before declaring completion, provide changed files, architecture decisions, exact commands used, test results, a real short paper-session export, a deterministic replay export, cost/fill assumptions, and remaining limitations. If a venue feed is unavailable, preserve that blocker honestly; do not substitute generated prices and label the run live.

## 14. Copy-and-paste assignment for Claude Code

Use the following prompt from the repository root:

> Read `docs/plans/bitcoin-paper-trading-plan.md` completely and implement phases 0–7 as a working Bitcoin paper-trading subsystem in this repository. Inspect the current code and repository instructions first; preserve the coding swarm, daemon, MCP, and dashboard features. Use production public Bitcoin market data with simulated funds and order execution. Keep the first implementation strictly paper-only and require no exchange trading credentials.
>
> Start with domain contracts, exact portfolio accounting, and independent acceptance tests. Implement the public-data adapter, conservative execution/risk engine, deterministic controls, bounded optional LLM strategy, replay/evaluation, and user-facing controls in the documented dependency order. Verify current exchange schemas against the linked official documentation. Do not substitute candle-close fills for executable prices, omit fees, fabricate live data, or call a short profitable run proof of readiness.
>
> Use the same strategy/risk interfaces across forward paper and recorded replay. Persist evidence and configuration identity so every balance and fill is explainable and recoverable. Keep the model unable to alter balances, limits, verifiers, or execution mode. Use scoped protected checks if delegating implementation through LLM-Swarm.
>
> Implement and test qualification logic, but do not claim that the required long observation period has already elapsed. Supply actual short-run live-data evidence, reproducible replay evidence, the dashboard, reports, and complete run instructions. Treat `insufficient_evidence` as a valid outcome. Document the phase-8 live-adapter boundary and activation workflow; real account connection, funding, and order submission require a separate future human request.
>
> Continue through the authorized paper implementation, fix failures, and run formatting, lint, types, build, unit/integration, trading acceptance, and browser checks. Report concrete results and remaining blockers. Do not push or publish unless I explicitly ask you to.

## Sources and implementation-time recheck

These documents were consulted on October 31, 2026. Recheck them when implementing exchange-specific behavior; examples are not account-specific fee quotes or guarantees of execution.

- [Coinbase Advanced Trade WebSocket overview](https://docs.cdp.coinbase.com/coinbase-app/advanced-trade-apis/websocket/websocket-overview)
- [Coinbase WebSocket endpoints](https://docs.cdp.coinbase.com/coinbase-app/advanced-trade-apis/websocket/websocket-endpoints)
- [Coinbase Level 2 reference](https://docs.cdp.coinbase.com/api-reference/advanced-trade-api/websocket/level2)
- [Coinbase heartbeats reference](https://docs.cdp.coinbase.com/api-reference/advanced-trade-api/websocket/heartbeats)
- [Coinbase machine-readable WebSocket specification](https://docs.cdp.coinbase.com/api-reference/advanced-trade-api/advanced-trade-asyncapi.json)
- [Coinbase public REST endpoints](https://docs.cdp.coinbase.com/coinbase-app/advanced-trade-apis/rest-api)
- [Coinbase public product metadata](https://docs.cdp.coinbase.com/api-reference/advanced-trade-api/rest-api/public/get-public-product)
- [Coinbase public product book](https://docs.cdp.coinbase.com/api-reference/advanced-trade-api/rest-api/public/get-public-product-book)
- [Coinbase public candles](https://docs.cdp.coinbase.com/api-reference/advanced-trade-api/rest-api/public/get-public-product-candles)
- [Coinbase Advanced Trade sandbox](https://docs.cdp.coinbase.com/coinbase-app/advanced-trade-apis/sandbox)
- [Coinbase Advanced Trade fees](https://help.coinbase.com/en/coinbase/trading-and-funding/advanced-trade/advanced-trade-fees)
- [Coinbase transaction-summary API](https://docs.cdp.coinbase.com/api-reference/advanced-trade-api/rest-api/fees/get-transaction-summary)
- [Alpaca's documented paper-trading limitations](https://docs.alpaca.markets/us/docs/paper-trading)
- [Time-series splitting guidance](https://scikit-learn.org/stable/modules/generated/sklearn.model_selection.TimeSeriesSplit.html)
- [The Probability of Backtest Overfitting](https://www.davidhbailey.com/dhbpapers/backtest-prob.pdf)
- [The Deflated Sharpe Ratio](https://www.davidhbailey.com/dhbpapers/deflated-sharpe.pdf)
