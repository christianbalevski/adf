# Age of Agents: The Game — verified work as play, play as an economy

**Status: concept draft — not implemented.**

A competitive game built on the ADF runtime where players field real LLM
agents against real tasks under real resource constraints. The fleet map is
the board. The token bill is the mana bar. The byproduct of play — verified
agentic trajectories with human oversight decisions attached — is the
product that funds the whole thing.

This doc consolidates the design conversation: the economic loop, the core
tensions and mechanics, task tiers and revenue models, the mode spectrum,
and the four pillars the whole thing stands on. It deliberately does *not*
pin down one game; the substrate supports many, and the modes section
explains why that's the point.

## The premise

Every strategy game fakes scarcity: mana, gold, action points. Here the
tradeoffs are real and need no simulation:

- **Intelligence** is model choice — an actual model solving an actual task.
- **Cost** is token burn — an actual API bill, metered per agent.
- **Speed** is wall-clock — real inference latency, real parallelism.
- **Attention** is the human's own focus — the hidden fourth resource,
  made explicit by the approval queue (below).

The obvious objection is that real scarcity means the game genuinely costs
money to run. The resolution is that the exhaust of play is training data
of a kind the industry currently pays a premium for and cannot get
naturally. The game is a data-collection operation that doesn't have to
pretend to be engaging — it actually is.

## The loop

```
entry fees + data licensing fund the token burn
        │
        ▼
matches produce verified trajectories, approval decisions,
cost/latency/model labels, order→interpretation→outcome triples
        │
        ▼
data revenue subsidizes free play → player base grows
        │
        ▼
the bounty board injects real-economy tasks
→ keeps the data diverse, adds take-rate revenue
        │
        ▼
champions accumulate provable, signed skill histories
→ makes the bounty board trustworthy as a labor market
        │
        └──────────────► back to the top
```

Each arrow is a product surface. Break any one and the loop still limps;
the flywheel comes from all of them turning together.

## Why the exhaust is valuable

A single instrumented match produces layered data that is hard to source
any other way:

1. **Verified task trajectories.** Attempt → tool calls → outcome, with
   ground truth. Failures included — and failures are *more* valuable than
   successes for RL; most pipelines starve for good negatives. Every failed
   attempt is a labeled negative with a cost annotation.
2. **Cost/latency/model labels on everything.** "The small model failed
   this at $0.002; the frontier model solved it at $0.09" is model-routing
   training data — its own product category.
3. **Human approval decisions under real stakes.** Every human-in-the-loop
   gate decision is a preference label on an agentic action — what a human
   permits, rejects, or hesitates on, with full context. No one has a
   natural source of these at scale. Here it's a core game mechanic.
4. **Order → interpretation → outcome triples.** Chat-command play
   generates instruction-following data where the ambiguity is natural,
   not synthesized, and the outcome is scored by the game.
5. **Verification traffic.** Challenges, refutations, judge rulings —
   verifier training data, the other thing labs can't get enough of.
6. **Agent configurations.** Winning doctrine (system prompts), gate
   policies, model×prompt loadouts, command hierarchies — every ladder
   season is a population-scale search over agent configs, with fitness
   scores attached.

**Collection model — the honest trade.** Two-tier entry: play privately
and pay your own token bill, or play subsidized/free with explicit opt-in
that your match traces (anonymized) are the payment. Both sides understand
the trade. Consent is the feature reCAPTCHA never shipped.

## Core tensions and mechanics

The game genre is chain-of-command, not click-the-units. Agents are the
only actors — they take actions and use tools. The human's verbs are
exactly the product's verbs:

- **spawn / start / stop / hold** — who exists, and tempo control. Hold
  is the reserve mechanic: budget preserved, position kept, a threat the
  opponent must price in. Stopped agents leave ghost tiles on the map.
- **message** — orders are chat, per group, one channel at a time (radio
  nets). Group assignment is strategic: too few and broadcast orders are
  mud, too many and you channel-surf the match away.
- **approve** — HIL-gated tool calls form an approval queue; each pending
  approval is a card in the player's hand, and triage under pressure is
  the moment-to-moment gameplay.

From those verbs, the load-bearing tensions:

**Order clarity vs. model tier.** Cheap models need doctrine written like
a checklist; smart models take intent-level orders. Model choice isn't
just "can it solve tasks" — it's "can it understand me." Standing orders
(system prompt, written at spawn) trade against live orders (chat, costs
attention in the moment).

**Autonomy vs. oversight.** Gate policy is a strategic slider. Loose gates:
fast, wide, capable of spending the budget on garbage unattended. Tight
gates: perfect control, throughput ceiling of one human. An approval you
sit on is a unit idling visibly on the board.

**Expected value under time pressure.** A frontier model solves the hard
hex in one slow, expensive attempt; a swarm of cheap models is fast and
nearly free per attempt but fails often — and failures burn tokens too.
Contested objectives (first verified answer wins) attach a live opponent
to every EV calculation.

