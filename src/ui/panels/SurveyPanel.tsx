import type { SurveyProposal } from '../../render/surveyController.ts';
import type { SurveyRefusalReason } from '../../sim/surveying.ts';
import type { StepCost, TrackStructure } from '../../sim/model/trackCost.ts';

/**
 * The survey panel (milestone 3 U6, R1-R5). Shows the live proposal a
 * `SurveyController` (`render/surveyController.ts`) is currently tracking:
 * an itemized cost breakdown and grade profile while the survey is
 * buildable, a human-readable refusal otherwise (AE4), with Commit/Cancel
 * always available while a survey is in progress.
 *
 * Per the repo's no-rendering-tests policy (KTD7), the component body below
 * is not itself unit-tested — `refusalMessage`, `summarizeSteps`, and
 * `structureBreakdown` are the pure content logic that carries the
 * coverage (`tests/ui/panels.test.ts`), matching the same split
 * `worldRenderer.ts`'s pure predicates already use.
 *
 * Milestone 6 (KTD1, R5): `onCharter` is an optional third action alongside
 * Commit/Cancel — "committing to a route" now has two forms (build it now,
 * or charter it: pay a fee, get corridor rights, build later within the
 * window). The button only appears when the proposal is buildable, the same
 * gate Commit already has; `main.ts` dispatches the exact `charterRoute`
 * intent, re-running the same survey (KTD2 of milestone 3) `applyIntent`
 * already re-runs for `commitRoute`.
 */

const REFUSAL_MESSAGES: Record<SurveyRefusalReason, string> = {
  'endpoint-on-sea': 'This route starts or ends in open water — pick a point on land.',
  'waypoint-on-sea': 'A waypoint sits in open water — move it onto land.',
  'no-path': 'No buildable path connects these points.',
};

/** Human-readable text for a survey refusal reason (AE4). Every reason in
 *  the closed union (`sim/surveying.ts`) maps to a distinct, non-empty
 *  message — never a generic "route failed". */
export function refusalMessage(reason: SurveyRefusalReason): string {
  return REFUSAL_MESSAGES[reason];
}

export interface SurveyItemization {
  baseCents: number;
  terrainCents: number;
  gradeCents: number;
  structureCents: number;
  landCents: number;
  totalCents: number;
}

/** Sum a proposal's per-step itemization into the category totals the panel
 *  displays (base / terrain / grade / structures / land), plus the grand
 *  total — which always equals the sum of the other five, since every field
 *  here is a straight sum of the same field across `steps` (U2's own
 *  itemization-completeness invariant, carried up one level). */
export function summarizeSteps(steps: StepCost[]): SurveyItemization {
  const sum = (pick: (s: StepCost) => number) => steps.reduce((n, s) => n + pick(s), 0);
  return {
    baseCents: sum((s) => s.baseCents),
    terrainCents: sum((s) => s.terrainCents),
    gradeCents: sum((s) => s.gradeCents),
    structureCents: sum((s) => s.structureCents),
    landCents: sum((s) => s.landCents),
    totalCents: sum((s) => s.totalCents),
  };
}

/** Per-structure-type cost breakdown (AE3): a bridge crossing a river must
 *  show up as its own named line item, not folded into a generic
 *  "structures" lump sum — this is what lets the panel say "Bridge: $X"
 *  distinctly from "Tunnel: $Y" when a proposal has both. */
export function structureBreakdown(steps: StepCost[]): Partial<Record<TrackStructure, number>> {
  const out: Partial<Record<TrackStructure, number>> = {};
  for (const step of steps) {
    if (!step.structure) continue;
    out[step.structure] = (out[step.structure] ?? 0) + step.structureCents;
  }
  return out;
}

function formatCents(cents: number): string {
  return `$${(cents / 100).toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
}

const STRUCTURE_LABELS: Record<TrackStructure, string> = {
  bridge: 'Bridge',
  tunnel: 'Tunnel',
  cutting: 'Cutting',
};

const panelStyle: React.CSSProperties = {
  padding: '8px 12px',
  borderRadius: 8,
  background: 'rgba(13, 27, 42, 0.85)',
  color: '#e0e1dd',
  font: '12px system-ui, sans-serif',
  width: 240,
};

const rowStyle: React.CSSProperties = { display: 'flex', justifyContent: 'space-between' };

export function SurveyPanel({
  proposal,
  onCommit,
  onCancel,
  onCharter,
}: {
  proposal: SurveyProposal | null;
  onCommit: () => void;
  onCancel: () => void;
  onCharter?: () => void;
}) {
  if (!proposal) return null;

  const button = (label: string, onClick: () => void, primary: boolean) => (
    <button
      onClick={onClick}
      style={{
        padding: '4px 10px',
        borderRadius: 6,
        border: '1px solid transparent',
        background: primary ? '#415a77' : 'rgba(65,90,119,0.4)',
        color: '#e0e1dd',
        cursor: 'pointer',
      }}
    >
      {label}
    </button>
  );

  if (!proposal.result.ok) {
    return (
      <div style={panelStyle}>
        <div style={{ fontWeight: 600, marginBottom: 6 }}>Survey</div>
        <div style={{ color: '#ef476f', marginBottom: 8 }}>{refusalMessage(proposal.result.reason)}</div>
        <div style={{ display: 'flex', gap: 6 }}>{button('Cancel', onCancel, false)}</div>
      </div>
    );
  }

  const { result } = proposal;
  const totals = summarizeSteps(result.steps);
  const structures = structureBreakdown(result.steps);

  return (
    <div style={panelStyle}>
      <div style={{ fontWeight: 600, marginBottom: 6 }}>Survey</div>
      <div style={rowStyle}>
        <span>Base</span>
        <span>{formatCents(totals.baseCents)}</span>
      </div>
      <div style={rowStyle}>
        <span>Terrain</span>
        <span>{formatCents(totals.terrainCents)}</span>
      </div>
      <div style={rowStyle}>
        <span>Grade</span>
        <span>{formatCents(totals.gradeCents)}</span>
      </div>
      {(Object.keys(structures) as TrackStructure[]).map((structure) => (
        <div style={rowStyle} key={structure}>
          <span>{STRUCTURE_LABELS[structure]}</span>
          <span>{formatCents(structures[structure]!)}</span>
        </div>
      ))}
      <div style={rowStyle}>
        <span>Land</span>
        <span>{formatCents(totals.landCents)}</span>
      </div>
      <div style={{ ...rowStyle, fontWeight: 600, borderTop: '1px solid rgba(224,225,221,0.3)', marginTop: 4, paddingTop: 4 }}>
        <span>Total</span>
        <span>{formatCents(totals.totalCents)}</span>
      </div>
      <div style={{ opacity: 0.8, marginTop: 4 }}>Max grade {(result.maxGrade * 100).toFixed(1)}%</div>
      <div style={{ display: 'flex', gap: 6, marginTop: 8, flexWrap: 'wrap' }}>
        {button('Commit', onCommit, true)}
        {onCharter && button('Charter (pay ahead)', onCharter, false)}
        {button('Cancel', onCancel, false)}
      </div>
    </div>
  );
}
