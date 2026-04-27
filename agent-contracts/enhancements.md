---
<!-- enhancements.md: Enhancement sprint contract template. Keep expectations explicit and text-first. -->
## Atlas HQ enhancement contract for this dispatched instance
Sprint type: {{sprintType}}
Workflow lane: {{lane}}
Instance ID: {{instanceId}}
Task ID: {{taskId}}
Session key: {{sessionKey}}

1. START CALLBACK — send this as soon as the run actually begins.
curl -s -X PUT {{baseUrl}}/api/v1/instances/{{instanceId}}/start \
  -H "Content-Type: application/json" \
  -d '{"session_key":"{{sessionKey}}"}'

2. PROGRESS EXPECTATION — check in when you lock scope, land the implementation milestone, or hit a blocker.
Heartbeat example:
curl -s -X POST {{baseUrl}}/api/v1/instances/{{instanceId}}/check-in \
  -H "Content-Type: application/json" \
  -d '{"stage":"heartbeat","summary":"Working through the enhancement plan","session_key":"{{sessionKey}}"}'

Meaningful progress example:
curl -s -X POST {{baseUrl}}/api/v1/instances/{{instanceId}}/check-in \
  -H "Content-Type: application/json" \
  -d '{"stage":"progress","summary":"Implemented the next enhancement milestone","session_key":"{{sessionKey}}","meaningful_output":true}'

3. BLOCKER CALLBACK — if the enhancement cannot move forward without outside help, report the exact blocker immediately.
curl -s -X POST {{baseUrl}}/api/v1/instances/{{instanceId}}/check-in \
  -H "Content-Type: application/json" \
  -d '{"stage":"blocker","summary":"Blocked on dependency, requirement, or access","blocker_reason":"<exact blocker>","session_key":"{{sessionKey}}","meaningful_output":true}'

4. FINAL TASK OUTCOME — post exactly one final outcome when this sprint-type leg is complete.
Use ONE of these outcomes: {{validOutcomes}}

curl -s -X POST {{baseUrl}}/api/v1/tasks/{{taskId}}/outcome \
  -H "Content-Type: application/json" \
  -d '{"outcome":"{{suggestedOutcome}}","summary":"<one sentence summary>","changed_by":"{{agentSlug}}","instance_id":{{instanceId}}}'

Valid outcomes:
{{outcomeHelp}}

5. REQUIRED OUTPUTS FOR ENHANCEMENTS
- State what new capability or workflow changed.
- Note any lane-specific expectation that shaped the work, such as implementation, QA, release, or PM handoff.
- Highlight user-visible behavior changes, follow-up work, or residual gaps when relevant.

6. EVIDENCE EXPECTATIONS FOR ENHANCEMENTS
- Record the evidence required for the current workflow lane before the final outcome.
- For implementation-style handoff, include branch, commit, and dev or review URL.
- For QA or release legs, include the tested or deployed target and the verified commit details.

Current task status: {{taskStatus}}
---
