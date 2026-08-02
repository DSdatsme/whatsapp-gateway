# WhatsApp Gateway

A small Next.js service that owns a single WhatsApp Business Cloud API phone number and exposes it to other apps/scripts as a send/receive/poll HTTP API, so consumers don't each have to talk to the Graph API directly.

Always sends to and receives from one fixed recipient number. Supports one-way notifications, accept/reject approval prompts, and free-text prompts, with replies delivered to a registered callback URL or recovered by polling.

## Endpoints

- `POST /api/send` — send a `notification`, `approval`, or `prompt` message.
- `GET|POST /api/webhook` — Meta's webhook verification handshake and inbound message/reply receiver.
- `GET /api/replies/:correlationId` — poll for the reply to a previously sent message.

## `/api/send` request shape

`POST /api/send` accepts a JSON body:

| Field | Required | Notes |
|---|---|---|
| `type` | yes | One of `"notification"`, `"approval"`, `"prompt"`. |
| `text` | yes | The message body sent to the recipient. |
| `correlationId` | no | Caller-supplied id used to correlate replies. Auto-generated (a UUID) if omitted. |
| `approveLabel` | no | Button label for `approval` messages (defaults to `"Approve"`). |
| `denyLabel` | no | Button label for `approval` messages (defaults to `"Deny"`). |
| `callbackUrl` | no | If set, the reply is POSTed to this URL instead of (or in addition to) being available via `GET /api/replies/:correlationId`. |

Response is `{ "correlationId": "..." }` on success (200), or `{ "error": "..." }` on failure (400 for invalid input, 502 if the Graph API call fails).

## Client library

`client/` is a small standalone Node package (`whatsapp-gateway-client`) that wraps the HTTP API: `sendNotification`, `sendApproval`, `sendPrompt`. It's not published to a registry — `client/dist` is gitignored, and consumers reference it locally, e.g.:

```bash
npm install <path-to-this-repo>/client
```

A `prepare` script in `client/package.json` runs `tsc` automatically on install, so `dist/` is built for you. Usage:

```ts
import { createClient } from "whatsapp-gateway-client";

const gateway = createClient({ baseUrl: "https://<your-deployment-url>", apiKey: "..." });

const approved = await gateway.sendApproval("Deploy to prod?");
```

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

See `.env.local.example` for the full list.

## Development

```bash
npm install
npm run dev
npm test
```

## Deploying

This is a standard Next.js app and deploys to Vercel like any other:

```bash
vercel        # preview deployment
vercel --prod # production deployment
```

- Set all the environment variables listed above in the Vercel dashboard under **Project Settings → Environment Variables** (for Preview and/or Production as appropriate).
- Upstash Redis needs to be provisioned — the easiest way is via the Vercel Marketplace integration for Upstash, which will provision a database and populate `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN` for you automatically. If you provision Redis another way, set those two variables manually instead.

## Registering the webhook with Meta

Once deployed, point Meta at your gateway:

1. In the [Meta App Dashboard](https://developers.facebook.com/apps/), open your app and go to **WhatsApp → Configuration**.
2. Set the **Callback URL** to `https://<your-deployment-url>/api/webhook`.
3. Set the **Verify Token** to the same value as your `WHATSAPP_VERIFY_TOKEN` environment variable.
4. Click **Verify and Save**. Meta will call `GET /api/webhook` to complete the handshake before saving.

## Known limitations

- Resolving a free-text reply with no explicit reply-to (i.e. not a swipe-reply) falls back to the single most-recently-sent pending prompt. If two `prompt` sends are outstanding at the same time and the user doesn't swipe-reply to a specific message, the gateway can't disambiguate which one the reply is for.
- Swipe-replying to a `notification` or `approval` message (rather than a `prompt`) isn't correlated via `context.id`, since only `prompt`-type sends are indexed by WhatsApp message id.
