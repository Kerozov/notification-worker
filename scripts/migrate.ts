#!/usr/bin/env bun
import { readFileSync } from "fs";
import { resolve } from "path";
import { spawnSync } from "child_process";
import postgres from "postgres";
import { config } from "dotenv";

config({ path: ".env.local" });

function getProjectRef(): string {
  const url = process.env.SUPABASE_URL;

  if (!url) {
    throw new Error("SUPABASE_URL is required");
  }

  const match = url.match(/https:\/\/([^.]+)\.supabase\.co/);

  if (!match) {
    throw new Error("Invalid SUPABASE_URL");
  }

  return match[1];
}

function getDbPassword(): string {
  const password = process.env.SUPABASE_DB_PASSWORD;

  if (!password) {
    throw new Error("SUPABASE_DB_PASSWORD is required");
  }

  return password;
}

function resolveHostViaNslookup(servername: string): string {
  const result = spawnSync("nslookup", [servername], {
    encoding: "utf8",
  });

  if (result.status !== 0) {
    throw new Error(`Could not resolve ${servername}`);
  }

  const lines = result.stdout.split(/\r?\n/);
  const addresses: string[] = [];

  for (const line of lines) {
    const match = line.match(/Address:\s+(.+)$/i);

    if (!match) {
      continue;
    }

    const value = match[1].trim();

    if (value.includes(":")) {
      addresses.push(value);
    }
  }

  const host = addresses.at(-1);

  if (!host) {
    throw new Error(`No address found for ${servername}`);
  }

  return host;
}

async function main(): Promise<void> {
  const projectRef = getProjectRef();
  const password = getDbPassword();
  const servername = `db.${projectRef}.supabase.co`;
  const ip = resolveHostViaNslookup(servername);
  const encodedPassword = encodeURIComponent(password);
  const sqlFile = resolve(
    process.cwd(),
    "supabase/migrations/001_init.sql",
  );
  const migrationSql = readFileSync(sqlFile, "utf8");

  const connectionString = ip.includes(":")
    ? `postgresql://postgres:${encodedPassword}@[${ip}]:5432/postgres`
    : `postgresql://postgres:${encodedPassword}@${ip}:5432/postgres`;

  const sql = postgres(connectionString, {
    ssl: { rejectUnauthorized: false },
    max: 1,
    connect_timeout: 20,
  });

  try {
    await sql.unsafe(migrationSql);
    console.log("Migration applied: 001_init.sql");
  } finally {
    await sql.end();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
