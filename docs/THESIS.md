# Thesis: authority will move out of the prompt

Today most agent guardrails live where the agent lives: a system prompt that says "never export customer data", a
tool description that says "ask before deploying". That is asking the actor to also be the referee. The moment an
untrusted input reaches the context (a ticket, a runbook edit, a web page), the referee is compromised too.

Over the next two years I expect the industry to separate **what an agent can think** from **what it is allowed to
do**, the way operating systems separated user code from the kernel. Three things follow.

**Consent becomes an object, not a click.** An approval will name the exact tool, parameters, policy version and
resource version it covers, and expire. Approve "10% canary of 2.4.1" and the agent cannot spend that consent on
100%, on 2.4.2, or after the service changed under it.

**Stopping becomes a protocol, not a request.** A kill switch that politely asks a running loop to exit is a hope.
Real stops fence: every effect carries an epoch, and the system that commits effects refuses anything minted before
the stop. A worker that wakes up late with a cached plan hits a wall, not a warning.

**Oversight becomes per-team and evidential.** Fleets will span teams that must not approve each other's work.
Auditors will want an export they can verify offline, not a screenshot of a dashboard.

Better models raise the stakes: capability raises the cost of one unauthorised action. The durable layer is not a better prompt. It is a control plane that sits between
proposal and effect and that the agent cannot talk its way past.

WATCHSHIFT is a small, working version of that layer: three agents, one gate, and an audit trail a stranger can
check.