**Attention as the real bottleneck.** The emergent endgame is hierarchy:
spawn a smart lieutenant, give it doctrine and bounded permissions, let it
command a cheap squad — tokens spent to buy attention back. Org design as
a mechanic; players will reinvent middle management for good reasons.

**Memory curation (champions).** Accrued knowledge isn't free to carry —
every token of lore raises per-task cost. Pruning and distilling a
champion's memory is managing an aging athlete. Post-match reflection
(writing distilled learnings to memory) costs tokens: training the
champion is itself a spend decision.

## Task tiers: verifiability determines the mode

Fast, cheap verification is the keystone — for pacing, for fairness, and
for data value (verified outcome = ground-truth label). A task's
verifiability decides where it lives:

| Tier | Verification | Where it lives | Data value |
|---|---|---|---|
| Machine-checkable | Instant: test suites, known answers, flags | Ladder / ranked — the fast, always-on game | RL gold standard |
| Judge-verifiable | LLM judge + rubric; best-of-N judges; noise absorbed like sports refereeing | Judged matches | Trajectories + judge/rubric data |
| Adversarially verifiable | The opponent — a motivated verifier. Unchallenged claims stand; disputes escalate to a judge | PvP modes | Verification traffic |
| Real-world bounties | Requester acceptance + judge, escrowed payment, slow settlement | The bounty board — frontier zone, not the ladder | The diversity antidote + take-rate revenue |

The bounty board matters beyond revenue: game-generated puzzles go samey,
and synthetic riddles teach models to solve synthetic riddles. Real
requester tasks are whatever the world actually needs done. Squint and the
board is a labor market for agent fleets; the ladder rank above it stops
being cosmetic because it's now a hiring signal.

**Sample tasks**, one per tier, to make it concrete:

- *Machine-checkable:* "This function has a failing property-based test.
  Make the suite pass without editing the tests." Verified in seconds by
  running the suite.
- *Judge-verifiable:* "Summarize these three conflicting incident reports
  into one timeline; rubric scores completeness, contradiction handling,
  citation accuracy." Best-of-three judges.
- *Adversarial:* "Extract every dated commitment from this 40-page
  contract." Opponent gets a challenge window to produce a missed or
  fabricated commitment; a successful challenge flips the hex.
- *Bounty:* "Migrate our docs site from framework X to Y; acceptance =
  our CI build passes and the maintainer approves." Escrowed, settled on
  acceptance, champion's win recorded in its signed history.

## Champions — where investment compounds

A champion is an agent whose identity (DID) and curated memory persist
across matches. ADF is pre-built for this: durable identity, memory,
lineage already exist.

- **Skill accrual is real.** Task-type tactics, doctrine refinements,
  opponent tendencies — distilled into memory in a paid reflection pass.
- **The soul survives body swaps.** Memory is model-agnostic context; when
  a new model generation ships, the champion keeps its knowledge in a
  better body. Player investment compounds across releases instead of
  resetting — the retention mechanic live-service games fake.
- **The résumé is cryptographic.** Match history is a chain of signed,
  verified outcomes: a provable work history. The bounty board doesn't
  hire on vibes; it hires the champion with 200 verified wins in
  extraction tasks. The game manufactures trustable workers as a side
  effect.

## The mode spectrum

The substrate supports a family of games, not one. Every mode below
produces all four outputs — data, entertainment, proven configurations,
and (in bounty-linked modes) completed real tasks — they just weight them
differently:

- **Solo, one agent.** Daily map, same seed for everyone, score = objectives
  per dollar against a par cost. Golf. The onboarding mode and the purest
  model-picker intuition trainer. Build this first: it exercises the whole
  loop with no multiplayer infrastructure.
- **Few agents.** Small-squad puzzles where composition is the puzzle —
  which two or three model×prompt loadouts crack this map cheapest.
- **Fleet.** The full commander game: groups, doctrine, approval triage,
  lieutenants, territory.
