import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { ProlificStudy } from "../types/study";

interface NotifiedStudyRow {
  study_id: string;
}

export class StudyStore {
  private readonly db: Database.Database;
  private readonly existsStmt: Database.Statement<[string], NotifiedStudyRow | undefined>;
  private readonly insertStmt: Database.Statement<
    [string, string, string | null, string | null, number | null, number | null, number | null, string, string, string, number],
    Database.RunResult
  >;

  constructor(databasePath: string) {
    const normalizedPath = path.resolve(databasePath);
    fs.mkdirSync(path.dirname(normalizedPath), { recursive: true });

    this.db = new Database(normalizedPath);
    this.db.pragma("journal_mode = WAL");

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS notified_studies (
        study_id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        reward_text TEXT,
        estimated_time_text TEXT,
        places_available INTEGER,
        places_taken INTEGER,
        places_total INTEGER,
        url TEXT NOT NULL,
        summary_text TEXT NOT NULL,
        discovered_at_iso TEXT NOT NULL,
        notified_at_epoch_ms INTEGER NOT NULL
      );
    `);

    this.existsStmt = this.db.prepare("SELECT study_id FROM notified_studies WHERE study_id = ?");

    this.insertStmt = this.db.prepare(`
      INSERT INTO notified_studies (
        study_id,
        title,
        reward_text,
        estimated_time_text,
        places_available,
        places_taken,
        places_total,
        url,
        summary_text,
        discovered_at_iso,
        notified_at_epoch_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
  }

  hasStudy(studyId: string): boolean {
    return Boolean(this.existsStmt.get(studyId));
  }

  markNotified(study: ProlificStudy): void {
    this.insertStmt.run(
      study.id,
      study.title,
      study.rewardText,
      study.estimatedTimeText,
      study.placesAvailable,
      study.placesTaken,
      study.placesTotal,
      study.url,
      study.summaryText,
      study.discoveredAtIso,
      Date.now(),
    );
  }

  close(): void {
    this.db.close();
  }
}
