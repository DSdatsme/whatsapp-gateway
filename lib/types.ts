export type PendingType = "notification" | "approval" | "prompt" | "select" | "template";

export interface PendingRecord {
  status: "pending" | "replied";
  type: PendingType;
  callbackUrl?: string;
  whatsappMessageId: string;
  createdAt: number;
  value?: string;
  receivedAt?: number;
  options?: string[];
}
