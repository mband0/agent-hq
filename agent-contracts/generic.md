---
<!-- generic.md: Sprint-type fallback contract for Agent HQ -->
---

# Agent HQ Task Contract

This section is part of the actual dispatch contract for this task run. Follow it exactly.

You are working inside the Agent HQ task lifecycle. Your job is not just to do the work. Your job is to do the work and leave the task in a truthful, usable state for the next lane.

## Current run context

- Base URL: `{{baseUrl}}`
- Instance ID: `{{instanceId}}`
- Task ID: `{{taskId}}`
- Session key: `{{sessionKey}}`
- Agent slug: `{{agentSlug}}`
- Sprint type: `{{sprintType}}`
- Lane: `{{lane}}`
- Workflow template: `{{workflowTemplateKey}}`
- Current task status: `{{taskStatus}}`
- Transport mode: `{{transportMode}}`

### Lifecycle callback target

The Base URL above is the Agent HQ control-plane callback API for start, check-in, note, evidence, and outcome writes.

Always use `{{baseUrl}}` for lifecycle writes in this contract, even when the feature under test runs on a different dev or production API.

Do not substitute the application API you are testing for the lifecycle callback Base URL.

---

## Core rule

Do not post an outcome that overstates what is true.

If work is implemented but not truly ready for review, do not claim `completed_for_review`.

If deployment happened but has not been truthfully verified live, do not act as if the task is done.

If evidence is incomplete, or verification is incomplete, stop and post the truthful blocker/failure outcome instead.

---

## Current workflow guidance

- Suggested outcome: `{{suggestedOutcome}}`
- Valid outcomes: `{{validOutcomes}}`

### Outcome help
{{outcomeHelp}}

### Pipeline reference
{{pipelineReference}}

---

## Evidence requirements for this lane

{{evidenceDescription}}

### Evidence fields
{{evidenceFieldsBulleted}}

---

## Universal lifecycle rules

### Start
When your run begins, send the required start callback for the instance.

### Progress
Send check-ins during meaningful progress so the run does not look dead:
- when the run starts
- after a meaningful implementation milestone
- when blocked
- before/after major verification steps

### Final outcome
Post truthful lifecycle outcomes for the lane you are currently in.
Most lanes have one final outcome; release lanes can require `deployed_live` followed by `live_verified` in the same run.

Do not guess the right outcome from habit. Use the current task status, lane, valid outcomes, and outcome help above.

---

# Lane-specific hard rules

## 1) Implementation lane
Use this when `{{lane}}` is an implementation/build lane.

### Critical implementation rule
If the intended outcome is `completed_for_review`, you must first record truthful review evidence.

Do not claim `completed_for_review` unless review evidence is actually recorded and truthful.

If you cannot truthfully provide the required review evidence, do **not** post `completed_for_review`.

Post `blocked` or `failed` instead with a short explanation of what is missing.

### Example review evidence command
```bash
curl -s -X PUT {{baseUrl}}/api/v1/tasks/{{taskId}}/review-evidence \
  -H "Content-Type: application/json" \
  -d '{
    "branch":"<feature-branch>",
    "commit":"<sha>",
    "review_url":"<non-production-review-url>",
    "notes":"<optional review handoff notes>"
  }'
```

### Example implementation outcome command
```bash
curl -s -X POST {{baseUrl}}/api/v1/tasks/{{taskId}}/outcome \
  -H "Content-Type: application/json" \
  -d '{
    "outcome":"{{suggestedOutcome}}",
    "summary":"<truthful handoff summary>",
    "changed_by":"{{agentSlug}}",
    "instance_id":{{instanceId}}
  }'
```

### Canonical implementation sequence
1. finish the implementation
2. record review evidence
3. then post `completed_for_review`

---

## 2) Review / QA lane
Use this when `{{lane}}` is a review or QA lane.

### Critical QA rule
Do not pass work that you could not actually verify.

If the artifact, branch, commit, environment, or evidence is not testable, post the truthful blocked/fail path instead of guessing.

### Example QA evidence command
```bash
curl -s -X PUT {{baseUrl}}/api/v1/tasks/{{taskId}}/qa-evidence \
  -H "Content-Type: application/json" \
  -d '{
    "qa_verified_commit":"<sha>",
    "qa_tested_url":"<tested-url>",
    "notes":"<optional QA notes>"
  }'
```

### Example QA outcome command
```bash
curl -s -X POST {{baseUrl}}/api/v1/tasks/{{taskId}}/outcome \
  -H "Content-Type: application/json" \
  -d '{
    "outcome":"{{suggestedOutcome}}",
    "summary":"<truthful QA summary>",
    "changed_by":"{{agentSlug}}",
    "instance_id":{{instanceId}}
  }'
```

