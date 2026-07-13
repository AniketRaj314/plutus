import OpenAI from "openai";
import type Database from "better-sqlite3";
import {
  updateTransaction,
  listCommittedExpenses,
  listTransactions,
  type Transaction,
} from "../db/queries";

export const CATEGORIES = [
  "Food & Dining",
  "Groceries",
  "Transport",
  "Entertainment",
  "Shopping",
  "Subscriptions",
  "Utilities",
  "Health",
  "Travel",
  "Rent",
  "Help & Services",
  "Transfer",
  "Other",
] as const;

type Category = (typeof CATEGORIES)[number];

interface EnrichmentResult {
  merchant_clean: string;
  category: Category;
  is_committed: boolean;
  confidence: number;
  notes: string | null;
}

const SYSTEM_PROMPT = `You are a financial transaction enrichment assistant for a personal finance tracker.

Given a raw merchant string from a bank/card transaction alert, determine:
1. A clean, human-readable merchant name (e.g. "YOUTUBEGOOGLE" -> "YouTube")
2. Exactly one category from this taxonomy (use these exact strings, nothing else):
${CATEGORIES.map((c) => `- ${c}`).join("\n")}
3. Whether this transaction matches a known committed/recurring expense (is_committed)

Examples:
- YOUTUBEGOOGLE -> merchant_clean: "YouTube", category: "Subscriptions"
- BUNDL TECHNOLOGIES -> merchant_clean: "Swiggy", category: "Food & Dining"
- SWIGGY INSTAMART -> merchant_clean: "Swiggy Instamart", category: "Groceries"
- SWIGGY GINIE -> merchant_clean: "Swiggy Genie", category: "Transport"
- SWIGGY ADD MONEY -> merchant_clean: "Swiggy Wallet Top-up", category: "Transfer"
- BOTECO RESTAURANTS -> merchant_clean: "Boteco", category: "Food & Dining"
- RAZ*Furlenco -> merchant_clean: "Furlenco", category: "Help & Services"
- NETFLIX -> merchant_clean: "Netflix", category: "Subscriptions"
- SPOTIFY SI -> merchant_clean: "Spotify", category: "Subscriptions"
- PAYPAL *UBER -> merchant_clean: "Uber", category: "Transport"

Use the list of known committed/recurring expenses and the user's recent transaction history to
decide is_committed and to stay consistent with how similar merchants were categorized before.

Respond with STRICT JSON only, matching exactly this shape, no extra keys, no markdown fences:
{
  "merchant_clean": string,
  "category": string,
  "is_committed": boolean,
  "confidence": number,
  "notes": string | null
}`;

let client: OpenAI | null = null;

function getClient(): OpenAI {
  if (!client) {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) throw new Error("Missing OPENAI_API_KEY");
    client = new OpenAI({ apiKey });
  }
  return client;
}

export async function enrichTransaction(db: Database.Database, transaction: Transaction): Promise<void> {
  if (transaction.is_reversal) {
    updateTransaction(db, transaction.id, {
      merchant_clean: "Refund",
      category: "Other",
      is_committed: 0,
    });
    console.log(`[enrich] transaction ${transaction.id} is a reversal, set merchant_clean="Refund" category="Other" without an API call`);
    return;
  }

  if (transaction.is_international && transaction.notes === "pending_forex_resolution") {
    console.log(`[enrich] transaction ${transaction.id} is pending forex resolution, skipping enrichment for now`);
    return;
  }

  try {
    const committed = listCommittedExpenses(db);
    const recent = listTransactions(db, 4).filter((t) => t.id !== transaction.id).slice(0, 3);

    const openai = getClient();
    const completion = await openai.chat.completions.create({
      model: "gpt-4o",
      temperature: 0,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: buildPrompt(transaction, committed, recent) },
      ],
    });

    const raw = completion.choices[0]?.message?.content;
    if (!raw) throw new Error("empty response from OpenAI");

    const parsed = parseEnrichmentResponse(raw);
    if (!parsed) throw new Error(`could not parse/validate enrichment JSON: ${raw}`);

    updateTransaction(db, transaction.id, {
      merchant_clean: parsed.merchant_clean,
      category: parsed.category,
      is_committed: parsed.is_committed ? 1 : 0,
      notes: parsed.notes,
      enrichment_confidence: parsed.confidence,
    });

    console.log(
      `[enrich] transaction ${transaction.id}: merchant_clean="${parsed.merchant_clean}" category="${parsed.category}" is_committed=${parsed.is_committed} confidence=${parsed.confidence}`
    );
  } catch (err) {
    console.error(`[enrich] enrichment failed for transaction ${transaction.id}:`, err);

    updateTransaction(db, transaction.id, {
      merchant_clean: transaction.merchant_raw,
      category: "Other",
      is_committed: 0,
      enrichment_confidence: 0,
      notes: "enrichment_failed",
    });

    console.log(
      `[enrich] transaction ${transaction.id}: fell back to safe defaults (merchant_clean="${transaction.merchant_raw}" category="Other" confidence=0 notes="enrichment_failed")`
    );
  }
}

function buildPrompt(
  transaction: Transaction,
  committed: ReturnType<typeof listCommittedExpenses>,
  recent: Transaction[]
): string {
  const committedList = committed.length
    ? committed.map((c) => `- ${c.label}: pattern="${c.merchant_pattern ?? ""}"`).join("\n")
    : "(none defined)";

  const recentList = recent.length
    ? recent
        .map(
          (t) =>
            `- merchant_raw="${t.merchant_raw ?? ""}" merchant_clean="${t.merchant_clean ?? ""}" category="${t.category ?? ""}" amount=${t.amount} datetime=${t.datetime}`
        )
        .join("\n")
    : "(none)";

  return `Transaction to enrich:
merchant_raw: ${transaction.merchant_raw ?? "(null)"}
amount: ${transaction.amount}
source: ${transaction.source}
datetime: ${transaction.datetime}

Known committed/recurring expenses:
${committedList}

Last 3 transactions (for context/consistency):
${recentList}

Return the enrichment JSON now.`;
}

function parseEnrichmentResponse(raw: string): EnrichmentResult | null {
  let obj: unknown;
  try {
    obj = JSON.parse(raw);
  } catch {
    return null;
  }

  if (typeof obj !== "object" || obj === null) return null;
  const o = obj as Record<string, unknown>;

  if (typeof o.merchant_clean !== "string" || !o.merchant_clean.trim()) return null;
  if (typeof o.category !== "string" || !CATEGORIES.includes(o.category as Category)) return null;
  if (typeof o.is_committed !== "boolean") return null;
  if (typeof o.confidence !== "number" || o.confidence < 0 || o.confidence > 1) return null;
  if (o.notes !== null && typeof o.notes !== "string") return null;

  return {
    merchant_clean: o.merchant_clean,
    category: o.category as Category,
    is_committed: o.is_committed,
    confidence: o.confidence,
    notes: (o.notes as string | null) ?? null,
  };
}
