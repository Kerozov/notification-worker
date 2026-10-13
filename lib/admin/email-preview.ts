// Sandbox for admin email previews: scripts, forms and same-origin access stay
// blocked, but links/buttons may open in a new tab (unsandboxed).
export const EMAIL_PREVIEW_SANDBOX = "allow-popups allow-popups-to-escape-sandbox";

// Make every link in the preview open in a new tab instead of navigating the iframe.
export function emailPreviewSrcDoc(html: string): string {
  const base = '<base target="_blank">';
  if (/<head[^>]*>/i.test(html)) return html.replace(/<head[^>]*>/i, (m) => m + base);
  return base + html;
}
