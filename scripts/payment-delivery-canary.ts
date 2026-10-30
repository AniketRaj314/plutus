import "dotenv/config";
import { sendPaymentMessage } from "../src/payments/delivery";
import { paymentDestination } from "../src/payments/requests";

async function main(): Promise<void> {
  if (process.argv[2] !== "--send-to-owner")
    throw new Error(
      "This sends one live test message. After owner approval, pass --send-to-owner.",
    );
  const ownerId = process.env.TELEGRAM_OWNER_USER_ID?.trim();
  if (!ownerId || !/^\d+$/.test(ownerId))
    throw new Error("Configure the owner's numeric Telegram user ID");
  const messageId = await sendPaymentMessage(
    ownerId,
    `Plutus delivery test, sent only to Aniket. No payment is requested and no ledger record was created.\n\nCopy-format check: \`${paymentDestination()}\` (click on the UPI ID to copy)`,
  );
  console.log(
    `Owner-only canary sent, message ID ${messageId}. Verify the inline-code UPI in Telegram.`,
  );
}

void main().catch(() => {
  console.error(
    "Canary failed or delivery is uncertain. Inspect the owner's Telegram chat before any retry. Do not retry automatically.",
  );
  process.exitCode = 1;
});
