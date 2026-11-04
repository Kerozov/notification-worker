export type WebhookKind =
  | "opened"
  | "clicked"
  | "complained"
  | "bounced"
  | "softbounced"
  | "delivered";

/**
 * ZeptoMail sends `softbounce` and `hardbounce`. A soft bounce is a temporary
 * refusal: ZeptoMail keeps retrying and usually delivers, so it must not end
 * the delivery the way a hard bounce does.
 */
export function classifyWebhookEvent(eventName: string): WebhookKind | null {
  const name = eventName.toLowerCase();

  if (name.includes("feedback") || name === "fbl") {
    return "complained";
  }
  if (name.includes("click")) {
    return "clicked";
  }
  if (
    name === "email_open" ||
    name === "open" ||
    (name.includes("open") && !name.includes("click"))
  ) {
    return "opened";
  }
  if (name.includes("bounce")) {
    return name.includes("soft") ? "softbounced" : "bounced";
  }
  if (name.includes("deliver")) {
    return "delivered";
  }

  return null;
}

export function isTerminalStatus(status: string): boolean {
  return (
    status === "complained" ||
    status === "bounced" ||
    status === "failed" ||
    status === "canceled"
  );
}

/**
 * An open or a click proves the email arrived. That outranks a "bounced" row:
 * before soft bounces were told apart, a temporary refusal from the recipient's
 * server was stored as a final bounce, and later opens were thrown away.
 */
export function canRecordEngagement(status: string): boolean {
  return status === "bounced" || !isTerminalStatus(status);
}
