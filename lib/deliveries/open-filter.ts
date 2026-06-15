// ZeptoMail sends only the FIRST open per email. Gmail/Outlook load the tracking
// pixel at delivery (often via GoogleImageProxy) — that IS the only webhook we get.
// Filtering "prefetch" opens therefore drops all Gmail opens permanently.
//
// We only block obvious non-mail crawlers (Slack previews, social bots, etc.).

const BOT_USER_AGENTS = [
  "facebookexternalhit",
  "slackbot",
  "whatsapp",
  "telegrambot",
  "twitterbot",
  "discordbot",
  "bingpreview",
  "linkedinbot",
];

export function isBotOpenUserAgent(userAgent: string | undefined): boolean {
  if (!userAgent) {
    return false;
  }

  const ua = userAgent.toLowerCase();
  return BOT_USER_AGENTS.some((agent) => ua.includes(agent));
}
