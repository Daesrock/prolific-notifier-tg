import { Page } from "playwright";
import { ProlificStudy } from "../types/study";

interface RawStudyData {
  id: string;
  title: string;
  rewardText: string | null;
  estimatedTimeText: string | null;
  placesAvailable: number | null;
  placesTaken: number | null;
  placesTotal: number | null;
  url: string;
  summaryText: string;
}

function firstMatch(text: string, patterns: RegExp[]): string | null {
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match?.[0]) {
      return match[0].trim();
    }
  }
  return null;
}

function toNumber(value: string | undefined): number | null {
  if (!value) {
    return null;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isNaN(parsed) ? null : parsed;
}

export async function extractStudies(page: Page): Promise<ProlificStudy[]> {
  const rawStudies = await page.evaluate(() => {
    const data: RawStudyData[] = [];
    const seen = new Set<string>();

    const anchorCandidates = Array.from(document.querySelectorAll<HTMLAnchorElement>("a[href*='/studies/']"));

    for (const anchor of anchorCandidates) {
      const href = anchor.href;
      const idMatch = href.match(/\/studies\/([A-Za-z0-9_-]+)/i);
      if (!idMatch) {
        continue;
      }

      const id = idMatch[1];
      if (seen.has(id)) {
        continue;
      }

      const card = anchor.closest("article, li, section, div") ?? anchor;
      const cardText = (card.textContent || "").replace(/\s+/g, " ").trim();
      if (!cardText) {
        continue;
      }

      const heading = card.querySelector("h1, h2, h3, h4")?.textContent?.trim() || anchor.textContent?.trim() || `Study ${id}`;

      const rewardMatch = cardText.match(/(?:[£$€]\s?\d+(?:[.,]\d{1,2})?)/i);
      const estimatedMatch = cardText.match(/(?:\d+\s*(?:min|mins|minutes|hour|hours))/i);
      const availableMatch = cardText.match(/(\d+)\s*(?:places?|spots?)\s*(?:left|available)/i);
      const takenMatch = cardText.match(/(\d+)\s*(?:places?|spots?)\s*(?:taken|filled|occupied)/i);
      const totalMatch = cardText.match(/(?:of|\/|out of)\s*(\d+)\s*(?:places?|spots?)/i);

      data.push({
        id,
        title: heading,
        rewardText: rewardMatch ? rewardMatch[0] : null,
        estimatedTimeText: estimatedMatch ? estimatedMatch[0] : null,
        placesAvailable: availableMatch ? Number.parseInt(availableMatch[1], 10) : null,
        placesTaken: takenMatch ? Number.parseInt(takenMatch[1], 10) : null,
        placesTotal: totalMatch ? Number.parseInt(totalMatch[1], 10) : null,
        url: href,
        summaryText: cardText,
      });
      seen.add(id);
    }

    return data;
  });

  const nowIso = new Date().toISOString();
  const normalized = rawStudies.map((study) => {
    const reward = study.rewardText ?? firstMatch(study.summaryText, [/(?:[£$€]\s?\d+(?:[.,]\d{1,2})?)/i]);
    const time = study.estimatedTimeText ?? firstMatch(study.summaryText, [/(?:\d+\s*(?:min|mins|minutes|hour|hours))/i]);

    const available =
      study.placesAvailable ?? toNumber(study.summaryText.match(/(\d+)\s*(?:places?|spots?)\s*(?:left|available)/i)?.[1]);
    const taken =
      study.placesTaken ?? toNumber(study.summaryText.match(/(\d+)\s*(?:places?|spots?)\s*(?:taken|filled|occupied)/i)?.[1]);
    const total = study.placesTotal ?? toNumber(study.summaryText.match(/(?:of|\/|out of)\s*(\d+)\s*(?:places?|spots?)/i)?.[1]);

    return {
      ...study,
      rewardText: reward,
      estimatedTimeText: time,
      placesAvailable: available,
      placesTaken: taken,
      placesTotal: total,
      discoveredAtIso: nowIso,
    };
  });

  return normalized;
}
