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

2. PROGRESS EXPECTATION — check in when the implementation approach is clear, the main slice is landed, or a blocker changes the plan.
Heartbeat example:
curl -s -X POST {{baseUrl}}/api/v1/instances/{{instanceId}}/check-in \
  -H "Content-Type: application/json" \
  -d '{"stage":"heartbeat","summary":"Still implementing or validating the enhancement","session_key":"{{sessionKey}}"}'

Meaningful progress example:
curl -s -X POST {{baseUrl}}/api/v1/instances/{{instanceId}}/check-in \
  -H "Content-Type: application/json" \
  -d '{"stage":"progress","summary":"Implemented the main enhancement slice or verified the intended behavior","session_key":"{{sessionKey}}","meaningful_output":true}'

3. BLOCKER CALLBACK — if the enhancement cannot move forward without outside help, report the exact blocker immediately.
curl -s -X POST {{baseUrl}}/api/v1/instances/{{instanceId}}/check-in \
  -H "Content-Type: application/json" \
  -d '{"stage":"blocker","summary":"Blocked on dependency, missing decision, or environment gap","blocker_reason":"<exact blocker>","session_key":"{{sessionKey}}","meaningful_output":true}'

4. FINAL TASK OUTCOME — post exactly one final outcome when the enhancement leg is complete.
Use ONE of these outcomes: {{validOutcomes}}

curl -s -X POST {{baseUrl}}/api/v1/tasks/{{taskId}}/outcome \
  -H "Content-Type: application/json" \
  -d '{"outcome":"{{suggestedOutcome}}","summary":"<one sentence summary>","changed_by":"{{agentSlug}}","instance_id":{{instanceId}}}'

Valid outcomes:
{{outcomeHelp}}

5. REQUIRED OUTPUTS FOR ENHANCEMENTS
- State the user-visible or system-visible behavior that changed.
- Call out any lane expectations, scope boundaries, or follow-up gaps that QA or the next owner should know.
- Summarize the implementation in a way that makes review straightforward.

6. EVIDENCE EXPECTATIONS FOR ENHANCEMENTS
- Record branch, commit, and a non-production review URL such as the branch or PR link.
- Provide the dev or test URL that best demonstrates the enhancement when relevant.
- Include short notes about validation steps, tradeoffs, or known edge cases when they matter.

{{pipelineReference}}

Current task status: {{taskStatus}}
---
