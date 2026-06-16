#!/usr/bin/env bun
/**
 * Print a ready-to-paste tenant env block.
 *
 * Usage:
 *   bun run tenant:new ACME "Acme Ltd"
 *   bun run tenant:new HEALTHYCONFIDENT "Healthy and Confident" --sms
 *   bun run tenant:new ACME "Acme Ltd" --from "Acme <hello@acme.com>"
 */

import { randomBytes } from "crypto";

function usage(): never {
  console.log(`
Usage:
  bun run tenant:new <CLIENT_ID> "<Display name>" [options]

CLIENT_ID:
  Uppercase letters, numbers, underscores (e.g. ACME, HEALTHY_CONFIDENT)
  → DB slug: acme, healthy-confident

Options:
  --sms              Include SMS sender + NOTIFIER_KEY placeholders
  --from "Name <e@mail.com>"   Default from address
  --reply-to email   Reply-To header
  --sender NAME      SMS sender label (with --sms)

Examples:
  bun run tenant:new ACME "Acme Ltd"
  bun run tenant:new HC "Healthy and Confident" --sms --sender Vessie
`);
  process.exit(1);
}

function parseArgs(argv: string[]): {
  clientId: string;
  name: string;
  sms: boolean;
  from?: string;
  replyTo?: string;
  smsSender?: string;
} {
  const positional = argv.filter((a) => !a.startsWith("--"));
  const flags = new Set(argv.filter((a) => a.startsWith("--")));

  if (positional.length < 2) {
    usage();
  }

  const clientId = positional[0].toUpperCase().replace(/[^A-Z0-9_]/g, "_");
  const name = positional[1];

  if (!/^[A-Z][A-Z0-9_]*$/.test(clientId)) {
    console.error("CLIENT_ID must be UPPER_SNAKE_CASE (e.g. ACME, HEALTHY_CONFIDENT)");
    process.exit(1);
  }

  const fromIdx = argv.indexOf("--from");
  const replyIdx = argv.indexOf("--reply-to");
  const senderIdx = argv.indexOf("--sender");

  return {
    clientId,
    name,
    sms: flags.has("--sms"),
    from: fromIdx >= 0 ? argv[fromIdx + 1] : undefined,
    replyTo: replyIdx >= 0 ? argv[replyIdx + 1] : undefined,
    smsSender: senderIdx >= 0 ? argv[senderIdx + 1] : undefined,
  };
}

function envSuffixToSlug(suffix: string): string {
  return suffix.toLowerCase().replace(/_/g, "-");
}

function generateApiKey(clientId: string): string {
  const prefix = clientId.toLowerCase().replace(/_/g, "").slice(0, 8);
  const secret = randomBytes(24).toString("base64url");
  return `${prefix}_${secret}`;
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const slug = envSuffixToSlug(args.clientId);
  const apiKey = generateApiKey(args.clientId);
  const defaultFrom =
    args.from ?? `${args.name} <hello@example.com>`;
  const smsSender =
    args.smsSender ?? args.name.replace(/\s+/g, "").slice(0, 14);

  const lines = [
    `# Tenant: ${args.name} (slug: ${slug})`,
    `# Add to .env.local + Vercel, then: bun run seed`,
    "",
    `TENANT_${args.clientId}_KEY=${apiKey}`,
    `TENANT_${args.clientId}_NAME=${args.name}`,
    `TENANT_${args.clientId}_FROM=${defaultFrom}`,
  ];

  if (args.replyTo) {
    lines.push(`TENANT_${args.clientId}_REPLY_TO=${args.replyTo}`);
  }

  if (args.sms) {
    lines.push(
      `TENANT_${args.clientId}_SMS_SENDER=${smsSender}`,
      `TENANT_${args.clientId}_NOTIFIER_KEY=paste-notifierbg-api-token-here`,
    );
  }

  lines.push(
    "",
    "# Client site backend (NOT in browser):",
    "NOTIFICATION_WORKER_URL=https://notification-worker-phi.vercel.app",
    `NOTIFICATION_WORKER_API_KEY=${apiKey}`,
  );

  console.log(lines.join("\n"));
}

main();
