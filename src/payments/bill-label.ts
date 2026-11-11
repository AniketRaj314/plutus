import type Database from "better-sqlite3";
import type { PaymentRequest } from "./requests";
import { billIds } from "./bill-context";

export function billLabel(
  db: Database.Database,
  request: Pick<PaymentRequest, "source_ids">,
): string {
  const facts: Array<{ title: string; date: string | null }> = [];
  for (const bill of [
    ...new Set(
      (JSON.parse(request.source_ids) as string[]).flatMap((id) => {
        try {
          return billIds(db, id);
        } catch {
          return [];
        }
      }),
    ),
  ]) {
    const row = bill.startsWith("raw:")
      ? db
          .prepare(
            "SELECT merchant_raw AS title, occurred_at AS date FROM raw_transactions WHERE id=?",
          )
          .get(bill.slice(4))
      : bill.startsWith("entry:")
        ? db
            .prepare(
              "SELECT merchant_clean AS title, occurred_at AS date FROM envelope_entries WHERE id=?",
            )
            .get(bill.slice(6))
        : undefined;
    if (row) facts.push(row as { title: string; date: string | null });
  }
  const titles = [...new Set(facts.map((f) => f.title).filter(Boolean))];
  const dates = [
    ...new Set(
      facts
        .map((f) => {
          if (!f.date) return null;
          const d = new Date(f.date);
          return Number.isNaN(d.getTime())
            ? null
            : new Intl.DateTimeFormat("en-GB", {
                timeZone: "Asia/Kolkata",
                day: "numeric",
                month: "short",
                year: "numeric",
              }).format(d);
        })
        .filter(Boolean),
    ),
  ];
  const title = titles.length
    ? titles.join(" + ").slice(0, 100)
    : "Shared expense";
  return `${title} · ${dates.length ? dates.join(", ") : "expense date unconfirmed"}`;
}