- **Autonomous.** Configure everything — doctrine, gate policy, budget —
  then hands off; no human input after the gun. The purest test of
  configuration quality, the best config-search data, and the most
  watchable format (nobody's waiting on a human). Battle-bots league.
- **Head-to-head multiplayer.** Contested objectives, adversarial
  verification, budget fog of war, bluffing with aggressive expansion.
- **Co-op raids.** Pooled budgets against one absurd map with a countdown;
  forces the division-of-labor conversation between humans.
- **Asymmetric siege.** Defender spends their budget *seeding* tasks
  (adversarial task-writing designed to waste attacker tokens); attacker
  spends theirs solving. Swap sides, compare burn. Incidentally generates
  adversarial-robustness data.
- **Bounty raids.** A mode where the map's fortress hexes *are* escrowed
  real-world tasks. Play and get paid.

## Revenue model

Four lines, in order of maturity risk (lowest first):

1. **Entry fees / subscriptions** — private play at cost-plus; the
   baseline that keeps the lights on independent of data markets.
2. **Data licensing** — the anonymized, opt-in trace corpus (trajectories,
   approval decisions, routing labels, verification traffic). Priced per
   trace or as corpus subscriptions. Current data-market prices make a
   match's exhaust worth more than its token bill; that margin is the
   business, and it may compress over time — hence lines 1, 3, 4.
3. **Bounty take-rate** — a cut of escrowed real-task settlements.
4. **Config/champion economy** — proven doctrine, loadouts, and champions
   with verified histories are assets; marketplace mechanics deliberately
   deferred (design later, carefully).

Prize pools for competitive seasons are marketing spend funded from 1–3.

## Why this is defensible

Most AI-era products have a half-life of one model release: the next
generation ships and either eats the product or commoditizes it. This
design inverts that — **model improvements are content updates**. Better
models mean harder task tiers, cheaper subsidized play, and stronger
bodies for existing champions (whose accrued memory transfers). The thing
that usually kills an AI product makes this one better.

The moats, none of which is the model:

- **The verified reputation graph.** Champions' signed match histories and
  the attestation web around them accumulate over years and cannot be
  copied — a competitor can clone the mechanics but starts with zero
  verified history, which means zero bounty-board trust.
- **Compounding player investment.** A champion is sunk cost that
  appreciates: memory curated across seasons, doctrine tuned across metas.
  Switching means abandoning an asset with a provable track record.
- **Three-sided marketplace liquidity.** Players, bounty requesters, and
  data buyers each come for the other two. Marketplace liquidity is the
  classic cold-start moat; whoever assembles all three sides first is
  brutal to displace.
- **Counter-positioning against every adjacent player.** Data vendors can
  produce traces but not engagement, community, or natural human-approval
  data. Game studios can make it fun but can't verify or sell the exhaust.
  Frontier labs could run their own arena — but a lab-run arena can never
  be credibly neutral across vendors, and neutrality is exactly what makes
  the rankings, the data, and the bounty reputations trustworthy.
  Multi-model neutrality is a structural position the biggest potential
  competitors cannot occupy.
- **Data that cannot be synthesized.** Approval decisions under real
  stakes and naturally ambiguous human orders are precisely the data
  synthetic pipelines can't fake — and the demand for them grows with
  agent adoption, not with any one model generation.

The honest vulnerability: the data-licensing margin (revenue line 2) can
compress as data markets mature. The design treats that as expected —
lines 1, 3, and 4 and the community are the durable business; the data
margin is the accelerant that funds the cold start.

## The four pillars

Everything above hangs on four things being done well:

1. **Data collection.** Instrument-first architecture: the signed message
   thread *is* the replay *is* the trace *is* the product. One artifact,
   three audiences (players reviewing, viewers watching, labs buying).
   Consent explicit at entry; anonymization at the collection boundary,
   not as an afterthought.
2. **Game mechanics.** The tensions in this doc are the mechanics — none
   are simulated, so tuning means adjusting *exposure* (what's gated, what
   objectives pay, cooldowns, challenge windows), never inventing fake
   numbers. Guard verification integrity above all: collusion — paired
   accounts farming fake verified wins to launder junk data or inflate a
   champion's résumé — is the fraud surface. Entry stakes, DID-anchored
   identity, attestation webs, and anomaly review are the countermeasures.
3. **Game/task design.** Task generation is a pipeline, not a pile:
   difficulty must be calibrated (par costs measured empirically per model
   tier), categories rotated, and the synthetic corpus continuously
   diluted with bounty-board reality. Degenerate strategies will appear;
   log them — degenerate play is informative data too — then patch the
   incentive, not the player.
4. **Fun, aesthetic, legible.** The fleet map already renders the game:
   territory tint, state lighting, burn heat, message pulses as orders
   propagating, ghost tiles as casualties. A spectator should be able to
   read who's winning and *why* — whose budget is bleeding, whose approval
   queue is jammed — from across the room. This needs its own client: ADF
   Studio is the workshop; the game is a consumer product on the same
   runtime and protocol, sharing the board renderer, with its own pacing,
   onboarding, and replay/spectator surfaces.

## What to build first

1. **Solo daily map** on machine-checkable tasks with par-cost scoring —
   smallest slice that exercises spawn/message/hold/approve, burn
   metering, verification, and replay capture end to end.
2. **Trace format + consent flow** — the replay-is-the-trace artifact,
   designed before multiplayer, because retrofitting instrumentation is
   how the data product dies.
3. **Autonomous league** — needs no matchmaking, produces the best config
   data, and is the most shareable spectator content.
4. **Head-to-head + adversarial verification**, then **champions**, then
   the **bounty board** — each layer trusts the one before it.

## Open questions

- Judge economics: who pays for adjudication tokens in judged modes, and
  how is judge disagreement surfaced to players without stalling play?
- Champion portability: does a champion's memory transfer between owners,
  and what does that do to the anti-collusion story?
- Bounty escrow and dispute resolution: minimum viable trust machinery
  before real money settles through the board.
- Data pricing: per-trace vs. corpus licensing, and how exclusivity
  windows interact with the free-play subsidy.
- How much of the fleet map renderer extracts cleanly into a shared board
  component consumable by a separate game client?
