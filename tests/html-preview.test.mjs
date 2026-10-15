import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";

test("HTML preview preserves document styles and isolates active content", async () => {
  const dom = new JSDOM("");
  globalThis.window = dom.window;
  globalThis.DOMParser = dom.window.DOMParser;
  const { htmlPreview } = await import("../src/lib/html-preview.ts");
  const result = htmlPreview(
    '<html lang="en"><head><style>body{color:red}</style></head><body><h1>Hello</h1><script>alert(1)</script><iframe srcdoc="unsafe"></iframe><a href="https://example.com">Link</a><img src="data:image/png;base64,AA==" onerror="alert(1)"></body></html>',
  );
  const parsed = new dom.window.DOMParser().parseFromString(result.html, "text/html");
  assert.equal(parsed.documentElement.lang, "en");
  assert.equal(parsed.head.querySelector("style").textContent, "body{color:red}");
  assert.equal(parsed.head.firstElementChild.httpEquiv, "Content-Security-Policy");
  assert.equal(parsed.querySelector("h1").textContent, "Hello");
  assert.equal(parsed.querySelector("script,iframe,[onerror],[href]"), null);
  assert.equal(result.limited, true);
  assert.equal(htmlPreview("<h1>Static page</h1>").limited, false);
  assert.equal(htmlPreview('<script type="module" src="/src/main.tsx"></script>').limited, true);
  const svgLink = htmlPreview(
    '<svg><a xlink:href="https://example.com"><text>Link</text></a></svg>',
  );
  assert.doesNotMatch(svgLink.html, /xlink:href/i);
  dom.window.close();
});
