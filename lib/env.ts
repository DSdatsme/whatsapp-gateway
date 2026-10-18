export function getRequiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

// WhatsApp reports a sender as plain digits, so compare against digits even if the setting has a "+" or punctuation.
export function getRecipientNumber(): string {
  const digits = getRequiredEnv("WHATSAPP_RECIPIENT_NUMBER").replace(/[\s+().-]/g, "");
  if (!/^[1-9]\d{7,14}$/.test(digits)) {
    throw new Error("WHATSAPP_RECIPIENT_NUMBER must be a phone number with country code, e.g. +919876543210");
  }
  return digits;
}
