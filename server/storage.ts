import { type User, type InsertUser } from "@shared/schema";
import { randomUUID } from "crypto";
import pg from "pg";

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
});

export interface IStorage {
  initDatabase(): Promise<void>;
  getUser(id: string): Promise<User | undefined>;
  getUserByUsername(username: string): Promise<User | undefined>;
  createUser(user: InsertUser): Promise<User>;
  getAllData(): Promise<Record<string, any>>;
  getTableData(tableName: string): Promise<any>;
  setTableData(tableName: string, data: any): Promise<void>;
  setBulkData(data: Record<string, any>): Promise<void>;
}

export class DatabaseStorage implements IStorage {
  private pool: pg.Pool;

  constructor() {
    this.pool = pool;
  }

  async initDatabase(): Promise<void> {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS users (
        id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
        username TEXT NOT NULL UNIQUE,
        password TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS data_store (
        id SERIAL PRIMARY KEY,
        table_name TEXT NOT NULL UNIQUE,
        data JSONB NOT NULL DEFAULT '[]'::jsonb,
        updated_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);
  }

  async getUser(id: string): Promise<User | undefined> {
    const result = await this.pool.query("SELECT * FROM users WHERE id = $1", [id]);
    return result.rows[0] || undefined;
  }

  async getUserByUsername(username: string): Promise<User | undefined> {
    const result = await this.pool.query("SELECT * FROM users WHERE username = $1", [username]);
    return result.rows[0] || undefined;
  }

  async createUser(insertUser: InsertUser): Promise<User> {
    const id = randomUUID();
    const result = await this.pool.query(
      "INSERT INTO users (id, username, password) VALUES ($1, $2, $3) RETURNING *",
      [id, insertUser.username, insertUser.password]
    );
    return result.rows[0];
  }

  async getAllData(): Promise<Record<string, any>> {
    const result = await this.pool.query("SELECT table_name, data FROM data_store");
    const data: Record<string, any> = {};
    for (const row of result.rows) {
      data[row.table_name] = row.data;
    }
    return data;
  }

  async getTableData(tableName: string): Promise<any> {
    const result = await this.pool.query(
      "SELECT data FROM data_store WHERE table_name = $1",
      [tableName]
    );
    if (result.rows.length === 0) return tableName === "settings" ? {} : [];
    return result.rows[0].data;
  }

  async setTableData(tableName: string, data: any): Promise<void> {
    await this.pool.query(
      `INSERT INTO data_store (table_name, data, updated_at)
       VALUES ($1, $2::jsonb, NOW())
       ON CONFLICT (table_name)
       DO UPDATE SET data = $2::jsonb, updated_at = NOW()`,
      [tableName, JSON.stringify(data)]
    );
  }

  async setBulkData(data: Record<string, any>): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      for (const [tableName, tableData] of Object.entries(data)) {
        if (tableName.startsWith("_")) continue;
        await client.query(
          `INSERT INTO data_store (table_name, data, updated_at)
           VALUES ($1, $2::jsonb, NOW())
           ON CONFLICT (table_name)
           DO UPDATE SET data = $2::jsonb, updated_at = NOW()`,
          [tableName, JSON.stringify(tableData)]
        );
      }
      await client.query("COMMIT");
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    } finally {
      client.release();
    }
  }
}

export const storage = new DatabaseStorage();
