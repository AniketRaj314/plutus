import cron from "node-cron";
import type Database from "better-sqlite3";
import { configureScheduler, runSchedulerCycle } from "../scheduler/status";
import { deliverPaymentRequests } from "./delivery";
import { deliverChatMessages } from "./chat-delivery";
import { processRecipientConversations } from "./replies";
import { deliverPaymentQrs } from "./qr";

export function startPaymentRequestDelivery(db: Database.Database): void {
  // Recovery still runs with delivery disabled, but never makes a network call.
  configureScheduler("payment_requests", {
    label: "Payment request outbox",
    interval_minutes: 1,
    enabled: true,
  });
  const tick = () =>
    runSchedulerCycle("payment_requests", async () => {
      try {
        await deliverPaymentRequests(db);
        await deliverPaymentQrs(db);
        await processRecipientConversations(db);
        await deliverChatMessages(db);
      } catch {
        throw new Error(
          "Payment outbox processing failed; inspect persisted request status",
        );
      }
    });
  void tick().catch(() => console.error("[payments] outbox processing failed"));
  cron.schedule("* * * * *", () => {
    void tick().catch(() =>
      console.error("[payments] outbox processing failed"),
    );
  });
}
