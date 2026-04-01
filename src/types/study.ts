export interface ProlificStudy {
  id: string;
  title: string;
  rewardText: string | null;
  estimatedTimeText: string | null;
  placesAvailable: number | null;
  placesTaken: number | null;
  placesTotal: number | null;
  url: string;
  summaryText: string;
  discoveredAtIso: string;
}

export function formatStudyIdentity(study: ProlificStudy): string {
  return `${study.id}:${study.title}`;
}
