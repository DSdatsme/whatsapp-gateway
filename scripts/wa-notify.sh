#!/usr/bin/env bash
# Sends a WhatsApp template alert through the gateway; safe to run from cron.
# Usage: wa-notify.sh [-t TEMPLATE] [-l LANG] [-s SOURCE] [-n] [--] [MESSAGE...]
#   message comes from stdin when no arguments are given; -n prints the payload instead of sending
#   use -- before a message that starts with "-"
# Config: WHATSAPP_GATEWAY_API_KEY and optional WHATSAPP_GATEWAY_URL, from the environment or ~/.config/whatsapp-gateway/env
set -euo pipefail

export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:$PATH" # cron's PATH is minimal

DEFAULT_URL="https://whatsapp-gateway.darshitkumarsuratwala.store"
CONFIG_FILE="$HOME/.config/whatsapp-gateway/env"
MAX_PARAM_CHARS="${WA_MAX_PARAM_CHARS:-700}"

log() { printf '%s wa-notify: %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*"; }
fail() { log "$*" >&2; exit 1; }

command -v jq >/dev/null || fail "jq not found on PATH ($PATH)"

template="${WA_TEMPLATE:-test_utility_basic}"
lang="${WA_LANG:-en}"
source_label="$(hostname -s)"
dry_run=0

while getopts ":t:l:s:n" opt; do
  case "$opt" in
    t) template="$OPTARG" ;;
    l) lang="$OPTARG" ;;
    s) source_label="$OPTARG" ;;
    n) dry_run=1 ;;
    :) fail "option -$OPTARG needs a value" ;;
    *) fail "usage: wa-notify.sh [-t TEMPLATE] [-l LANG] [-s SOURCE] [-n] [MESSAGE...]" ;;
  esac
done
shift $((OPTIND - 1))

if [[ $# -gt 0 ]]; then
  message="$*"
elif [[ ! -t 0 ]]; then
  message="$(cat)"
else
  fail "no message: pass it as arguments or on stdin"
fi

# Templates reject newlines, tabs and runs of spaces in params; jq also truncates by character whatever the locale.
flatten() {
  jq -Rrs --argjson max "$MAX_PARAM_CHARS" '
    gsub("\\s+"; " ") | sub("^ "; "") | sub(" $"; "")
    | if length > $max then .[0:$max - 1] + "…" else . end'
}
message="$(printf '%s' "$message" | flatten)"
source_label="$(printf '%s' "$source_label" | flatten)"
[[ -n "$message" ]] || fail "message is empty"
[[ -n "$source_label" ]] || fail "source label is empty"

body="$(jq -n --arg name "$template" --arg lang "$lang" --arg src "$source_label" --arg msg "$message" \
  '{type: "template", templateName: $name, templateLanguage: $lang, templateParams: [$src, $msg]}')"

if [[ "$dry_run" == 1 ]]; then
  log "dry run, not sending: $body"
  exit 0
fi

url="${WHATSAPP_GATEWAY_URL:-}"
key="${WHATSAPP_GATEWAY_API_KEY:-}"
if [[ -f "$CONFIG_FILE" ]]; then
  # shellcheck disable=SC1090
  source "$CONFIG_FILE"
  url="${url:-${WHATSAPP_GATEWAY_URL:-}}"
  key="${key:-${WHATSAPP_GATEWAY_API_KEY:-}}"
fi
url="${url:-$DEFAULT_URL}"
[[ -n "$key" ]] || fail "no API key: set WHATSAPP_GATEWAY_API_KEY in the environment or in $CONFIG_FILE"

response="$(curl -sS --max-time 30 -w $'\n%{http_code}' -X POST "$url/api/send" \
  -H @<(printf 'Authorization: Bearer %s\nContent-Type: application/json\n' "$key") \
  --data-binary @<(printf '%s' "$body"))" || fail "could not reach $url (not retrying: the message may or may not have gone out)"
status="${response##*$'\n'}"
payload="${response%$'\n'*}"

case "$status" in
  200) log "accepted by WhatsApp, not yet confirmed delivered: $payload" ;;
  5??) fail "gateway returned HTTP $status ${payload:-(empty body)} (not retrying: the message may already have been sent)" ;;
  *)   fail "gateway returned HTTP $status ${payload:-(empty body)}" ;;
esac
