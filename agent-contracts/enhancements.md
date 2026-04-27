---
<!-- enhancements.md: Enhancement sprint contract template. Keep it text-first, lane-aware, and easy to edit. -->
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

2. PROGRESS EXPECTATION — check in when you lock the implementation plan, land a meaningful milestone, or hit a blocker.
Heartbeat example:
curl -s -X POST {{baseUrl}}/api/v1/instances/{{instanceId}}/check-in \
  -H "Content-Type: application/json" \
  -d '{"stage":"heartbeat","summary":"Still working through the enhancement scope","session_key":"{{sessionKey}}"}'

Meaningful progress example:
curl -s -X POST {{baseUrl}}/api/v1/instances/{{instanceId}}/check-in \
  -H "Content-Type: application/json" \
  -d '{"stage":"progress","summary":"Implemented the next enhancement milestone","session_key":"{{sessionKey}}","meaningful_output":true}'

3. BLOCKER CALLBACK — if the enhancement cannot move forward without outside help, report the exact blocker immediately.
curl -s -X POST {{baseUrl}}/api/v1/instances/{{instanceId}}/check-in \
  -H "Content-Type: application/json" \
  -d '{"stage":"blocker","summary":"Blocked on dependency, product decision, or missing access","blocker_reason":"<exact blocker>","session_key":"{{sessionKey}}","meaningful_output":true}'

4. FINAL TASK OUTCOME — post exactly one final outcome when this enhancement leg is complete.
Use ONE of these outcomes: {{validOutcomes}}

curl -s -X POST {{baseUrl}}/api/v1/tasks/{{taskId}}/outcome \
  -H "Content-Type: application/json" \
  -d '{"outcome":"{{suggestedOutcome}}","summary":"<one sentence summary>","changed_by":"{{agentSlug}}","instance_id":{{instanceId}}}'

Valid outcomes:
{{outcomeHelp}}

5. REQUIRED OUTPUTS FOR ENHANCEMENTS
- Deliver the scoped behavior change, not just a partial scaffold.
- State what was added or changed in terms another agent or reviewer can verify quickly.
- Call out any follow-up work, deliberate scope cuts, or remaining risks.

6. EVIDENCE EXPECTATIONS FOR ENHANCEMENTS
- Record branch, commit, and a non-production review artifact such as a branch or PR URL.
- Provide the dev URL or endpoint reviewers should exercise when relevant.
- Include short notes about validation performed, especially where behavior changed across runtime, API, or dispatch boundaries.

{{pipelineReference}}

Current task status: {{taskStatus}}
---
