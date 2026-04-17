---
<!-- agent-contract.md: Direct-callback contract for local runtimes (openclaw, claude-code).
     Remote proxy-managed runtimes (veri, webhook+lifecycleProxy) do NOT receive this file —
     they get runtime-specific lifecycle instructions from buildLifecycleUserPromptSection(). -->
## Atlas HQ run contract for this dispatched instance
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

⚠️ RELEASE LANE ONLY (Harbor / DevOps): The release leg requires TWO outcome calls — do not stop after the first.
  Step A — after merge + deploy:
    POST outcome with outcome=deployed_live  →  task moves to "deployed"
    (deployed_live is NOT terminal — do NOT expect your session to end here)
  Step B — after live verification against production (ports 3500/3501):
    POST outcome with outcome=live_verified  →  task moves to "done" and your session ends
  Never call PUT /instances/:id/complete manually. Always post Step B (live_verified) last.

ℹ️ NOTE: PUT /instances/:id/complete still exists for backward compatibility but is no longer required. Posting a terminal outcome handles everything.

5. DEV ENVIRONMENT DEPLOY (implementation lane only) — before recording evidence or posting outcome, deploy your feature branch to the Dev environment so QA can actually test it. Failure to do this is the #1 cause of QA failures.

For Atlas HQ internal tasks (API changes):
  cd /path/to/dev-worktree/api && npm run build
  pm2 restart atlas-hq-dev-api

For Atlas HQ internal tasks (UI changes):
  cd /path/to/dev-worktree/ui && npm run build
  pm2 restart atlas-hq-dev-ui

QA will test against http://localhost:3510 / http://localhost:3511. If your code is not running there, QA will fail.

6. EVIDENCE RECORDING — after deploying to dev, record the appropriate evidence for your lane:
For dev handoff (implementation lane):
curl -s -X PUT {{baseUrl}}/api/v1/tasks/{{taskId}}/review-evidence \
  -H "Content-Type: application/json" \
  -d '{"branch":"<branch-name>","commit":"<sha>","dev_url":"<dev-env-url>","notes":"<optional notes>"}'

For QA pass (QA lane):
curl -s -X PUT {{baseUrl}}/api/v1/tasks/{{taskId}}/qa-evidence \
  -H "Content-Type: application/json" \
  -d '{"qa_url":"<tested-url>","verified_commit":"<sha>","notes":"<optional notes>"}'

For release (Harbor lane):
curl -s -X PUT {{baseUrl}}/api/v1/tasks/{{taskId}}/deploy-evidence \
  -H "Content-Type: application/json" \
  -d '{"merged_commit":"<sha>","deployed_commit":"<sha>","deploy_target":"production","deployed_at":"<ISO timestamp>"}'

Pipeline reference: todo → ready → dispatched → in_progress → review → qa_pass → ready_to_merge → deployed → done

Current task status: {{taskStatus}}

Environment reference:
- Dev:        UI http://localhost:3510  |  API http://localhost:3511
- Production: UI http://localhost:3500  |  API http://localhost:3501
---
