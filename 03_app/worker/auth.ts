import type { D1Database } from "@cloudflare/workers-types";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { drizzle } from "drizzle-orm/d1";

import * as schema from "../auth-schema";

export function createAuth(
  db: D1Database,
  secret: string,
  baseURL: string
) {
  return betterAuth({
    database: drizzleAdapter(
      drizzle(db, { schema }),
      {
        provider: "sqlite",
        schema,
      }
    ),
    secret,
    baseURL,
    emailAndPassword: {
      enabled: true,
    },
  });
}