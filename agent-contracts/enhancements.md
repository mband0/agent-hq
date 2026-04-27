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

2. PROGRESS EXPECTATION — check in when you complete design decisions, land implementation milestones, or hit a blocker.
Heartbeat example:
curl -s -X POST {{baseUrl}}/api/v1/instances/{{instanceId}}/check-in \
  -H "Content-Type: application/json" \
  -d '{"stage":"heartbeat","summary":"Implementing the enhancement plan","session_key":"{{sessionKey}}"}'

Meaningful progress example:
curl -s -X POST {{baseUrl}}/api/v1/instances/{{instanceId}}/check-in \
  -H "Content-Type: application/json" \
  -d '{"stage":"progress","summary":"Completed a meaningful enhancement milestone","session_key":"{{sessionKey}}","meaningful_output":true}'

3. BLOCKER CALLBACK — if the enhancement cannot proceed without outside help, report the exact blocker immediately.
curl -s -X POST {{baseUrl}}/api/v1/instances/{{instanceId}}/check-in \
  -H "Content-Type: application/json" \
  -d '{"stage":"blocker","summary":"Blocked on dependency, decision, or missing access","blocker_reason":"<exact blocker>","session_key":"{{sessionKey}}","meaningful_output":true}'

4. FINAL TASK OUTCOME — post exactly one final outcome when the enhancement leg is complete.
Use ONE of these outcomes: {{validOutcomes}}

curl -s -X POST {{baseUrl}}/api/v1/tasks/{{taskId}}/outcome \
  -H "Content-Type: application/json" \
  -d '{"outcome":"{{suggestedOutcome}}","summary":"<one sentence summary>","changed_by":"{{agentSlug}}","instance_id":{{instanceId}}}'

Valid outcomes:
{{outcomeHelp}}

5. REQUIRED OUTPUTS FOR ENHANCEMENTS
- State what capability changed, not just what files moved.
- Call out any lane expectations, follow-up tasks, or rollout notes the next owner needs.
- Describe the reviewer-visible behavior or API/runtime change in concrete terms.

6. EVIDENCE EXPECTATIONS FOR ENHANCEMENTS
- Record branch, commit, and a non-production review URL such as the branch or PR link.
- Provide the dev or test URL reviewers should use when relevant.
- Include brief notes on verification, tradeoffs, or remaining known gaps when that matters.

Current task status: {{taskStatus}}
---
