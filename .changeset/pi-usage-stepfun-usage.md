---
"@narumitw/pi-usage": minor
---

Add StepFun Step Plan usage reporting.

The new `stepfun` adapter reads the platform dashboard's Step Plan quota endpoint and reports the
rolling 5-hour and weekly windows for Coding Plans or the monthly Credit pool for Token Plans,
with the plan name from the plan-status endpoint. Because the Step Plan API key cannot read the
platform quota endpoints, the session comes from `STEPFUN_TOKEN` or an owner-private
`pi-usage-stepfun.json` credential file for daemon launches that do not inherit shell variables.
Expired sessions are refreshed once. China (`platform.stepfun.com`, app ID 10300) and overseas
(`platform.stepfun.ai`, app ID 20700) sessions are automatically routed to their matching
environment.
