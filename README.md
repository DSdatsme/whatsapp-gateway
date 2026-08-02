# WhatsApp Gateway

A small hosted service that owns one WhatsApp Business Cloud API phone number and exposes it over a plain HTTP API — send a notification, ask a yes/no approval question, or ask an open-ended question, and get the reply back — so none of your other apps or scripts have to talk to Meta's Graph API directly.

Built for one person's own WhatsApp number acting as a personal notification/approval channel for multiple independent apps and scripts: every consumer sends through this one gateway, and every reply gets routed back to whichever consumer asked the question.

## Quickstart: deploying your own gateway

1. **Get WhatsApp Cloud API credentials** from the [Meta App Dashboard](https://developers.facebook.com/apps/): create/open an app with the WhatsApp product added, then grab the access token and phone number ID from **WhatsApp → API Setup**.
2. **Deploy to Vercel:**
   ```bash
   npm install
   vercel --prod
   ```
3. **Set environment variables** in the Vercel dashboard (Project Settings → Environment Variables) — see the [Environment variables](#environment-variables) table below for the full list. `WHATSAPP_VERIFY_TOKEN` and `GATEWAY_API_KEY` aren't issued by Meta — make up any random strings for those yourself.
4. **Provision Redis:** add the Upstash integration from the Vercel Marketplace (Storage tab) — it provisions a database and sets `UPSTASH_REDIS_REST_URL`/`UPSTASH_REDIS_REST_TOKEN` automatically.
5. **Register the webhook with Meta** — this is two separate steps people commonly miss one of:
   - In **WhatsApp → Configuration**, set the Callback URL to `https://<your-deployment>/api/webhook` and the Verify Token to your `WHATSAPP_VERIFY_TOKEN`, click **Verify and Save**, then subscribe to the **messages** field.
   - Separately, subscribe your WhatsApp Business Account (WABA) to send its events through this app — see [Troubleshooting](#troubleshooting) below, this step is easy to miss and nothing will tell you it's missing.
6. Redeploy (`vercel --prod`) after setting env vars so the running functions actually pick them up.

## Using it from your code

Every consumer talks to the gateway the same way, whatever language it's written in: `POST /api/send` to send something, then either register a `callbackUrl` or poll `GET /api/replies/:correlationId` to get the reply back.

### Node / TypeScript (client library)

`client/` is a small standalone package (`whatsapp-gateway-client`) that wraps the HTTP API. It isn't published to a registry — reference it locally from another project:

```bash
npm install <path-to-this-repo>/client
```

```ts
import { createClient } from "whatsapp-gateway-client";

const gateway = createClient({
  baseUrl: "https://<your-deployment>",
  apiKey: process.env.GATEWAY_API_KEY!,
});

// Fire-and-forget — no reply expected
await gateway.sendNotification("Nightly backup finished successfully.");

// Ask a yes/no question; polls (up to 10 minutes by default) until answered
const approved = await gateway.sendApproval("Deploy v2.3 to production?");
if (approved) {
  // proceed
}

// Ask an open-ended question; polls until a free-text reply arrives
const releaseName = await gateway.sendPrompt("What should I name this release?");
```

### Any other language (raw HTTP)

There's no client library for non-Node consumers yet — just call the HTTP API directly. Python example using `requests`:

```python
import os
import time

import requests

BASE_URL = "https://<your-deployment>"
HEADERS = {"Authorization": f"Bearer {os.environ['GATEWAY_API_KEY']}"}

# Send an approval request
resp = requests.post(
    f"{BASE_URL}/api/send",
    headers=HEADERS,
    json={
        "type": "approval",
        "text": "Proceed with deploy?",
        "correlationId": "deploy-42",
    },
)
correlation_id = resp.json()["correlationId"]

# Poll until answered
while True:
    time.sleep(5)
    reply = requests.get(
        f"{BASE_URL}/api/replies/{correlation_id}", headers=HEADERS
    ).json()
    if reply["status"] == "replied":
        approved = reply["value"] == "approve"
        break
```

The same shape works from a shell script with `curl`, a cron job, a CI pipeline — anything that can make an HTTP request.

## API Reference

### Endpoints

- `POST /api/send` — send a `notification`, `approval`, or `prompt` message.
- `GET|POST /api/webhook` — Meta's webhook verification handshake and inbound message/reply receiver (Meta calls this, you don't).
- `GET /api/replies/:correlationId` — poll for the reply to a previously sent message.

### `POST /api/send` request shape

| Field | Required | Notes |
|---|---|---|
| `type` | yes | One of `"notification"`, `"approval"`, `"prompt"`. |
| `text` | yes | The message body sent to the recipient. |
| `correlationId` | no | Caller-supplied id used to correlate replies. Auto-generated (a UUID) if omitted. |
| `approveLabel` | no | Button label for `approval` messages (defaults to `"Approve"`). |
| `denyLabel` | no | Button label for `approval` messages (defaults to `"Deny"`). |
| `callbackUrl` | no | If set, the reply is POSTed to this URL instead of (or in addition to) being available via `GET /api/replies/:correlationId`. |

Response is `{ "correlationId": "..." }` on success (200), or `{ "error": "..." }` on failure (400 for invalid input, 502 if the Graph API call fails).

### Environment variables

| Variable | Purpose |
|---|---|
| `WHATSAPP_TOKEN` | Graph API access token |
| `WHATSAPP_PHONE_ID` | WhatsApp Business phone number ID |
| `WHATSAPP_RECIPIENT_NUMBER` | Fixed recipient number for all sends |
| `WHATSAPP_APP_SECRET` | Used to verify `X-Hub-Signature-256` on inbound webhooks |
| `WHATSAPP_VERIFY_TOKEN` | Used for the webhook verification handshake (you make this up) |
| `GATEWAY_API_KEY` | Shared-secret bearer token consumers use to call `/api/send` and `/api/replies/:id` (you make this up) |
| `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN` | Upstash Redis credentials (pending-reply storage) |

See `.env.local.example` for the same list as a template.

## Development

```bash
npm install
npm run dev
npm test
```

## Troubleshooting

### `/api/send` returns 200 but nothing arrives on WhatsApp

Graph API returns `200` with a real message ID as soon as it *accepts* a message — that does not mean it was actually delivered. Two common reasons a message silently never arrives, neither of which is a bug in this gateway:

1. **Using a test/sandbox WhatsApp number.** The free test number Meta provisions in **WhatsApp → API Setup** can only message phone numbers explicitly added and OTP-verified as test recipients. Add the recipient there (**API Setup → "To" field → Manage phone number list**) before expecting any delivery.
2. **The 24-hour customer service window is closed.** WhatsApp only allows free-form messages (which is everything this gateway sends — `notification`, `approval`, and `prompt` are all free-form, not templates) to a recipient who has messaged the business number within the last 24 hours. If the recipient hasn't messaged first (or it's been >24h since they last did), Graph API still returns 200, but the message is dropped. Have the recipient send any message to the business number to open the window, then retry. A pre-approved **template** message is the only message type exempt from this rule — useful for confirming your token/phone ID/recipient setup is otherwise correct without needing an open session.

### Sends arrive but replies never reach `/api/webhook`

Registering the callback URL and subscribing to the `messages` field (both covered in Quickstart) configure your **app's** webhook — but that's not enough on its own. The WhatsApp Business Account (WABA) that owns your phone number also has to be explicitly told to route its events through *this* app, which is a separate step Meta doesn't surface clearly in the dashboard:

```bash
curl -X POST "https://graph.facebook.com/v21.0/<WABA_ID>/subscribed_apps?access_token=<WHATSAPP_TOKEN>"
```

If you're not sure whether this is already done, check first:

```bash
curl "https://graph.facebook.com/v21.0/<WABA_ID>/subscribed_apps?access_token=<WHATSAPP_TOKEN>"
```

If the response doesn't list your app, that's why button taps and replies never show up in `POST /api/webhook` even though sending works fine. New WABAs can come pre-subscribed to an unrelated default app instead of yours — subscribing your app doesn't remove others, so this is safe to run even if you're unsure.

To find your WABA ID: open **Meta App Dashboard → your app → WhatsApp → API Setup**, or check the URL when viewing the WhatsApp product (`.../whatsapp-business/overview/?business_id=<BUSINESS_ID>`) and query `GET /<BUSINESS_ID>/owned_whatsapp_business_accounts` with an access token that has `whatsapp_business_management` scope.

## Known limitations

- Resolving a free-text reply with no explicit reply-to (i.e. not a swipe-reply) falls back to the single most-recently-sent pending prompt. If two `prompt` sends are outstanding at the same time and the user doesn't swipe-reply to a specific message, the gateway can't disambiguate which one the reply is for.
- Swipe-replying to a `notification` or `approval` message (rather than a `prompt`) isn't correlated via `context.id`, since only `prompt`-type sends are indexed by WhatsApp message id.
- The client library is Node-only; other languages use the raw HTTP API directly (see [Using it from your code](#using-it-from-your-code)).

## License

MIT — see [LICENSE](./LICENSE).
