---
title: City Districts and Organic Growth - Plan
type: feat
date: 2026-07-18
topic: city-districts-and-organic-growth
artifact_contract: ce-unified-plan/v1
artifact_readiness: requirements-only
product_contract_source: ce-brainstorm
origin: docs/plans/2026-07-18-001-feat-two-scale-world-and-districts-plan.md
execution: code
---

# City Districts and Organic Growth - Plan

Milestone 4 of 6. Depends on milestones 1 and 2. Independent of milestone 3 — districts and surveying can proceed in either order.

## Goal Capsule

- **Objective:** Give each station a district whose built form grows out of what the player's trains deliver, so the supply chain becomes visible as architecture and the street scale becomes a place rather than a zoom level.
- **Product authority:** Solo creator / product owner (mikejestes@gmail.com).
- **Open blockers:** None for planning. This is the milestone where the design's central bet — that watching a district respond is engaging — gets tested.

---

## Product Contract

### Summary

Add a per-district simulation whose state is a small aggregate record, and a street-level rendering that generates buildings from position and seed conditioned on that record. Delivered materials drive what the district becomes; district health feeds back into the traffic it generates.

### Problem Frame

The supply chain is the product's stated substance — the origin brainstorm calls it "the substance of using every resource type" — and it is currently invisible. A player can read a city's demand only by opening a panel. Nothing about looking at the map tells them what a city has been receiving or what it lacks.

The city model today is a single record with a size tier, a population number, and demand and backlog maps (`src/sim/model/cities.ts:8-27`). Growth is a scalar advancing through tiers. There is nothing spatial about a city, so there is nothing to look at when the camera arrives.

### Requirements

**District state and growth**

- R1. Each station has a district whose built form grows in response to goods delivered into that station.
- R2. Different delivered materials produce different built form, such that a player can infer from looking what has been shipped and what has been neglected.
- R3. District state persists as a compact aggregate — not as individual building records.
- R4. District growth is bounded. No accumulator grows without a ceiling.
- R5. Districts stagnate or decline when their station stops receiving what they need.

**District health**

- R6. District health derives from the generators of urban diversity — mixed uses, block granularity, building age variety, and density.
- R7. District health feeds back into the passengers, mail, and demand the district generates, so a healthy district is worth more to the player.
- R8. District health is legible to the player without opening a panel.

**Street rendering**

- R9. Street layout and building footprints are generated from position and seed, conditioned on district state, and never stored.
- R10. The street scale is reached by continuing to zoom, not by entering a separate view.
- R11. Zooming into a district the player has never visited produces full detail without growing the save.

**Player boundary**

- R12. The player never zones, designates land use, places buildings, or demolishes within a district.

**Integration**

- R13. District state reaches React through the existing store version channel; no second store and no derived-object snapshot.
- R14. New district entities carry serialized id counters; no module-global state and no non-JSON-safe sentinels.

### Acceptance Examples

- AE1. Built form reflects hauling. **Covers R1, R2.** **Given** two districts of equal size, one fed steel and manufactured goods and one fed only food, **when** the player zooms into each, **then** they are visibly different, and the difference corresponds to what was delivered.
- AE2. Health pays. **Covers R6, R7.** **Given** two districts of equal population, one with high diversity and one with low, **when** both are observed over the same period, **then** the healthier district generates more traffic.
- AE3. Neglect bites. **Covers R5.** **Given** a developed district, **when** its station stops receiving deliveries for a sustained period, **then** the district stops growing and begins to decline.
- AE4. Detail is free. **Covers R9, R11.** **Given** a save from a session with no zooming, **when** it is loaded and the player zooms to street level in several cities, **then** full detail appears and the save serializes to the same size.
- AE5. Growth is bounded. **Covers R4.** **Given** a district fed far beyond its needs for a long period, **when** its state is inspected, **then** every accumulator sits at or below its documented cap.

### Success Criteria

- A player can identify what a district has been receiving by looking at it.
- Watching a district respond to a new line is engaging on its own.
- District simulation cost does not scale with zoom depth or visited area.

### Scope Boundaries

- No station type, land value, severance, or relocation. Milestone 5 owns all of it; districts here respond only to what is delivered.
- No speculation or land acquisition. Milestone 6.
- No player verbs inside a district — restated as R12 because it is the constraint most likely to erode under implementation pressure.
- No individual buildings as durable, addressable objects. Buildings express district state.
- No road or traffic simulation. Streets are generated form, not a network.

### Dependencies / Assumptions

- Requires milestone 1's zoom tiers and milestone 2's field-generation approach; street generation is the same technique at a finer scale.
- Assumes district state attaches to stations rather than to cities, since the origin brainstorm ties development to station catchment. A city with two stations has two districts.
- Assumes the existing tick pipeline gains a district system, positioned after delivery and before or alongside growth, following the fixed-order rule.
- Assumes `docs/solutions/ui-bugs/react-frozen-ui-over-mutable-store-state.md` governs the React binding — mutate in the kernel, publish, let the version counter drive re-render. R13 exists because this milestone adds the most React-observable state of any so far.

### Outstanding Questions

**Resolve before enrichment**

- What district state consists of, concretely, and the mapping from delivered goods to built form. This is the milestone's core model and the origin brainstorm deliberately left it open.
- Whether district health modifies existing demand and supply generation in `src/sim/systems/production.ts`, or adds a parallel channel. The former keeps one code path; the latter is easier to tune independently.

**Deferred to planning**

- Street layout generation — grid, organic, or hybrid — and how it responds to terrain and the station's position.
- The street-tier zoom threshold and whether it needs a fourth tier.
- Whether decline is symmetric with growth or slower.
- How district state interacts with the existing city size tier and `demandForTier`.
