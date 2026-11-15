// One registry for discovery and diagnostics. Keep exact issuer mailboxes;
// matching a display name or a domain substring is not sender validation.
export const TRANSACTION_SENDERS = {
  amex: [
    "AmericanExpress@welcome.americanexpress.com",
    "donotreply@communication.americanexpress.co.in",
  ],
  bobcard: ["no-reply@getonecard.app"],
  idfc: ["noreply@idfcfirstbank.com"],
  icici: ["credit_cards@icici.bank.in"],
} as const;

export function isAmexSender(from: string): boolean {
  const match = from.trim().match(/^(?:[^<>]*<\s*([^<>\s]+)\s*>|([^<>\s]+))$/);
  const address = (match?.[1] ?? match?.[2])?.toLowerCase();
  return TRANSACTION_SENDERS.amex.some(
    (sender) => sender.toLowerCase() === address,
  );
}

export function isAmexTransactionSubject(subject: string): boolean {
  return /^your\s+transaction\s+update$/i.test(subject.trim());
}
