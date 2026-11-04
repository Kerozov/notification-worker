import { describe, expect, test } from "bun:test";
import {
  canRecordEngagement,
  classifyWebhookEvent,
} from "../lib/deliveries/webhook-events";

/**
 * abv.bg answered whole campaigns with soft bounces that ZeptoMail retried and
 * delivered. Stored as final bounces, they showed hundreds of valid addresses
 * as failed and threw away their opens and clicks.
 */

describe("classifyWebhookEvent", () => {
  test("tells a soft bounce from a hard one", () => {
    expect(classifyWebhookEvent("softbounce")).toBe("softbounced");
    expect(classifyWebhookEvent("hardbounce")).toBe("bounced");
  });

  test("keeps the other ZeptoMail events", () => {
    expect(classifyWebhookEvent("email_open")).toBe("opened");
    expect(classifyWebhookEvent("email_link_click")).toBe("clicked");
    expect(classifyWebhookEvent("feedback_loop")).toBe("complained");
    expect(classifyWebhookEvent("email_delivered")).toBe("delivered");
    expect(classifyWebhookEvent("something_else")).toBeNull();
  });
});

describe("canRecordEngagement", () => {
  test("an open or click outranks a stored bounce", () => {
    expect(canRecordEngagement("bounced")).toBe(true);
    expect(canRecordEngagement("sent")).toBe(true);
    expect(canRecordEngagement("delivered")).toBe(true);
  });

  test("never revives a failed send, a complaint or a cancel", () => {
    expect(canRecordEngagement("failed")).toBe(false);
    expect(canRecordEngagement("complained")).toBe(false);
    expect(canRecordEngagement("canceled")).toBe(false);
  });
});
