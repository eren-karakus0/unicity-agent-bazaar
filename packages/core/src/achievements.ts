/**
 * Achievements - earned badges derived purely from a principal's activity.
 * Both sides of the market are recognized: providers for selling well, buyers
 * for participating. Kept a pure function so it is trivially testable and the
 * backend/dashboard can't drift on the rules.
 */

export interface Achievement {
  id: string;
  label: string;
  description: string;
  side: 'provider' | 'buyer';
}

/** The inputs the catalog is evaluated against (fed from a profile's stats). */
export interface AchievementSignals {
  listingsPublished: number;
  jobsSoldReleased: number;
  jobsSoldRefunded: number;
  earnedUct: number;
  avgRating: number | null;
  ratingCount: number;
  jobsBoughtReleased: number;
  spentUct: number;
  /** Distinct providers this principal has bought a released job from. */
  distinctProvidersBought: number;
}

interface Rule extends Achievement {
  earned: (s: AchievementSignals) => boolean;
}

/** The full catalog, in display order. */
export const ACHIEVEMENTS: Achievement[] = [
  { id: 'listed', label: 'Open for Business', description: 'Published a service to the bazaar', side: 'provider' },
  { id: 'first-sale', label: 'First Sale', description: 'Completed your first sale', side: 'provider' },
  { id: 'rising', label: 'Rising', description: 'Completed 5 sales', side: 'provider' },
  { id: 'veteran', label: 'Veteran', description: 'Completed 25 sales', side: 'provider' },
  { id: 'flawless', label: 'Flawless', description: '10+ sales with a 100% success rate', side: 'provider' },
  { id: 'top-rated', label: 'Top Rated', description: '4.5★ or better across 5+ reviews', side: 'provider' },
  { id: 'big-earner', label: 'Big Earner', description: 'Earned 100+ UCT', side: 'provider' },
  { id: 'first-hire', label: 'First Hire', description: 'Hired your first agent', side: 'buyer' },
  { id: 'regular', label: 'Regular', description: 'Completed 5 hires', side: 'buyer' },
  { id: 'patron', label: 'Patron', description: 'Spent 100+ UCT hiring agents', side: 'buyer' },
  { id: 'explorer', label: 'Explorer', description: 'Hired from 3+ different agents', side: 'buyer' },
];

const RULES: Rule[] = ACHIEVEMENTS.map((a) => ({ ...a, earned: earnedRule(a.id) }));

function earnedRule(id: string): (s: AchievementSignals) => boolean {
  switch (id) {
    case 'listed':
      return (s) => s.listingsPublished >= 1;
    case 'first-sale':
      return (s) => s.jobsSoldReleased >= 1;
    case 'rising':
      return (s) => s.jobsSoldReleased >= 5;
    case 'veteran':
      return (s) => s.jobsSoldReleased >= 25;
    case 'flawless':
      return (s) => s.jobsSoldReleased >= 10 && s.jobsSoldRefunded === 0;
    case 'top-rated':
      return (s) => s.ratingCount >= 5 && (s.avgRating ?? 0) >= 4.5;
    case 'big-earner':
      return (s) => s.earnedUct >= 100;
    case 'first-hire':
      return (s) => s.jobsBoughtReleased >= 1;
    case 'regular':
      return (s) => s.jobsBoughtReleased >= 5;
    case 'patron':
      return (s) => s.spentUct >= 100;
    case 'explorer':
      return (s) => s.distinctProvidersBought >= 3;
    default:
      return () => false;
  }
}

/** The achievements a principal has earned, in catalog order. */
export function earnedAchievements(signals: AchievementSignals): Achievement[] {
  return RULES.filter((r) => r.earned(signals)).map(({ earned: _earned, ...a }) => a);
}
