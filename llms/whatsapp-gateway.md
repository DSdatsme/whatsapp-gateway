# WhatsApp Gateway — Agent Integration Guide

This file is written for an LLM/AI agent that needs to notify a human, ask for approval, or ask a free-text question over WhatsApp, and get the reply back programmatically. It's self-contained — you shouldn't need anything else to integrate. (Human-oriented docs: [`../README.md`](../README.md).)

## What this is

A hosted HTTP gateway in front of one WhatsApp Business phone number. You call it over plain HTTP; it handles the WhatsApp Cloud API details. Five operations:

- **notification** — push a message, no reply expected.
- **approval** — push a yes/no question with buttons, get back `true`/`false`.
- **prompt** — push an open-ended question, get back free text.
- **select** — push a question with 2-10 labeled options, get back the exact label the human picked.
- **template** — push a pre-approved WhatsApp template message, delivered regardless of whether a 24-hour session is open. No reply is tracked.

Every send returns a `correlationId` immediately (it does not wait for a reply). To get the reply, poll `GET /api/replies/:correlationId` until its status flips to `replied`.

Every operation always goes to the gateway operator's own fixed number — that never changes. Add `"also": "<digits-only E.164, no +>"` to any request body to *additionally* send a copy to a second number for that one call — see "Sending an extra copy to another recipient" below before relying on this for a non-template type.

## Before you integrate

You need three things from whoever runs this gateway — ask for them if you don't have them, don't guess or invent values:

- `GATEWAY_BASE_URL` — the deployed gateway's URL (e.g. `https://whatsapp-gateway.darshitkumarsuratwala.store`).
- `GATEWAY_API_KEY` — bearer token for the `Authorization` header.

All requests below use `Authorization: Bearer $GATEWAY_API_KEY`.

## Operation 1: notification (fire-and-forget)

```bash
curl -X POST "$GATEWAY_BASE_URL/api/send" \
  -H "Authorization: Bearer $GATEWAY_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"type": "notification", "text": "Nightly job finished."}'
```

Response: `{"correlationId": "<uuid>", "messageId": "wamid...."}`, HTTP 200. Nothing more to do — no reply is expected or tracked for this type. Keep `messageId` if you want to check later whether it was actually delivered (see "Checking delivery and the 24-hour window" below).

A plain `notification` is free-form text, which WhatsApp only delivers when the human has messaged the business number in the last 24 hours — otherwise it is dropped silently. To make a notification arrive either way, add a `fallbackTemplate`:

```bash
curl -X POST "$GATEWAY_BASE_URL/api/send" \
  -H "Authorization: Bearer $GATEWAY_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "type": "notification",
    "text": "Nightly job finished.",
    "fallbackTemplate": {"name": "test_utility_basic", "language": "en", "params": ["nightly-job", "Nightly job finished."]}
  }'
```

- If the 24-hour window is open the `text` is sent as-is; if it is closed, closes within two minutes, or the gateway can't tell, the template is sent instead and the response includes `"viaTemplate": true`.
- The gateway learns the window state from the human's inbound messages, so right after a fresh deploy it treats the window as closed — and sends the template — until they message the number once.
- `fallbackTemplate` is only valid on `notification` (anything else gets a 400). The template rules from Operation 5 apply: it must be Approved, and `params` can't contain newlines or tabs.
- An `also` copy always goes out as the template, since only the primary recipient's window is tracked.

## Operation 2: approval (yes/no, human taps a button)

```bash
curl -X POST "$GATEWAY_BASE_URL/api/send" \
  -H "Authorization: Bearer $GATEWAY_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "type": "approval",
    "text": "Deploy v2.3 to production?",
    "correlationId": "deploy-42"
  }'
```

- `correlationId` is optional — omit it and the gateway generates one, returned in the response. If you supply one it must be 1-128 characters of letters, digits, `.`, `_`, `:` or `-` (`notification` and `template` don't use it, so they don't check it). Supply your own (e.g. a job id) if you want a predictable, human-meaningful id.
- Optional `approveLabel` / `denyLabel` (default `"Approve"` / `"Deny"`) override the button text.
- Poll for the result (see below). The reply `value` is the literal string `"approve"` or `"deny"`.

## Operation 3: prompt (open-ended, human replies with text)

```bash
curl -X POST "$GATEWAY_BASE_URL/api/send" \
  -H "Authorization: Bearer $GATEWAY_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "type": "prompt",
    "text": "What should I name this release?",
    "correlationId": "release-name-1"
  }'
```

Poll for the result the same way. The reply `value` is whatever free text the human sent.

**Important:** only one `prompt` should be outstanding at a time. If a second `prompt` is sent before the first is answered, and the human replies without explicitly swipe-replying to a specific message, the gateway cannot tell which question the reply is answering — it resolves to whichever `prompt` was sent most recently. Send one, wait for its reply, then send the next.

