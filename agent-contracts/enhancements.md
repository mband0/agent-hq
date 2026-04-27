---
<!-- enhancements.md: Enhancement sprint contract template. Keep scope, handoff, and evidence clear. -->
## Atlas HQ enhancement contract for this dispatched instance
Sprint type: {{sprintType}}
Instance ID: {{instanceId}}
Task ID: {{taskId}}
Session key: {{sessionKey}}

1. START CALLBACK — send this as soon as the run actually begins.
curl -s -X PUT {{baseUrl}}/api/v1/instances/{{instanceId}}/start \
  -H "Content-Type: application/json" \
  -d '{"session_key":"{{sessionKey}}"}'

2. PROGRESS EXPECTATION — check in when you finish a meaningful milestone, narrow scope, or hit a blocker.
Heartbeat example:
curl -s -X POST {{baseUrl}}/api/v1/instances/{{instanceId}}/check-in \
  -H "Content-Type: application/json" \
  -d '{"stage":"heartbeat","summary":"Still implementing the enhancement","session_key":"{{sessionKey}}"}'

Meaningful progress example:
curl -s -X POST {{baseUrl}}/api/v1/instances/{{instanceId}}/check-in \
  -H "Content-Type: application/json" \
  -d '{"stage":"progress","summary":"Implemented a meaningful enhancement milestone","session_key":"{{sessionKey}}","meaningful_output":true}'

3. BLOCKER CALLBACK — if the enhancement cannot proceed, send the exact blocker immediately.
curl -s -X POST {{baseUrl}}/api/v1/instances/{{instanceId}}/check-in \
  -H "Content-Type: application/json" \
  -d '{"stage":"blocker","summary":"Blocked on dependency, access, or product decision","blocker_reason":"<exact blocker>","session_key":"{{sessionKey}}","meaningful_output":true}'

4. FINAL TASK OUTCOME — post exactly one final outcome when the enhancement leg is complete.
Use ONE of these outcomes: {{validOutcomes}}

curl -s -X POST {{baseUrl}}/api/v1/tasks/{{taskId}}/outcome \
  -H "Content-Type: application/json" \
  -d '{"outcome":"{{suggestedOutcome}}","summary":"<one sentence summary>","changed_by":"{{agentSlug}}","instance_id":{{instanceId}}}'

Valid outcomes:
{{outcomeHelp}}

5. REQUIRED OUTPUTS FOR ENHANCEMENTS
- Deliver the requested capability within the assigned scope.
- State any intentional tradeoffs or deferred follow-ups.
- Leave a clear review handoff so QA or the next lane knows what changed.

6. EVIDENCE EXPECTATIONS FOR ENHANCEMENTS
- Record branch and commit.
- Provide the dev URL or environment path to verify the enhancement.
- Include brief reviewer notes when setup, flags, or known limitations matter.

Current task status: {{taskStatus}}
---
