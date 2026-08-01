# WhatsApp Gateway

A small Next.js service that owns a single WhatsApp Business Cloud API phone number and exposes it to other apps/scripts as a send/receive/poll HTTP API, so consumers don't each have to talk to the Graph API directly.

Always sends to and receives from one fixed recipient number. Supports one-way notifications, accept/reject approval prompts, and free-text prompts, with replies delivered to a registered callback URL or recovered by polling.

## Endpoints

- `POST /api/send` — send a `notification`, `approval`, or `prompt` message.
- `GET|POST /api/webhook` — Meta's webhook verification handshake and inbound message/reply receiver.
- `GET /api/replies/:correlationId` — poll for the reply to a previously sent message.

## Client library

`client/` is a small standalone Node package (`whatsapp-gateway-client`) that wraps the HTTP API: `sendNotification`, `sendApproval`, `sendPrompt`.

## Environment variables

| Variable | Purpose |
|---|---|
| `WHATSAPP_TOKEN` | Graph API access token |
| `WHATSAPP_PHONE_ID` | WhatsApp Business phone number ID |
| `WHATSAPP_RECIPIENT_NUMBER` | Fixed recipient number for all sends |
| `WHATSAPP_APP_SECRET` | Used to verify `X-Hub-Signature-256` on inbound webhooks |
| `WHATSAPP_VERIFY_TOKEN` | Used for the webhook verification handshake |
| `GATEWAY_API_KEY` | Shared-secret bearer token consumers use to call `/api/send` and `/api/replies/:id` |
| `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN` | Upstash Redis credentials (pending-reply storage) |

See `.env.local.example` once scaffolded.

## Development

```bash
npm install
npm run dev
npm test
```
