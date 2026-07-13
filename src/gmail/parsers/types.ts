export type TransactionSource = "idfc_cc" | "bobcard" | "amex" | "idfc_upi";

export interface EmailContent {
  from: string;
  subject: string;
  body: string;
  htmlBody: string;
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
  currency: string;
  amount_inr: number | null;
  is_international: boolean;
  notes: string | null;
  envelope_impact: number | null;
  is_preauth: boolean;
  correlation_status?: string;
}

export type ParsedFields = Omit<ParsedTransaction, "id" | "raw_email_id">;