Any plain **text** message the human sends while a `prompt` is pending is taken as its answer — including an unrelated one such as a "hi" sent just to reopen the 24-hour window. Images, stickers and other non-text messages are ignored for this purpose.

## Operation 4: select (pick one of several options)

```bash
curl -X POST "$GATEWAY_BASE_URL/api/send" \
  -H "Authorization: Bearer $GATEWAY_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "type": "select",
    "text": "Which environment?",
    "options": ["staging", "production"],
    "correlationId": "env-pick-1"
  }'
```

- `options` is required for this type: an array of 2-10 plain-text labels. Anything outside that range gets a 400.
- Poll for the result the same way as the others. The reply `value` is the exact label string the human picked (e.g. `"production"`), not an index.
- The Node client library wraps this as `gateway.sendSelect(text, options)` — see below.

## Operation 5: template (guaranteed delivery via a pre-approved template)

```bash
curl -X POST "$GATEWAY_BASE_URL/api/send" \
  -H "Authorization: Bearer $GATEWAY_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "type": "template",
    "templateName": "test_utility_basic",
    "templateLanguage": "en",
    "templateParams": ["backup-service", "OK"]
  }'
```

- The template must already exist and show **Approved** in Meta's WhatsApp Manager — this operation can only reference one, never create one.
- `templateParams` is positional: the first string fills `{{1}}` in the template body, the second fills `{{2}}`, and so on.
- Unlike the other four operations, this is unconditionally delivered — it does not require the human to have messaged the business number recently. Use it for genuinely critical alerts where a silently-dropped `notification` isn't acceptable.
- No reply is expected or tracked for this type; don't poll `/api/replies/:correlationId` for it.

## Sending an extra copy to another recipient

```bash
curl -X POST "$GATEWAY_BASE_URL/api/send" \
  -H "Authorization: Bearer $GATEWAY_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"type": "notification", "text": "Nightly job finished.", "also": "919876543210"}'
```

- `also` must be digits only, E.164 format, no leading `+` (8-15 digits) — anything else gets a 400.
- This is additive, not a replacement: the default `WHATSAPP_RECIPIENT_NUMBER` always receives the message too. `also` never suppresses it.
- Replies aren't correlated for the `also` recipient — only the default recipient's reply resolves `GET /api/replies/:correlationId`, so don't rely on `also` for `approval`/`prompt`/`select` if you need that second person's answer tracked; it's meant for CC'ing a heads-up, not for routing the interactive flow to them.
- The response carries `alsoMessageId` for the copy, so you can check its delivery with `GET /api/messages/:messageId`, and `alsoNumber` (the WhatsApp id Meta resolved the number to). For 7 days after a copy, that person's messages to the business number are kept and readable at `GET /api/inbox?from=<alsoNumber>`; they never answer an approval, prompt or select. If `alsoWatchError` is present the copy was sent but its replies may not be captured.
- If the extra send to `also` fails, the primary send to the default recipient still succeeds — the response includes an `alsoError` field describing the failure, but the request itself still returns 200 with a valid `correlationId`.
- **The 24-hour session window still applies per-recipient.** `notification`/`approval`/`prompt`/`select` are all free-form messages — WhatsApp silently drops them (Graph API still returns 200) if the `also` recipient hasn't messaged the business number within the last 24 hours. For a recipient who has never opened a session with this business number, use `type: "template"` instead, which delivers unconditionally.

## Polling for a reply

```bash
curl "$GATEWAY_BASE_URL/api/replies/deploy-42" \
  -H "Authorization: Bearer $GATEWAY_API_KEY"
```

