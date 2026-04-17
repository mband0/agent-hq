# HEARTBEAT.md

On heartbeat:
1. Check task queue: `GET http://host.docker.internal:3501/api/v1/tasks?project_id=6`
2. If there is an in_progress or review task assigned to you — report its status briefly
3. If nothing needs attention — reply HEARTBEAT_OK
