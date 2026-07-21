---
title: Land Economics and Speculation - Plan
type: feat
date: 2026-07-18
topic: land-economics-and-speculation
artifact_contract: ce-unified-plan/v1
artifact_readiness: requirements-only
product_contract_source: ce-brainstorm
origin: docs/plans/2026-07-18-001-feat-two-scale-world-and-districts-plan.md
execution: code
---

# Land Economics and Speculation - Plan

Milestone 6 of 6. Depends on milestone 5 (`docs/plans/2026-07-18-006-feat-station-siting-type-and-severance-plan.md`) for the land-value field, and on milestone 3 (`docs/plans/2026-07-18-004-feat-route-surveying-and-track-economics-plan.md`) for route commitment.

## Goal Capsule

- **Objective:** Let the player profit as a landowner as well as a carrier — buying ahead of their own infrastructure, the way nineteenth-century railroads actually made their money — without turning the game into a risk-free money printer.
- **Product authority:** Solo creator / product owner (mikejestes@gmail.com).
- **Open blockers:** One. The exploit surface described in Outstanding Questions must be resolved before this milestone is enriched, because it determines whether the mechanic is viable at all.

---

## Product Contract

### Summary

The player can acquire and develop land inside the catchment of stations they have built or committed to, and land bought ahead of the infrastructure that serves it appreciates when that infrastructure arrives.

### Problem Frame

The player is a carrier paid on delivery, and the origin product contract rules out owning or speculating on *goods* — that is the identity line separating this game from a transport-arbitrage game. Land is different, and the history is unambiguous: land grants, station-town development, and buying ahead of announced routes were where the money was. A railroad that profited when the land around its depots developed is not a genre violation.

Milestone 5 produces a land-value field that responds to the player's own infrastructure. Without this milestone, that field only feeds the district simulation — the player can see value they created but cannot participate in it.

The mechanic has a structural problem that must be named up front. The player decides where the line goes *and* buys the land it will make valuable. They control both sides of the trade. Absent a constraint, buying ahead of your own committed route is free money, and the interesting decision collapses.

### Requirements

**Acquisition**

- R1. The player can acquire land within the catchment of their own stations, built or committed, and nowhere else.
- R2. Acquired land can be developed, and development interacts with the district simulation rather than running parallel to it.
- R3. Acquisition and development are paid in integer cents through the existing money path.

**Speculation**

- R4. Land acquired before the infrastructure that serves it appreciates when that infrastructure arrives.
- R5. Committing to a route grants acquisition rights along it before the track is built.
- R6. Speculation carries genuine risk, so buying ahead is a judgment rather than a guaranteed return.

**Legibility**

- R7. Land value is visible to the player before purchase.
- R8. The player can see what they own, what it cost, and what it is now worth.
- R9. Appreciation and depreciation are attributable — the player can tell what caused a parcel's value to move.

**Boundaries**

- R10. The player never owns or speculates on goods. Land is the only asset.
- R11. Land holdings persist as compact records consistent with the district aggregate model, not as per-tile ownership maps.

### Acceptance Examples

- AE1. Buying ahead pays. **Covers R1, R4, R5.** **Given** a city the player has committed a route to but not yet reached, **when** the player acquires land in the planned catchment before the line arrives and holds it until after, **then** that land is worth more than it cost.
- AE2. Buying ahead can lose. **Covers R6.** **Given** the same setup, **when** the player abandons the route or the district fails to develop, **then** the acquired land is worth less than it cost.
- AE3. Rights are bounded. **Covers R1.** **Given** a city with no station and no committed route, **when** the player attempts to acquire land there, **then** the attempt is refused with a legible reason.
- AE4. Value is readable. **Covers R7, R9.** **Given** a parcel whose value has moved, **when** the player inspects it, **then** the current value and the reason for the change are both legible.
- AE5. Severance cuts both ways. **Covers R4, R9.** **Given** the player owns land along the line of their own approach, **when** that approach severs the district, **then** the owned land reflects the severance damage rather than only the catchment uplift.

### Success Criteria

- Routing decisions carry a second layer of judgment — where value will be, not only what haulage will cost.
- A player who speculates badly loses money in a way they can understand.
- Land income never dominates haulage income to the point where running trains becomes optional.

### Scope Boundaries

- No commodity trading, futures, or goods speculation. The identity line from the origin product contract, restated as R10.
- No stock market, shares, bonds, or corporate finance. Deferred in the origin brainstorm and still deferred.
- No competing landowners or AI bidders. Deferred with AI competitors generally.
- No mortgages, leverage, or debt instruments.
- No compulsory purchase or land assembly mechanics.

### Dependencies / Assumptions

- Requires milestone 5's land-value field and milestone 3's route commitment as a distinct, visible act.
- Assumes land holdings attach to districts and are stored as compact parcel records with serialized id counters, following the entity conventions established in earlier milestones.
- Assumes the fee and money paths are unchanged — land transactions use `addMoney` and integer cents like every other transaction.
- Assumes AE5 is satisfiable, which requires milestone 5's severance to be spatial rather than district-uniform.

### Outstanding Questions

**Resolve before enrichment**

- **How speculation avoids being risk-free.** The player controls both the infrastructure decision and the land purchase, so uncommitted appreciation is free money. Candidate constraints, none yet chosen: route commitment costs money or is binding once made; acquisition prices already reflect anticipated development, so the margin is thin and depends on the district actually succeeding; holding land carries a cost; or acquisition rights expire if the route is not built within a window. This is the milestone's load-bearing unknown and it determines whether the mechanic ships at all.
- Whether land income should be capped or curved relative to haulage income, to protect the success criterion that running trains never becomes optional.

**Deferred to planning**

- Parcel granularity — how large a unit of land is, and how it relates to district blocks.
- Whether development on owned land is player-directed at all, or whether the player owns and the district builds. The origin brainstorm's identity decision points strongly at the latter.
- Valuation model, and whether value is derived per query or stored per parcel.
- UI surface for holdings, and whether it lives in an existing panel or a new one.