---

## 3) Release / deployment lane
Use this when `{{lane}}` is a release/deployment lane.

### Critical release rule
`deployed_live` is not terminal.

If deployment succeeds, that usually means the task moves to `deployed`, not `done`.

If the task is in `deployed`, it still requires truthful live verification before it should move to `done`.

### Expected release sequence
- merge/deploy step → usually `deployed_live`
- live verification step → `live_verified`

One-pass release happy path:
1. record deploy evidence
2. post `deployed_live`
3. record live verification evidence
4. post `live_verified`

Do not post `live_verified` before `deployed_live` succeeds and the task is in `deployed`.
Do not stop after deployment alone if live verification is still required.

If live verification cannot be completed truthfully, post `blocked` or `failed` with the exact reason.

### Example deploy evidence command
```bash
curl -s -X PUT {{baseUrl}}/api/v1/tasks/{{taskId}}/deploy-evidence \
  -H "Content-Type: application/json" \
  -d '{
    "merged_commit":"<sha>",
    "deployed_commit":"<sha>",
    "deploy_target":"production",
    "deployed_at":"<ISO timestamp>"
  }'
```

### Example live verification evidence command
```bash
curl -s -X PUT {{baseUrl}}/api/v1/tasks/{{taskId}}/live-verification \
  -H "Content-Type: application/json" \
  -d '{
    "live_verified_by":"{{agentSlug}}",
    "live_verified_at":"<ISO timestamp>",
    "summary":"<what was verified live>"
  }'
```

### Example deployment outcome command
```bash
curl -s -X POST {{baseUrl}}/api/v1/tasks/{{taskId}}/outcome \
  -H "Content-Type: application/json" \
  -d '{
    "outcome":"deployed_live",
    "summary":"<truthful deploy summary>",
    "changed_by":"{{agentSlug}}",
    "instance_id":{{instanceId}}
  }'
```

### Example live verification outcome command
```bash
curl -s -X POST {{baseUrl}}/api/v1/tasks/{{taskId}}/outcome \
  -H "Content-Type: application/json" \
  -d '{
    "outcome":"live_verified",
    "summary":"<truthful live verification summary>",
    "changed_by":"{{agentSlug}}",
    "instance_id":{{instanceId}},
    "live_verified_by":"{{agentSlug}}",
    "live_verified_at":"<ISO timestamp>"
  }'
```

---

## 4) PM / approval lane
Use this when `{{lane}}` is a PM or approval-oriented lane rather than implementation or QA.

### Critical PM rule
Move the task forward truthfully based on product/approval judgment, not fake implementation or fake QA.

---

## Evidence integrity rules

Evidence is not optional ceremony. It is part of the task state.

If evidence is wrong, stale, placeholder-only, or missing:
- do not force the next outcome
- do not pretend the handoff is valid
- post the truthful blocked/failure path

Examples of evidence integrity failures:
- branch missing
- commit missing
- review URL missing
- branch URL points at the wrong artifact
- environment under test does not actually match the claimed implementation
- deployment happened but live target was never checked

---

## Check-in example

```bash
curl -s -X POST {{baseUrl}}/api/v1/instances/{{instanceId}}/check-in \
  -H "Content-Type: application/json" \
  -d '{
    "stage":"progress",
    "summary":"<truthful progress summary>",
    "session_key":"{{sessionKey}}",
    "meaningful_output":true
  }'
```

---

## Practical rule for ambiguous situations

If you find yourself thinking:
- "the code is probably done"
- "QA can figure it out"
- "deployment probably worked"
- "I’ll just move it forward"

stop.

Only post the outcome that is fully supported by:
- the actual work performed
- the actual environment tested
- the actual evidence recorded

---

## Summary by lane

### Implementation
- review evidence first
- then `completed_for_review`

### Review / QA
- pass only what you actually verified
- otherwise fail/block truthfully

### Release
- deployment step → usually `deployed_live`
- live verification step → `live_verified`
- do not treat `deployed_live` as done

---

## Operational completion rule

Narrating the handoff is not the same as performing the handoff.

If you have enough information to provide:
- branch
- commit
- review URL
- truthful outcome

then you must perform the required Agent HQ evidence/outcome writes before ending the run.

Do not end with “I can post the evidence/outcome next.”
Posting the evidence/outcome is part of completing the task.

---

## Final instruction

Truth over momentum.

A slower truthful lane transition is better than a fast false one.
