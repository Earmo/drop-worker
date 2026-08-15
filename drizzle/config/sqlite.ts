import { defineConfig } from "drizzle-kit";

export default defineConfig({
  out: "./drizzle/sqlite",
  schema: "./db/schema.ts",
  dialect: "sqlite",
});
