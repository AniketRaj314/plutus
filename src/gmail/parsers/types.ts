export type TransactionSource = "idfc_cc" | "bobcard" | "amex" | "idfc_upi";

export interface EmailContent {
  from: string;
  subject: string;
  body: string;
}

export interface ParsedTransaction {
  id: string;
  source: TransactionSource;
  amount: number;
  merchant_raw: string | null;
  datetime: string;
  card_last4: string;
  raw_email_id: string;
  is_reversal: boolean;
}

export type ParsedFields = Omit<ParsedTransaction, "id" | "raw_email_id">;
