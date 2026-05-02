---
<!-- bugs.md: Bug sprint contract template. Keep expectations explicit and text-first. -->
## Atlas HQ bug-fix contract for this dispatched instance
Sprint type: {{sprintType}}
Instance ID: {{instanceId}}
Task ID: {{taskId}}
Session key: {{sessionKey}}

1. START CALLBACK — send this as soon as the run actually begins.
curl -s -X PUT {{baseUrl}}/api/v1/instances/{{instanceId}}/start \
  -H "Content-Type: application/json" \
  -d '{"session_key":"{{sessionKey}}"}'

2. PROGRESS EXPECTATION — check in when you confirm root cause, land the fix, or hit a blocker.
Heartbeat example:
curl -s -X POST {{baseUrl}}/api/v1/instances/{{instanceId}}/check-in \
  -H "Content-Type: application/json" \
  -d '{"stage":"heartbeat","summary":"Investigating or validating the fix","session_key":"{{sessionKey}}"}'

Meaningful progress example:
curl -s -X POST {{baseUrl}}/api/v1/instances/{{instanceId}}/check-in \
  -H "Content-Type: application/json" \
  -d '{"stage":"progress","summary":"Confirmed root cause or implemented the fix","session_key":"{{sessionKey}}","meaningful_output":true}'

3. BLOCKER CALLBACK — if the bug cannot be resolved without outside help, report the exact blocker immediately.
curl -s -X POST {{baseUrl}}/api/v1/instances/{{instanceId}}/check-in \
  -H "Content-Type: application/json" \
  -d '{"stage":"blocker","summary":"Blocked on dependency or missing reproduction detail","blocker_reason":"<exact blocker>","session_key":"{{sessionKey}}","meaningful_output":true}'

4. FINAL TASK OUTCOME — post exactly one final outcome when the bug-fix leg is complete.
Use ONE of these outcomes: {{validOutcomes}}

curl -s -X POST {{baseUrl}}/api/v1/tasks/{{taskId}}/outcome \
  -H "Content-Type: application/json" \
  -d '{"outcome":"{{suggestedOutcome}}","summary":"<one sentence summary>","changed_by":"{{agentSlug}}","instance_id":{{instanceId}}}'

Valid outcomes:
{{outcomeHelp}}

5. REQUIRED OUTPUTS FOR BUGS
- Identify the concrete root cause, not just the symptom.
- Describe the fix in terms QA can verify.
- Call out regression risk or follow-up gaps if they remain.

6. EVIDENCE EXPECTATIONS FOR BUGS
- Record the configured evidence gate fields shown in this contract before posting the advancement outcome.
- Do not infer required evidence fields from the bug-fix lane or from examples.
- Provide the dev or test URL QA should use when configured or relevant.
- Include short notes about reproduction, validation, or edge cases when that matters.

Current task status: {{taskStatus}}
---
