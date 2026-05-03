# Onboarding Provider Gate Spec — Agent HQ v1

**Task:** #572 — First-time setup spec: require at least one provider before onboarding completion  
**Sprint:** Agent HQ — First-Time Experience  
**Author:** Wren (agency-pm)  
**Date:** 2026-04-02  
**Status:** Ready for review  
**References:** [Provider Onboarding Research Spec — Task #571](./provider-onboarding-spec.md)

---

## 1. Overview

A new Agent HQ user must configure at least one usable model provider before the onboarding wizard is considered complete and the dashboard is treated as fully ready. This document defines the product behavior for the provider-setup step: where it appears, what "configured" means, every success/failure state, copy, and how it interacts with first-run detection and dashboard access.

---

## 2. Where Provider Setup Appears in the Onboarding Flow

### 2.1 Position in the wizard

Provider setup is **step 2 of the onboarding wizard**, immediately following workspace/account creation (step 1) and before the user sees the dashboard for the first time (final step).

```
[Step 1] Create workspace / account
     ↓
[Step 2] Connect a model provider  ← This spec
     ↓
[Step 3] (optional) Invite teammates / configure preferences
     ↓
[Dashboard]
```

> **Decision:** Provider setup is step 2, not the final step, so users do not reach an empty dashboard with no way to do anything useful.

### 2.2 Entry condition

The provider-setup step is shown when:
- It is the user's **first session** (first-run flag is set server-side, see §7)
- **AND** the user has zero usable providers configured

If the user already has at least one valid provider (e.g., returned to complete onboarding), step 2 shows a success state and the "Continue" button is enabled immediately.

---

## 3. Completion Gate: What Counts as "At Least One Provider Configured"

### 3.1 Backend definition

A provider is **usable** (counts toward the gate) if and only if:

1. Its credentials/connection details are stored in the database
2. Its most recent **connection test passed** — i.e., the validation call defined in the provider research spec returned a 2xx response
3. Its `status` field in the provider record is `connected`

A provider with status `pending`, `failed`, or `untested` does **not** count.

### 3.2 Server-side enforcement

- The backend exposes a computed field `onboarding_provider_gate_passed: boolean` on the current user/workspace object
- `onboarding_provider_gate_passed = true` when `COUNT(providers WHERE status = 'connected') >= 1`
- The onboarding completion endpoint (`POST /onboarding/complete` or equivalent) must reject requests with HTTP 422 if `onboarding_provider_gate_passed = false`
- The gate is evaluated at the time the completion request is made, not at form submission

### 3.3 Provider status lifecycle

```
[credentials entered]
       ↓
   status = pending
       ↓
   [validation call fires]
       ↓ success           ↓ failure
  status = connected    status = failed
```

Re-attempting a failed provider retests and updates status.

---

## 4. Supported Providers

Per the provider research spec (Task #571), the following providers are supported in v1:

| Provider | Connection Method | Required Input |
|----------|------------------|----------------|
| Anthropic | API Key | API key (`sk-ant-...`) |
| OpenAI | API Key (Bearer) | API key (`sk-...`), optional org/project ID |
| Google | AI Studio API Key | API key |
| Ollama | HTTP Base URL | Base URL (default: `http://localhost:11434`) |

See [provider-onboarding-spec.md](./provider-onboarding-spec.md) for full auth details, validation calls, error codes, and credential storage requirements.

---

## 5. Success and Failure UX States

### 5.1 Zero providers configured (initial state)

**Display:**
- Heading: "Connect your first AI provider"
- Body copy: "Agent HQ needs at least one AI provider to work. You only need to connect one to get started — you can add more later."
- Provider selection cards for: Anthropic, OpenAI, Google, Ollama
- "Continue" button: **disabled**, grayed out, tooltip on hover: "Connect at least one provider to continue"
- No skip/defer option (see §6)

### 5.2 One provider configured (gate satisfied)

**Display:**
- The successfully connected provider card shows a green checkmark and `Connected` badge
- "Continue" button: **enabled**, primary style
- Body copy updates to: "You're ready to go. You can connect more providers at any time from Settings."
- Other provider cards remain visible and connectable (not hidden)

### 5.3 Multiple providers configured

Same as §5.2 — gate is satisfied after the first success. Each additional connected provider shows its own `Connected` badge. The "Continue" button remains enabled.

No special state or messaging is required for multiple providers beyond the per-card success indicator.

### 5.4 Invalid credentials / failed connection test

**Per-provider card error state:**
- Card border turns red or shows an error indicator
- Inline error message under the input field:
  - API key rejected (4xx): "[Provider] couldn't verify your key. Double-check it and try again."
  - Network unreachable: "Couldn't reach [Provider]. Check your connection and try again."
  - Ollama: "Ollama isn't running at `<url>`. Start Ollama and try again." (see provider spec for full Ollama error matrix)
- The "Connect" / "Test connection" button is re-enabled for retry immediately
- The provider's status remains `failed` — it does **not** count toward the gate
- The "Continue" button remains disabled if no other provider has passed

**No toast/banner for failed connection** — error is inline to the card only.

### 5.5 Partial progress / return-later state

Partial progress is defined as: the user has entered credentials but has not completed a successful test, OR the user has closed the browser / navigated away mid-setup.

**Behavior:**
- Credential input that was typed but not yet submitted is **not persisted** (cleared on page reload)
- A provider record is only written to the database after a successful validation call — there is no "draft" state
- On return to the onboarding wizard, the user sees the same zero-provider initial state unless a previous connection test succeeded
- If the user returns after a previous successful connection (status = `connected`), the wizard opens at step 2 showing the already-connected provider(s) with `Connected` badges and the "Continue" button enabled

**No session-resume or partial-save UX is required for v1.** The provider card re-presents the empty input so the user can try again.

---

## 6. Skip / Defer Options

**There is no skip option for the provider step in v1.**

Rationale: Agent HQ without a provider configured is non-functional. Allowing skip creates a broken-dashboard experience for new users and complicates first-run detection. Masking the gate behind a dismiss action adds deferred-state complexity with no product benefit.

**What is not allowed:**
- "Skip for now" / "I'll do this later" link
- Ability to reach the dashboard with zero providers configured via the onboarding wizard

**Post-onboarding access:**
- After completing onboarding, the user can add additional providers (or reconfigure existing ones) via **Settings → Providers** at any time
- If a provider's status later transitions to `failed` (e.g., a key is revoked), the user is not re-gated at the dashboard — the gate is onboarding-only

---

## 7. First-Run Detection and Dashboard Access

### 7.1 First-run flag

- The server maintains an `onboarding_completed: boolean` flag per user/workspace, defaulting to `false` on account creation
- The flag is set to `true` only when the user successfully calls the onboarding completion endpoint (which enforces the provider gate, §3.2)
- The flag is never automatically reset

### 7.2 Dashboard access before onboarding completion

If `onboarding_completed = false` and the user attempts to access the dashboard directly (e.g., by navigating to `/` or `/dashboard`):

- The frontend redirects to the onboarding wizard at the correct step
- The backend does **not** require middleware to block API calls — the redirect is a frontend concern only
- Deep-linking to dashboard routes during onboarding returns a redirect, not a 403

### 7.3 Dashboard access after onboarding completion

- `onboarding_completed = true` → user lands on the dashboard normally
- No re-entry into the wizard unless the user is explicitly directed there (e.g., "Add provider" CTA from Settings)

### 7.4 Edge case: provider revoked after onboarding

If the user's only connected provider later becomes invalid (key revoked, Ollama offline, etc.):
- The dashboard remains accessible — the onboarding gate does not re-trigger
- A non-blocking warning banner may be shown on the dashboard: "Your [Provider] connection is no longer working. [Fix it in Settings →]"
- This banner behavior is out of scope for this spec but should be noted as a follow-on task

---

## 8. Copy Reference

| Location | Copy |
|----------|------|
| Step 2 heading | "Connect your first AI provider" |
| Step 2 body (zero providers) | "Agent HQ needs at least one AI provider to work. You only need to connect one to get started — you can add more later." |
| Step 2 body (gate satisfied) | "You're ready to go. You can connect more providers at any time from Settings." |
| Continue button (disabled tooltip) | "Connect at least one provider to continue" |
| Provider card: connected state | "Connected ✓" |
| Provider card: failed — bad key | "[Provider] couldn't verify your key. Double-check it and try again." |
| Provider card: failed — unreachable | "Couldn't reach [Provider]. Check your connection and try again." |
| Ollama: not running | "Ollama isn't running at `<url>`. Start Ollama and try again." |
| Ollama: no models installed | "Ollama is connected but no models are installed. Run `ollama pull <model>` to add one." |
| Helper links (per provider) | "Get your API key at [platform.claude.com/settings/keys / platform.openai.com / aistudio.google.com/app/apikey]" |

---

## 9. Acceptance Criteria

- [ ] Provider-setup step is step 2 of the onboarding wizard, after account creation and before the dashboard
- [ ] A provider is only considered configured when its connection test returns 200 and `status = connected`
- [ ] `onboarding_provider_gate_passed` is a server-computed field checked at onboarding completion
- [ ] Onboarding completion endpoint rejects with 422 if no provider has `status = connected`
- [ ] "Continue" button on step 2 is disabled until at least one provider has `status = connected`
- [ ] All four supported providers (Anthropic, OpenAI, Google, Ollama) are presented as options
- [ ] Each provider shows its own connection form consistent with the provider research spec
- [ ] Credential-entry errors are shown inline (not as toasts/banners)
- [ ] Failed connection test does not advance the user and does not count toward the gate
- [ ] No skip/defer option exists on the provider step
- [ ] Returning users with an existing `connected` provider see the gate pre-satisfied
- [ ] Partial-progress (unsubmitted input) is not persisted on navigation away
- [ ] Navigating to `/dashboard` before `onboarding_completed = true` redirects to the wizard
- [ ] `onboarding_completed` is only set server-side after the gate passes
- [ ] Post-onboarding provider failures do not re-trigger the onboarding gate

---

## 10. Out of Scope (v1)

- Additional providers beyond Anthropic, OpenAI, Google, Ollama
- OAuth / user-login flows for any provider (none supported — see provider research spec)
- Ollama with reverse-proxy authentication
- Automatic Ollama install or launch
- Model management (pull/delete) during onboarding
- Re-gating the dashboard on provider failure post-onboarding
- Multi-workspace provider configuration
- Key rotation UX
