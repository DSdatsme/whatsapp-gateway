# WhatsApp Gateway — Agent Integration Guide

This file is written for an LLM/AI agent that needs to notify a human, ask for approval, or ask a free-text question over WhatsApp, and get the reply back programmatically. It's self-contained — you shouldn't need anything else to integrate. (Human-oriented docs: [`../README.md`](../README.md).)

## What this is

A hosted HTTP gateway in front of one WhatsApp Business phone number. You call it over plain HTTP; it handles the WhatsApp Cloud API details. Three operations:

- **notification** — push a message, no reply expected.
- **approval** — push a yes/no question with buttons, get back `true`/`false`.
- **prompt** — push an open-ended question, get back free text.

Every send returns a `correlationId` immediately (it does not wait for a reply). To get the reply, poll `GET /api/replies/:correlationId` until its status flips to `replied`.

## Before you integrate

You need three things from whoever runs this gateway — ask for them if you don't have them, don't guess or invent values:

- `GATEWAY_BASE_URL` — the deployed gateway's URL (e.g. `https://whatsapp-gateway-pi.vercel.app`).
- `GATEWAY_API_KEY` — bearer token for the `Authorization` header.

All requests below use `Authorization: Bearer $GATEWAY_API_KEY`.

## Operation 1: notification (fire-and-forget)

```bash
curl -X POST "$GATEWAY_BASE_URL/api/send" \
  -H "Authorization: Bearer $GATEWAY_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"type": "notification", "text": "Nightly job finished."}'
```

Response: `{"correlationId": "<uuid>"}`, HTTP 200. Nothing more to do — no reply is expected or tracked meaningfully for this type.

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

- `correlationId` is optional — omit it and the gateway generates one, returned in the response. Supply your own (e.g. a job id) if you want a predictable, human-meaningful id.
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

## Polling for a reply

```bash
curl "$GATEWAY_BASE_URL/api/replies/deploy-42" \
  -H "Authorization: Bearer $GATEWAY_API_KEY"
```

Responses:
- `{"status": "pending"}` — no reply yet. Wait and retry (5-10 second intervals are reasonable; a human needs time to see a phone notification and respond — don't poll faster than every couple of seconds, and be prepared to wait several minutes, not seconds).
- `{"status": "replied", "value": "approve", "receivedAt": <epoch-ms>}` — done. `value` is `"approve"`/`"deny"` for approvals, free text for prompts.
- `404 {"error": "not found"}` — unknown `correlationId`, or its record expired (pending records have a 24h TTL).

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
```

## Things that will trip you up if you don't know about them

- **A 200 response from `/api/send` does not mean the message was delivered**, only that the gateway accepted the request and forwarded it to WhatsApp. If a human reports never seeing a message, the cause is almost always on the WhatsApp/Meta side (session window closed, recipient not verified for a test number) — see the main README's Troubleshooting section. Don't assume your integration code is broken; check with the gateway operator first.
- **Timeouts are normal, not errors.** A human might not see their phone for a while. Don't treat a `pending` status as failure — keep polling within a generous timeout (minutes, not seconds) before giving up.
- **One correlationId, one question.** Don't reuse a `correlationId` for a new question — each `POST /api/send` should get a fresh one (or let the gateway generate it) so replies don't cross-resolve.
- **Auth failures return 401**, not a silently-ignored request — if you get 401, your `GATEWAY_API_KEY` is wrong, not a transient issue worth retrying blindly.
