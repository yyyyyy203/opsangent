import Database from 'better-sqlite3';
import { migrateSqlite } from './migrations.js';

export class SqliteDatabase {
  private constructor(public readonly raw: Database.Database) {}

  public static open(path: string): SqliteDatabase {
    const raw = new Database(path);
    raw.pragma('journal_mode = WAL');
    raw.pragma('foreign_keys = ON');
    raw.pragma('busy_timeout = 5000');
    migrateSqlite(raw);
    return new SqliteDatabase(raw);
  }

  public close(): void {
    this.raw.close();
  }
}
