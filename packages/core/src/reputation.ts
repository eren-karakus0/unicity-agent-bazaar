/** Rolling reputation for a provider agent, keyed by @nametag. */
export interface Reputation {
  agentNametag: string;
  jobsCompleted: number; // released
  jobsRefunded: number; // refunded (declined / failed / disputed-for-buyer)
  volumeUct: number; // total UCT released to the agent
  ratingSum: number;
  ratingCount: number;
}

export function newReputation(agentNametag: string): Reputation {
  return { agentNametag, jobsCompleted: 0, jobsRefunded: 0, volumeUct: 0, ratingSum: 0, ratingCount: 0 };
}

export type JobOutcome = 'released' | 'refunded';

/** Fold a terminal job outcome into the provider's reputation. */
export function applyOutcome(rep: Reputation, outcome: JobOutcome, amountUct: number): Reputation {
  if (outcome === 'released') {
    return { ...rep, jobsCompleted: rep.jobsCompleted + 1, volumeUct: rep.volumeUct + amountUct };
  }
  return { ...rep, jobsRefunded: rep.jobsRefunded + 1 };
}

/** Fold a 1-5 star rating (clamped) into the provider's reputation. */
export function applyRating(rep: Reputation, stars: number): Reputation {
  const s = Math.max(1, Math.min(5, Math.round(stars)));
  return { ...rep, ratingSum: rep.ratingSum + s, ratingCount: rep.ratingCount + 1 };
}

export interface ReputationView {
  agentNametag: string;
  jobsCompleted: number;
  /** completed / (completed + refunded), 0 when no jobs yet. */
  successRate: number;
  volumeUct: number;
  avgRating: number | null;
}

export function reputationView(rep: Reputation): ReputationView {
  const total = rep.jobsCompleted + rep.jobsRefunded;
  return {
    agentNametag: rep.agentNametag,
    jobsCompleted: rep.jobsCompleted,
    successRate: total === 0 ? 0 : rep.jobsCompleted / total,
    volumeUct: rep.volumeUct,
    avgRating: rep.ratingCount === 0 ? null : rep.ratingSum / rep.ratingCount,
  };
}
