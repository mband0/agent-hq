# Provider Onboarding Spec — Atlas HQ v1

**Task:** #571 — Provider onboarding research: define auth/connect flows  
**Sprint:** Atlas HQ — First-Time Experience  
**Author:** forge  
**Date:** 2026-04-02  
**Status:** Ready for review

---

## Overview

This document defines the v1 connection path for each supported provider in the Atlas HQ first-time experience. It answers:

- What auth/connect method is supported for each provider
- What the user must input
- How Atlas HQ validates the connection
- What credential material gets stored
- What flows are explicitly ruled out for v1

---

## 1. Anthropic

### v1 Connection Path: API Key

**Source:** [Anthropic API Overview](https://platform.claude.com/docs/en/api/overview)

#### How it works
Anthropic's API authenticates entirely via an API key in the `x-api-key` request header. There is no OAuth flow, user-login flow, or hosted-connect token mechanism available to third-party applications.

API keys are created and managed at:
- `https://platform.claude.com/settings/keys` (new console URL)

#### User-facing onboarding
1. User is prompted to enter their Anthropic API key
2. Atlas HQ shows a helper link: "Get your API key at platform.claude.com/settings/keys"
3. User pastes the key and clicks "Connect"
4. Atlas HQ tests the key by calling `GET https://api.anthropic.com/v1/models` with `x-api-key: <key>` and `anthropic-version: 2023-06-01`
5. On HTTP 200 → connection success, store key, display available models
6. On HTTP 401 → show "Invalid API key — check your key and try again"
7. On network error → show "Could not reach Anthropic API — check your connection"

#### What Atlas HQ stores
- API key (encrypted at rest)
- Provider slug: `anthropic`
- Display label (optional user-defined name)

#### Ruled out for v1
- **No OAuth / user-login flow** — Anthropic does not expose an OAuth endpoint for third-party app authorization. Do not imply or build a "Login with Anthropic" button.
- **No Claude setup-token / hosted-connect flow** — No such mechanism is documented or available for third-party programmatic integrations as of this spec date.
- AWS Bedrock and Vertex AI Claude paths are deferred to v2+.

---

## 2. OpenAI

### v1 Connection Path: API Key

**Source:** [OpenAI API Reference — Authentication](https://developers.openai.com/api/reference/overview#authentication)

#### How it works
OpenAI's API authenticates via an API key sent as an HTTP Bearer token:
```
Authorization: Bearer <OPENAI_API_KEY>
```
Optional headers for multi-org users: `OpenAI-Organization` and `OpenAI-Project`.

API keys are managed at: `https://platform.openai.com/settings/organization/api-keys`

#### User-facing onboarding
1. User is prompted to enter their OpenAI API key (`sk-...`)
2. Atlas HQ shows a helper link: "Get your API key at platform.openai.com"
3. User pastes the key and clicks "Connect"
4. Atlas HQ tests by calling `GET https://api.openai.com/v1/models` with `Authorization: Bearer <key>`
5. On HTTP 200 → success; store key; list available models
6. On HTTP 401 → "Invalid API key"
7. On HTTP 429 → "Rate limited — your key is valid but you've hit a usage limit"
8. On network error → "Could not reach OpenAI API"

#### Optional fields (advanced / not shown by default in v1)
- Organization ID (`OpenAI-Organization`) — surfaced as an optional "Advanced" field
- Project ID (`OpenAI-Project`) — surfaced as an optional "Advanced" field

#### What Atlas HQ stores
- API key (encrypted at rest)
- Organization ID (optional, plaintext)
- Project ID (optional, plaintext)
- Provider slug: `openai`

#### Ruled out for v1
- **No OAuth / user-login flow** — OpenAI does not expose a public OAuth authorization flow for third-party apps to obtain API access on behalf of a user. The platform UI is a first-party web app; there is no documented OAuth 2.0 client-credentials or authorization-code endpoint for third-party use. Do not build or imply a "Login with OpenAI" button.
- ChatGPT consumer login (chat.openai.com) is separate from the API platform and does not grant API access.

---

## 3. Google (Gemini)

### v1 Connection Path: Google AI Studio API Key

**Source:** [Gemini API Docs](https://ai.google.dev/gemini-api/docs), [API Key setup](https://ai.google.dev/gemini-api/docs/api-key)

#### How it works
Google's Gemini API (via Google AI Studio) authenticates using an API key passed as a query parameter or header:
```
GET https://generativelanguage.googleapis.com/v1beta/models?key=<API_KEY>
```
API keys are created in: `https://aistudio.google.com/app/apikey`

#### User-facing onboarding
1. User is prompted to enter their Google AI Studio API key
2. Atlas HQ shows helper link: "Get your API key at aistudio.google.com/app/apikey"
3. User pastes the key and clicks "Connect"
4. Atlas HQ validates by calling:
   `GET https://generativelanguage.googleapis.com/v1beta/models?key=<key>`
5. On HTTP 200 with model list → success; store key; populate model list
6. On HTTP 400/403 → "Invalid API key — check your key and try again"
7. On network error → "Could not reach Google AI API"

#### What Atlas HQ stores
- API key (encrypted at rest)
- Provider slug: `google`

#### Ruled out / deferred for v1
- **Google Cloud OAuth / service account credentials** — Vertex AI uses GCP service account JSON or application default credentials (ADC). This is a different integration path (Vertex AI, not AI Studio). Deferred to v2+.
- **Google OAuth user-login flow** — Not viable for granting Gemini API access to a third-party app; the AI Studio API key is per-user and not delegatable via OAuth consent screen in a practical first-party sense. Do not imply "Login with Google" grants API access.
- **Workspace / Cloud project scoping** — Deferred.

**v1 decision:** AI Studio key only. Single field, no project selection.

---

## 4. Ollama (Local / Self-hosted)

### v1 Connection Path: HTTP Base URL

**Source:** [Ollama API Docs](https://docs.ollama.com/api)

#### How it works
Ollama runs a local REST API server (default: `http://localhost:11434`). No authentication is required by default. Users can run Ollama on non-default ports or remote hosts (e.g., a local network server or a VM).

Key endpoints:
| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/api/version` | GET | Version/health check — returns `{"version":"..."}` |
| `/api/tags` | GET | List available local models — returns `{"models":[...]}` |
| `/api/generate` | POST | Text generation |
| `/api/chat` | POST | Chat completion |

#### User-facing onboarding
1. Atlas HQ shows a pre-filled host field: `http://localhost:11434`
2. User can edit the URL if Ollama is on a different host/port
3. User clicks "Connect" (or connection is attempted automatically on first display)
4. Atlas HQ tests connectivity by calling `GET <host>/api/tags`
   - A successful response (`200 + JSON with models array`) confirms Ollama is reachable and at least responsive
5. On success → display list of installed models from `/api/tags`; allow user to select default model
6. On failure → show contextual error guidance:

| Error condition | User message |
|----------------|--------------|
| Connection refused | "Ollama is not running at `<url>`. Start Ollama and try again." |
| Network unreachable / timeout | "Could not reach `<url>`. Check that Ollama is running and the URL is correct." |
| Empty model list | "Ollama is connected but no models are installed. Run `ollama pull <model>` to add one." |
| Non-200 response | "Unexpected response from Ollama. Check the URL and Ollama version." |

#### Default URL behavior
- Default: `http://localhost:11434` — pre-filled, no label required
- User can override with any valid HTTP/HTTPS URL
- No trailing slash normalization needed (strip on save)
- Store the base URL as-entered after stripping trailing slash

#### What Atlas HQ stores
- Base URL (plaintext — not a secret)
- Provider slug: `ollama`
- Last-known model list (refreshed on connect/reconnect)

#### Authentication
- None for default Ollama installations
- v1 does not support Ollama instances requiring HTTP basic auth or API keys (deferred)

#### Ruled out / deferred for v1
- **Ollama with auth headers** — Ollama can be proxied behind a reverse proxy with auth, but this is not a native Ollama feature. Deferred to v2+.
- **Automatic Ollama install/launch** — Atlas HQ does not install or start Ollama. User is responsible for having it running.
- **Model management UI** (pull/delete) — Out of scope for onboarding; future enhancement.

---

## 5. Provider Capability Matrix

| Provider | Connection Method | Required User Input | Validation Call | Credential Storage | User-login / OAuth | Notes |
|----------|------------------|---------------------|-----------------|--------------------|--------------------|-------|
| **Anthropic** | API Key | API key (`sk-ant-...`) | `GET /v1/models` → 200 | Encrypted API key | ❌ Not supported | No hosted-connect or setup-token flow exists for 3rd-party apps |
| **OpenAI** | API Key (Bearer) | API key (`sk-...`) | `GET /v1/models` → 200 | Encrypted API key | ❌ Not supported | Optional: org ID, project ID (advanced) |
| **Google** | AI Studio API Key | API key | `GET /v1beta/models?key=...` → 200 | Encrypted API key | ❌ Not viable for v1 | Vertex AI / OAuth deferred to v2+ |
| **Ollama** | HTTP Base URL | Base URL (default: `http://localhost:11434`) | `GET /api/tags` → 200 | Plaintext URL | N/A (no auth) | Empty model list is a soft warning, not a hard error |

---

## 6. Implementation Notes for Engineering

### Credential storage
- Cloud provider API keys must be encrypted at rest (AES-256 or equivalent)
- Ollama base URL is not a secret; plaintext storage is fine
- Never log API keys in any log level

### Validation pattern
All providers should use the same validation flow:
1. User submits credentials/URL
2. Atlas HQ fires a test call (listed above per provider)
3. Show inline spinner during test
4. On success: store credentials, advance onboarding
5. On failure: show specific error, do not advance, allow retry

### Error handling
- Distinguish between "credential rejected" (4xx) and "unreachable" (network error / timeout)
- For Ollama specifically, distinguish "no models" from "unreachable" — these are different states

### Model list
- After successful connection, fetch and cache the model list for display in the model selector
- Anthropic: `GET /v1/models`
- OpenAI: `GET /v1/models` (filter by `object: "model"` for chat-capable models as needed)
- Google: `GET /v1beta/models?key=<key>` (filter for `generateContent` capability)
- Ollama: `GET /api/tags` (returns `models[].name`)

---

## 7. What This Spec Does NOT Cover (Deferred)

- AWS Bedrock / Vertex AI (GCP) — cloud enterprise paths, v2+
- Ollama with reverse proxy auth
- Multi-workspace / multi-key management
- Key rotation or re-auth UX
- OAuth for any provider (none currently viable for v1)
