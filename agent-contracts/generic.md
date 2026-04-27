---
<!-- generic.md: Sprint-type fallback contract template for local direct-callback runtimes.
     Placeholder substitution happens at dispatch time. Keep this plain text and easy to edit. -->
## Atlas HQ run contract for this dispatched instance
Sprint type: {{sprintType}}
Workflow lane: {{lane}}
Instance ID: {{instanceId}}
Task ID: {{taskId}}
Session key: {{sessionKey}}

1. START CALLBACK — send this as soon as the run actually begins.
curl -s -X PUT {{baseUrl}}/api/v1/instances/{{instanceId}}/start \
  -H "Content-Type: application/json" \
  -d '{"session_key":"{{sessionKey}}"}'

2. HEARTBEAT / PROGRESS CALLBACKS — send a heartbeat every 5-10 minutes or whenever meaningful progress happens.
Heartbeat example:
curl -s -X POST {{baseUrl}}/api/v1/instances/{{instanceId}}/check-in \
  -H "Content-Type: application/json" \
  -d '{"stage":"heartbeat","summary":"Still working","session_key":"{{sessionKey}}"}'

Meaningful progress example:
curl -s -X POST {{baseUrl}}/api/v1/instances/{{instanceId}}/check-in \
  -H "Content-Type: application/json" \
  -d '{"stage":"progress","summary":"Implemented the next milestone","session_key":"{{sessionKey}}","meaningful_output":true}'

3. BLOCKER CALLBACK — if you get blocked before finishing, send a blocker check-in immediately.
curl -s -X POST {{baseUrl}}/api/v1/instances/{{instanceId}}/check-in \
  -H "Content-Type: application/json" \
  -d '{"stage":"blocker","summary":"Blocked on dependency or access","blocker_reason":"<exact blocker>","session_key":"{{sessionKey}}","meaningful_output":true}'

4. FINAL TASK OUTCOME — this is the ONE AND ONLY exit step. Posting a terminal outcome automatically closes the instance and terminates your session.
Use ONE of these outcomes: {{validOutcomes}}

curl -s -X POST {{baseUrl}}/api/v1/tasks/{{taskId}}/outcome \
  -H "Content-Type: application/json" \
  -d '{"outcome":"{{suggestedOutcome}}","summary":"<one sentence summary>","changed_by":"{{agentSlug}}","instance_id":{{instanceId}}}'

Valid outcomes:
{{outcomeHelp}}

5. EVIDENCE RECORDING — include the evidence required for this sprint type and lane before posting the final outcome.
- Use task notes or evidence APIs when the lane requires branch, commit, dev URL, QA URL, deploy info, or reviewer notes.
- Treat evidence as required handoff context, not optional commentary.

Pipeline reference: todo → ready → dispatched → in_progress → review → qa_pass → ready_to_merge → deployed → done

Current task status: {{taskStatus}}
---
