export type PendingType = "notification" | "approval" | "prompt";

export interface PendingRecord {
  status: "pending" | "replied";
  type: PendingType;
  callbackUrl?: string;
  whatsappMessageId: string;
  createdAt: number;
  value?: string;
  receivedAt?: number;
}
