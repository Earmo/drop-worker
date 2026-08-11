import { defineConfig } from "drizzle-kit";

export default defineConfig({
  out: "./drizzle-postgres",
  schema: "./db/schema.postgres.ts",
  dialect: "postgresql",
});
