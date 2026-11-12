import { afterEach, describe, expect, test } from "bun:test";
import {
  loadZeptoAttachments,
  PermanentAttachmentError,
} from "@/lib/email/attachments";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

function stub(body: BodyInit, headers: Record<string, string> = {}, status = 200) {
  globalThis.fetch = (async () => new Response(body, { status, headers })) as typeof fetch;
}

const att = { filename: "menu.pdf", url: "https://example.com/menu.pdf", contentType: "application/pdf" };

describe("attachment limits are permanent", () => {
  test("declared Content-Length over 8 MB", async () => {
    stub("x", { "content-length": String(18 * 1024 * 1024) });
    await expect(loadZeptoAttachments([att])).rejects.toBeInstanceOf(PermanentAttachmentError);
  });

  test("streamed body over 8 MB without Content-Length", async () => {
    const chunk = new Uint8Array(1024 * 1024);
    let sent = 0;
    stub(new ReadableStream({
      pull(c) { if (sent++ < 20) c.enqueue(chunk); else c.close(); },
    }));
    await expect(loadZeptoAttachments([att])).rejects.toBeInstanceOf(PermanentAttachmentError);
    expect(sent).toBeLessThan(12);
  });

  test("404 is permanent, 502 is not", async () => {
    stub("no", {}, 404);
    await expect(loadZeptoAttachments([att])).rejects.toBeInstanceOf(PermanentAttachmentError);
    stub("down", {}, 502);
    const err = await loadZeptoAttachments([att]).catch((e) => e);
    expect(err).not.toBeInstanceOf(PermanentAttachmentError);
  });

  test("small file still loads", async () => {
    stub("%PDF-1.4 ok");
    const [loaded] = await loadZeptoAttachments([att]);
    expect(loaded?.name).toBe("menu.pdf");
  });
});
