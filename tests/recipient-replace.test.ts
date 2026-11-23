import { describe, expect, test } from "bun:test";
import { swapMerge, swapRecipient } from "@/lib/jobs/campaign";

describe("swapRecipient", () => {
  test("keeps the place in the list", () => {
    expect(swapRecipient(["a@x.bg", "old@x.bg", "c@x.bg"], "OLD@x.bg", "new@x.bg")).toEqual([
      "a@x.bg",
      "new@x.bg",
      "c@x.bg",
    ]);
  });

  test("never lists the new address twice", () => {
    expect(swapRecipient(["new@x.bg", "old@x.bg"], "old@x.bg", "new@x.bg")).toEqual([
      "new@x.bg",
    ]);
  });

  test("leaves a list without the old address alone", () => {
    expect(swapRecipient(["a@x.bg"], "old@x.bg", "new@x.bg")).toEqual(["a@x.bg"]);
  });
});

describe("swapMerge", () => {
  const merge = {
    "old@x.bg": { email: "old@x.bg", first_name: "Ана", unsubscribe_url: "https://u/old" },
    "b@x.bg": { email: "b@x.bg" },
  };

  test("the caller's fields replace the old entry", () => {
    const next = swapMerge(merge, "old@x.bg", "new@x.bg", {
      email: "new@x.bg",
      first_name: "Ана",
      unsubscribe_url: "https://u/new",
    });
    expect(next["old@x.bg"]).toBeUndefined();
    expect(next["new@x.bg"]).toEqual({
      email: "new@x.bg",
      first_name: "Ана",
      unsubscribe_url: "https://u/new",
    });
    expect(next["b@x.bg"]).toEqual({ email: "b@x.bg" });
  });

  test("without fields the old entry moves with its email fixed", () => {
    const next = swapMerge(merge, "old@x.bg", "new@x.bg");
    expect(next["new@x.bg"]).toEqual({
      email: "new@x.bg",
      first_name: "Ана",
      unsubscribe_url: "https://u/old",
    });
  });

  test("a job without merge fields stays without them", () => {
    expect(swapMerge({}, "old@x.bg", "new@x.bg")).toEqual({});
  });
});
