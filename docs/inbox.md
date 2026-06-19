---
title: Inbox & Dispatch
permalink: /inbox
diataxis: explanation
redirect_from:
  - /inbox.md
---

# Inbox & Dispatch — the design

Workflows often need to hand work off to other workflows without wiring direct calls between them. The sender knows it has produced a finding; it should not have to know which workflows want to react to that finding, or in what order. Jaiph addresses this with **channels** — a small, in-process message-passing model that lives inside the same workflow runtime as everything else.

This page explains the *model*: how channels behave, why the design is shaped the way it is, and how the pieces fit together. For the surface syntax see the [Language](language.md) and [Grammar](grammar.md) references; for the runtime implementation see [Architecture — Channels and hooks in context](architecture.md#channels-and-hooks-in-context).

## What problem channels solve

Two patterns recur in real workflows:

- **Late binding** — a workflow produces something (a finding, a summary, a verdict) and another workflow should react to it, but the producer should not be coupled to the consumer's name or signature.
- **Fan-out without a broker** — multiple subscribers should hear the same event. Standing up a message broker for an in-process workflow runner is heavy and turns durable orchestration into a distributed-systems problem.

Channels give workflows a publish/subscribe surface without leaving the process. The producer declares "this is a finding"; the channel declaration ties findings to one or more listeners; the runtime delivers them.

## Drain-driven, not file-watched

The most important property of the inbox model is that **delivery is drain-driven**. Sends do not "fire" routes the moment the `<-` line executes. Instead, every workflow context holds an in-memory queue; the sender appends to it, and the runtime drains that queue **after the workflow's step list finishes** — including the implicit join of any `run async` handles ([Spec: Async Handles](spec-async-handles.md)). Only then does the runtime invoke each route target, sequentially, in declaration order.

This is intentional:

- There is **no `inotifywait`, no `fswatch`, no polling loop**. The `inbox/NNN-<channel>.txt` files under the run directory are an audit copy of routed sends, not a delivery mechanism — routing does not read them back.
- Producers run to completion before any consumer starts. A workflow that emits five findings does not get partly interrupted by a route target firing mid-step list.
- Delivery is deterministic. For a given send order, the dispatch order is fixed.

The trade-off is that channels are **not** a low-latency notification primitive. They are an end-of-step-list handoff. For tighter coordination, use a direct `run` call.

## Routes belong on the channel, not on workflows

A channel declaration carries its targets inline:

```jh
channel findings -> analyst, reviewer
```

Routes are top-level static data on `ChannelDef`, not statements inside a workflow body. The design choice has two consequences worth understanding:

1. **One canonical subscription list per channel.** The compiler can validate every target up front: targets must be workflows (rules and scripts are rejected), they must declare exactly three parameters, and unknown names fail with `E_VALIDATE` at compile time, not at dispatch time.
2. **Routes are visible at the module boundary.** A reader can see "who listens on `findings`" without scanning every workflow body for `subscribe` calls. Routing intent lives next to the channel it describes.

A `channel <name>` line without `->` still defines the name for `send` validation but never registers a route — sends on a bare channel are still queued (and `INBOX_ENQUEUE` is still recorded for the timeline), they just have no consumer.

## Sequential dispatch is the only mode

For each queued message, route targets run **strictly in declaration order, one at a time**. The next message is not processed until every target for the current message has completed. There is no opt-in parallel mode; older builds exposed one and it has been removed.

The reason is failure semantics. With sequential dispatch:

- A target's failure is the failure of that delivery. Subsequent targets for the same message are skipped (fail-fast).
- Cascading sends from inside a target end up on the same queue, drained in turn, so a chain of sends produces a deterministic timeline.
- There is no need for users to reason about which side effects of two parallel handlers happened first.

When concurrency matters, the right tool is `run async` inside a target body, not parallel dispatch across targets.

## Routed vs unrouted sends

The same `<-` operator behaves slightly differently depending on whether a route exists for the channel:

- **Routed** — at least one route target matches. The runtime walks the workflow stack outward until a frame's route map contains the bare channel name (any imported `alias.` prefix has already been stripped). The payload is enqueued on that frame; the runtime also writes `inbox/NNN-<channel>.txt` so routed messages are inspectable from the run directory after the fact.
- **Unrouted** — no frame on the stack registered the channel. The message is still queued on the sender's own frame, and `INBOX_ENQUEUE` is still appended to `run_summary.jsonl`, but no audit file is written and the drain step has nothing to dispatch.

Unrouted sends are intentionally a silent drop, not an error. This lets optional subscribers be just that: a workflow can publish on `metrics` even if no one is listening today, and tomorrow a subscriber can be wired up without touching the producer. If a missing handler should be a hard failure, the right place to assert it is in a test or a `rule` check, not in the channel runtime.

## The trigger contract

A receiver workflow is a normal workflow, dispatched with three positional arguments bound to the parameters it declares:

| Position | Meaning |
|---|---|
| 1st parameter | The message payload (the string sent on `<-`) |
| 2nd parameter | The channel name (bare, e.g. `findings`) |
| 3rd parameter | The sender — the workflow name that performed the send |

The receiver picks its own parameter names. That is the entire contract: no environment plumbing, no special globals, no implicit context object. Targets that declare a different parameter count are rejected at compile time so receivers cannot drift away from the dispatch shape.

## Why this design, in one paragraph

Channels are a deliberately small idea in Jaiph. They are an in-process, drain-driven, sequentially-dispatched, late-binding handoff between workflows — described once at the top of the module, validated at compile time, and made visible in `run_summary.jsonl` and `inbox/` for after-the-fact inspection. Anything more powerful (concurrency, brokers, retries, dead-letter queues) is intentionally out of scope: those problems belong to other tools, and Jaiph keeps channels small enough to reason about without leaving the runtime.

## Related

- [Architecture — Channels and hooks in context](architecture.md#channels-and-hooks-in-context) — where the in-memory queue and dispatch loop live in the runtime.
- [Spec: Async Handles](spec-async-handles.md) — the implicit join that runs *before* a workflow's queue drains.
- [Language](language.md) and [Grammar](grammar.md) — the `channel` / `send` syntax surface.
