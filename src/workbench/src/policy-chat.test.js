import assert from "node:assert/strict";
import { test } from "node:test";
import { initialPromptHtml, toggleInitialPrompt } from "../web/policy-chat.js";

test("the initial prompt is escaped, shown once, and initially limited to four lines", () => {
  const html = initialPromptHtml('Question: <script>alert("unsafe")</script>');
  assert.match(html, /-webkit-line-clamp:4/);
  assert.match(html, /max-height:5\.6em/);
  assert.match(html, /aria-controls="policy-initial-prompt"/);
  assert.match(html, /aria-expanded="false"/);
  assert.equal((html.match(/Question:/g) ?? []).length, 1);
  assert.match(html, /&lt;script&gt;alert\(&quot;unsafe&quot;\)&lt;\/script&gt;/);
  assert.doesNotMatch(html, /<script>/);
});

test("the initial prompt can be expanded and collapsed again", () => {
  const prompt = { style: { webkitLineClamp: "4", maxHeight: "5.6em" } };
  const attributes = new Map([["aria-expanded", "false"]]);
  const button = {
    parentElement: { querySelector: (selector) => selector === "[data-policy-prompt-text]" ? prompt : null },
    getAttribute: (name) => attributes.get(name) ?? null,
    setAttribute: (name, value) => attributes.set(name, value),
    textContent: "Show more",
  };

  toggleInitialPrompt(button);
  assert.equal(attributes.get("aria-expanded"), "true");
  assert.equal(attributes.get("aria-label"), "Show less of the initial prompt");
  assert.equal(button.textContent, "Show less");
  assert.equal(prompt.style.webkitLineClamp, "unset");
  assert.equal(prompt.style.maxHeight, "none");

  toggleInitialPrompt(button);
  assert.equal(attributes.get("aria-expanded"), "false");
  assert.equal(attributes.get("aria-label"), "Show more of the initial prompt");
  assert.equal(button.textContent, "Show more");
  assert.equal(prompt.style.webkitLineClamp, "4");
  assert.equal(prompt.style.maxHeight, "5.6em");
});
