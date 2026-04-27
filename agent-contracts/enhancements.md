---
<!-- enhancements.md: Enhancement sprint contract template. Keep it text-first and scoped to feature work. -->
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

2. PROGRESS EXPECTATION — check in when you confirm scope, land the implementation, or hit a blocker.
Heartbeat example:
curl -s -X POST {{baseUrl}}/api/v1/instances/{{instanceId}}/check-in \
  -H "Content-Type: application/json" \
  -d '{"stage":"heartbeat","summary":"Implementing and validating the enhancement","session_key":"{{sessionKey}}"}'

Meaningful progress example:
curl -s -X POST {{baseUrl}}/api/v1/instances/{{instanceId}}/check-in \
  -H "Content-Type: application/json" \
  -d '{"stage":"progress","summary":"Implemented a meaningful enhancement milestone","session_key":"{{sessionKey}}","meaningful_output":true}'

3. BLOCKER CALLBACK — if the enhancement cannot proceed, report the exact blocker immediately.
curl -s -X POST {{baseUrl}}/api/v1/instances/{{instanceId}}/check-in \
  -H "Content-Type: application/json" \
  -d '{"stage":"blocker","summary":"Blocked on dependency, scope, or missing decision","blocker_reason":"<exact blocker>","session_key":"{{sessionKey}}","meaningful_output":true}'

4. FINAL TASK OUTCOME — post exactly one final outcome when this implementation leg is complete.
Use ONE of these outcomes: {{validOutcomes}}

curl -s -X POST {{baseUrl}}/api/v1/tasks/{{taskId}}/outcome \
  -H "Content-Type: application/json" \
  -d '{"outcome":"{{suggestedOutcome}}","summary":"<one sentence summary>","changed_by":"{{agentSlug}}","instance_id":{{instanceId}}}'

Valid outcomes:
{{outcomeHelp}}

5. REQUIRED OUTPUTS FOR ENHANCEMENTS
- Explain the user-facing or operator-facing improvement that was added.
- Call out any lane expectations, constraints, or follow-up work that still matter for QA or review.
- Make the handoff concrete enough that the next reviewer can tell what changed and how to verify it.

6. EVIDENCE EXPECTATIONS FOR ENHANCEMENTS
- Record branch, commit, and a non-production review artifact such as a branch URL or PR URL when available.
- Provide the dev or test URL that best demonstrates the enhancement when relevant.
- Include short reviewer notes when setup, migrated behavior, or edge cases matter.

{{pipelineReference}}

Current task status: {{taskStatus}}
---