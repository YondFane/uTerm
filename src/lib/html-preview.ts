import DOMPurify from "dompurify";

export function htmlPreview(source: string): { html: string; limited: boolean } {
  // Preserve head styles without granting project HTML access to the application.
  // 保留 head 中的样式，同时不授予项目 HTML 访问应用的权限。
  const clean = DOMPurify.sanitize(source, {
    WHOLE_DOCUMENT: true,
    USE_PROFILES: { html: true, svg: true, svgFilters: true },
    FORBID_TAGS: ["script", "iframe", "object", "embed", "base", "meta", "link", "form"],
    FORBID_ATTR: ["srcdoc", "href", "xlink:href", "action", "formaction", "target"],
  });
  const parsed = new DOMParser().parseFromString(clean, "text/html");
  const policy = parsed.createElement("meta");
  policy.httpEquiv = "Content-Security-Policy";
  policy.content =
    "default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; form-action 'none'; base-uri 'none'";
  parsed.head.prepend(policy);
  return {
    html: `<!doctype html>${parsed.documentElement.outerHTML}`,
    limited: /<script\b|<link\b|\b(?:src|srcset)\s*=\s*["']?(?!data:)|\burl\s*\(|\bon\w+\s*=/i.test(
      source,
    ),
  };
}