Responses:
- `{"status": "pending"}` — no reply yet. Wait and retry (5-10 second intervals are reasonable; a human needs time to see a phone notification and respond — don't poll faster than every couple of seconds, and be prepared to wait several minutes, not seconds).
- `{"status": "replied", "value": "approve", "receivedAt": <epoch-ms>}` — done. `value` is `"approve"`/`"deny"` for approvals, free text for prompts, or the picked option's label for `select`.
- `404 {"error": "not found"}` — unknown `correlationId`, or its record expired (pending records have a 24h TTL). Only `approval`, `prompt` and `select` sends create a record, so a `notification` or `template` correlationId always 404s here.

If `POST /api/send` returns **500** with `"sent": true` for one of those three types, the message *did* go out but the gateway couldn't store the record needed to match its reply, so polling will never succeed. The body includes the `messageId` and `correlationId`. Don't retry blindly — that sends a duplicate; tell the operator instead.

## Checking delivery and the 24-hour window

```bash
# Did a specific message actually arrive? (use the messageId from the send response)
curl "$GATEWAY_BASE_URL/api/messages/wamid.HBgL..." -H "Authorization: Bearer $GATEWAY_API_KEY"

# Can free-form text be delivered right now, and until when?
curl "$GATEWAY_BASE_URL/api/window" -H "Authorization: Bearer $GATEWAY_API_KEY"
```

- `GET /api/messages/:messageId` → `{"messageId", "status": "sent"|"delivered"|"read"|"failed", "updatedAt": <epoch-ms>, "recipient"?, "error"?}`. For `failed`, `error` carries Meta's `code`, `title` and `details` — code `131047` means the 24-hour window was closed. WhatsApp reports statuses a few seconds after a send, so a 404 straight after sending can just mean "not yet"; ids are kept for 24 hours.
- `GET /api/inbox?since=<epoch-ms>&limit=<1-200>` → `{"messages": [{"id", "type", "text"?, "timestamp", "contextMessageId"?}]}`, oldest first by arrival: what the human has sent the business number (text, quick-reply taps, reactions as their emoji, media by type). Use it to see a reply to a `notification` or `template`, which have no `correlationId`. `contextMessageId` is set when they swipe-replied or reacted to one of your messages; otherwise a message is only known to have arrived after yours. Only the human's own messages are kept (200 max, 7 days), The default response is only the human's own messages; messages from a number used as `also` in the last 7 days are kept separately and returned only with `?from=<number>`.
- `GET /api/window` → `{"open": boolean, "lastInboundAt": <epoch-ms>|null, "expiresAt": <epoch-ms>|null}`. `open` is false when the human has never messaged the number or last did more than 24 hours ago.

## Recipe: block on human approval before taking an action

```python
import os, time, requests

BASE = os.environ["GATEWAY_BASE_URL"]
HEADERS = {"Authorization": f"Bearer {os.environ['GATEWAY_API_KEY']}"}

def ask_approval(text: str, correlation_id: str, timeout_s: int = 600, interval_s: int = 5) -> bool:
    requests.post(f"{BASE}/api/send", headers=HEADERS, json={
        "type": "approval", "text": text, "correlationId": correlation_id,
    }).raise_for_status()

    deadline = time.time() + timeout_s
    while time.time() < deadline:
        time.sleep(interval_s)
        r = requests.get(f"{BASE}/api/replies/{correlation_id}", headers=HEADERS).json()
        if r.get("status") == "replied":
            return r["value"] == "approve"
    raise TimeoutError(f"no reply to {correlation_id} within {timeout_s}s")

if ask_approval("Proceed with deploy?", "deploy-42"):
    ...  # proceed
else:
    ...  # abort
```

Node/TypeScript agents in a project that can install a local package can use the bundled client instead of hand-rolling HTTP calls — `npm install <path-to-gateway-repo>/client`, then:

```ts
import { createClient } from "whatsapp-gateway-client";
const gateway = createClient({ baseUrl: process.env.GATEWAY_BASE_URL!, apiKey: process.env.GATEWAY_API_KEY! });
const approved = await gateway.sendApproval("Proceed with deploy?");
const releaseName = await gateway.sendPrompt("What should I name this release?");
const environment = await gateway.sendSelect("Which environment?", ["staging", "production"]);
await gateway.sendTemplate("test_utility_basic", "en", ["backup-service", "OK"]);
```

`sendApproval`/`sendPrompt`/`sendSelect` each accept an optional `{ correlationId, pollIntervalMs, timeoutMs, also }` object as a last argument to override the id, the poll timing, or CC a second recipient (defaults: poll every 5s, give up after 10 minutes and throw `GatewayError`). `sendNotification(text, { also, fallbackTemplate })` and `sendTemplate(name, lang, params, { correlationId, also })` accept the same `also`.

`sendNotification` resolves to `{ correlationId, messageId, viaTemplate? }`. Three more methods mirror the endpoints above: `gateway.getMessageStatus(messageId)` (resolves to the status, or `null` if none has arrived yet), `gateway.getWindow()` and `gateway.getInbox({ since, limit })`.

## Things that will trip you up if you don't know about them

- **A 200 response from `/api/send` does not mean the message was delivered**, only that the gateway accepted the request and forwarded it to WhatsApp. Look the `messageId` up with `GET /api/messages/:messageId` to see what actually happened. If a human reports never seeing a message, the cause is almost always on the WhatsApp/Meta side (session window closed, recipient not verified for a test number) — see the main README's Troubleshooting section. Don't assume your integration code is broken; check with the gateway operator first.
- **Timeouts are normal, not errors.** A human might not see their phone for a while. Don't treat a `pending` status as failure — keep polling within a generous timeout (minutes, not seconds) before giving up.
- **One correlationId, one question.** Don't reuse a `correlationId` for a new question — each `POST /api/send` should get a fresh one (or let the gateway generate it) so replies don't cross-resolve.
- **Auth failures return 401**, not a silently-ignored request — if you get 401, your `GATEWAY_API_KEY` is wrong, not a transient issue worth retrying blindly.
