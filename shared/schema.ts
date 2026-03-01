import { sql } from "drizzle-orm";
import { pgTable, text, varchar, serial, jsonb, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";

export const users = pgTable("users", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  username: text("username").notNull().unique(),
  password: text("password").notNull(),
});

export const dataStore = pgTable("data_store", {
  id: serial("id").primaryKey(),
  tableName: text("table_name").notNull().unique(),
  data: jsonb("data").notNull().default(sql`'[]'::jsonb`),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
});

export const insertUserSchema = createInsertSchema(users).pick({
  username: true,
  password: true,
});

export const insertDataStoreSchema = createInsertSchema(dataStore).pick({
  tableName: true,
  data: true,
});

export type InsertUser = z.infer<typeof insertUserSchema>;
export type User = typeof users.$inferSelect;
export type DataStore = typeof dataStore.$inferSelect;
export type InsertDataStore = z.infer<typeof insertDataStoreSchema>;
