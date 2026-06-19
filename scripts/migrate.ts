#!/usr/bin/env bun
import { readdirSync, readFileSync } from "fs";
import { resolve } from "path";
import { spawnSync } from "child_process";
import postgres from "postgres";
import { config } from "dotenv";

config({ path: ".env.local" });

const MIGRATIONS_DIR = resolve(process.cwd(), "supabase/migrations");

function getProjectRef(): string {
  const url = process.env.SUPABASE_URL;

  if (!url) {
    throw new Error("SUPABASE_URL is required in .env.local");
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
    throw new Error(
      "SUPABASE_DB_PASSWORD is required. Supabase → Project Settings → Database → Database password",
    );
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

function listMigrationFiles(): string[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((name) => /^\d{3}_.*\.sql$/.test(name))
    .sort();
}

async function main(): Promise<void> {
  const projectRef = getProjectRef();
  const password = getDbPassword();
  const servername = `db.${projectRef}.supabase.co`;
  const ip = resolveHostViaNslookup(servername);
  const encodedPassword = encodeURIComponent(password);

  const connectionString = ip.includes(":")
    ? `postgresql://postgres:${encodedPassword}@[${ip}]:5432/postgres`
    : `postgresql://postgres:${encodedPassword}@${ip}:5432/postgres`;

  const sql = postgres(connectionString, {
    ssl: { rejectUnauthorized: false },
    max: 1,
    connect_timeout: 20,
  });

  const files = listMigrationFiles();

  if (files.length === 0) {
    throw new Error(`No migrations found in ${MIGRATIONS_DIR}`);
  }

  console.log(`Applying ${files.length} migration(s) to ${projectRef}...\n`);

  try {
    for (const file of files) {
      const migrationSql = readFileSync(resolve(MIGRATIONS_DIR, file), "utf8");
      await sql.unsafe(migrationSql);
      console.log(`  ✓ ${file}`);
    }

    console.log("\nDone. Run: bun run db:verify");
  } finally {
    await sql.end();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
