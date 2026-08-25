require("ts-node/register");

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  normalizeTelegramTypography,
  renderTelegramChunks,
  renderTelegramHtml,
  telegramHtmlToPlainText,
} = require("../src/telegram/render");
const { buildContributorSystemPrompt } = require("../src/agent/contributor");
const { isTelegramFormattingError } = require("../src/telegram/bot");

test("Telegram renderer converts common Markdown and escapes untrusted HTML", () => {
  const rendered = renderTelegramHtml(
    "Everything is classified with **no unresolved rows**.\n\n- Today left: **₹0**\n- Merchant: <unsafe> & sons"
  );

  assert.match(rendered, /<b>no unresolved rows<\/b>/);
  assert.match(rendered, /• Today left: <b>₹0<\/b>/);
  assert.match(rendered, /&lt;unsafe&gt; &amp; sons/);
  assert.doesNotMatch(rendered, /\*\*/);
});

test("Telegram renderer turns Markdown tables into aligned preformatted tables", () => {
  const rendered = renderTelegramHtml([
    "| Date | Merchant | Amount | Note |",
    "| --- | --- | ---: | --- |",
    "| 24 Aug | Swiggy Instamart | ₹439 | Groceries |",
    "| 25 Aug | <Unknown> | ₹1,809 | Food & travel |",
  ].join("\n"));

  assert.match(rendered, /^<pre>/);
  assert.match(rendered, /Date\s+│ Merchant/);
  assert.match(rendered, /Swiggy Instamart/);
  assert.match(rendered, /&lt;Unknown&gt;/);
  assert.match(rendered, /Food &amp; travel/);
  assert.doesNotMatch(rendered, /\| ---/);

  const plainLines = telegramHtmlToPlainText(rendered).split("\n");
  assert.ok(plainLines.every((line) => Array.from(line).length <= 72));
});

test("Telegram renderer removes em dashes even when the model emits one", () => {
  const source = "Today—₹595 over—needs attention";
  const normalized = normalizeTelegramTypography(source);
  const rendered = renderTelegramHtml(source);

  assert.equal(normalized, "Today - ₹595 over - needs attention");
  assert.doesNotMatch(rendered, /—/);
});

test("Telegram renderer chunks long tables within the API limit and balances pre tags", () => {
  const rows = Array.from(
    { length: 180 },
    (_, index) => `| 25 Aug | Merchant ${index + 1} | ₹${index + 1} | Personal expense |`
  );
  const chunks = renderTelegramChunks([
    "**Transactions**",
    "",
    "| Date | Merchant | Amount | Note |",
    "| --- | --- | ---: | --- |",
    ...rows,
  ].join("\n"));

  assert.ok(chunks.length > 1);
  for (const chunk of chunks) {
    assert.ok(chunk.length <= 3900);
    assert.equal((chunk.match(/<pre>/g) ?? []).length, (chunk.match(/<\/pre>/g) ?? []).length);
  }
});

test("Telegram plain-text fallback preserves readable content", () => {
  const rendered = renderTelegramHtml("**Total:** ₹1,809 & <verified>");
  assert.equal(telegramHtmlToPlainText(rendered), "Total: ₹1,809 & <verified>");
});

test("contributor prompt forbids em dashes and raw HTML", () => {
  const prompt = buildContributorSystemPrompt({ telegram_user_id: "222", name: "Rushil" });
  assert.match(prompt, /Never use an em dash/);
  assert.match(prompt, /never raw HTML/i);
});

test("plain-text retry is limited to Telegram formatting rejections", () => {
  assert.equal(
    isTelegramFormattingError({
      message: "ETELEGRAM: 400 Bad Request: can't parse entities",
      response: {
        statusCode: 400,
        body: { description: "Bad Request: can't parse entities" },
      },
    }),
    true
  );
  assert.equal(
    isTelegramFormattingError({
      message: "ETELEGRAM: 429 Too Many Requests",
      response: { statusCode: 429 },
    }),
    false
  );
  assert.equal(isTelegramFormattingError(new Error("socket timeout")), false);
});
