---
title: Inbox & Dispatch
permalink: /inbox
diataxis: explanation
redirect_from:
  - /inbox.md
---

# Inbox and dispatch

Workflows often need to hand work off to other workflows without calling them directly. A workflow that produces a finding should not have to know which other workflows want to react to it, or in what order. Jaiph solves this with **channels**. A channel is a small message-passing feature that runs inside the same workflow runtime as everything else, so there is no separate process or broker.

The rest of this page explains how channels behave and why the design works the way it does. For the syntax, see the [Language](language.md) and [Grammar](grammar.md) references. For the runtime implementation, see [Architecture](architecture.md#channels-and-hooks-in-context).

## What problem channels solve

Channels help in situations where direct calls are awkward:

- **Late binding.** A workflow produces something, such as a finding, a summary, or a verdict, and another workflow should react to it. The producer should not have to know the consumer's name or its parameter list.
- **Fan-out to several listeners.** Several workflows should react to the same event. Running a separate message broker for an in-process workflow runner is heavy, and it forces you to run and manage another service just to pass messages between workflows in the same process.

Channels give workflows a way to publish and subscribe without leaving the process. The producer sends a message on a channel. The channel declaration lists one or more workflows that listen on it, and the runtime delivers the message to each of them.

## When messages are delivered

A `send` does not run the route targets the moment the line executes. Instead, each workflow frame has its own in-memory queue. When the runtime runs a `send`, it adds the message to a queue and drains the queue later.

The runtime picks the queue by walking outward from the sender through the stack of running workflows. It uses the nearest frame that declares routes for the channel. When no frame declares routes, it uses the sender's own frame (see [Routed and unrouted sends](#routed-and-unrouted-sends)).

The runtime drains a frame's queue only after that frame's step list finishes. Finishing the step list includes the implicit join of any `run async` handles the step list created (see [Spec: Async Handles](spec-async-handles.md)). Only after the step list finishes does the runtime run each route target, one at a time, in the order the routes are declared.

The runtime delays delivery on purpose. The delay gives the following properties:

- There is no `inotifywait`, no `fswatch`, and no polling loop. The `inbox/NNN-<channel>.txt` files under the run directory are only an audit copy of routed sends. Routing never reads them back, so they do not drive delivery.
- Producers run to completion before any consumer starts. A workflow that sends five findings runs all of its steps first. No route target interrupts it partway through the step list.
- Delivery is deterministic. For a given send order, the dispatch order is fixed.

The trade-off is that channels are not a fast notification tool. Delivery only happens after a step list finishes. When you need one workflow to react to another right away, call it directly with `run`.

## Routes are declared on the channel

A channel declaration lists its targets on the same line:

```jh
channel findings -> analyst, reviewer
```

Routes are top-level data on `ChannelDef`, not statements inside a workflow body. Declaring routes on the channel has the following effects:

1. **There is one list of subscribers per channel.** The compiler checks every target when it compiles the module. Each target must be a `def` that declares 1 to 3 parameters (message, then channel, then sender). A script is rejected, and so is a def with 0 or more than 3 parameters. An unknown name fails with `E_VALIDATE` at compile time, not at dispatch time.
2. **The routes are visible at the top of the module.** You can see which workflows listen on `findings` without reading through workflow bodies to find the connections. The list of listeners is next to the channel it belongs to.

The runtime registers routes only on the entry workflow frame, which is the first workflow the run starts. When that frame starts, the runtime reads the `channel … ->` declarations from that workflow's module. A nested `run` frame always keeps an empty route map. Because of this, a `send` from a nested workflow walks the stack outward until it reaches the entry frame that registered the channel.

A `channel <name>` line without `->` still defines the channel name, so a `send` to it passes validation. The channel never enters any route map, so a `send` on it has no consumer. The message is still added to a queue, and the runtime still records an `INBOX_ENQUEUE` event for the timeline.

## Dispatch is always sequential

For each queued message, the route targets run one at a time, in the order they are declared. The runtime does not start the next message until every target for the current message has finished. There is no option for parallel dispatch. An older build had one, and it has been removed.

The reason for sequential dispatch is that it keeps failures simple to reason about. Running one target at a time gives this behavior:

- When a target fails, the runtime stops the whole drain pass. It skips the remaining targets for that message and dispatches no more messages. The runtime reports the failure as the failure of the workflow that owns the queue. There is no per-target error handling, so the first failure stops the whole pass (fail-fast).
- A route target can itself send messages. Those sends are added to the entry frame's queue and are drained in the same pass, so a chain of sends runs in a fixed, repeatable order.
- You never have to work out which of two parallel handlers ran its side effects first, because targets never run in parallel.

For each delivery, the runtime writes two events to `run_summary.jsonl`: an `INBOX_DISPATCH_START` event and an `INBOX_DISPATCH_COMPLETE` event. The `INBOX_DISPATCH_COMPLETE` event carries the target's exit status and how long it ran. Together with the `INBOX_ENQUEUE` event for each send, these events let you reconstruct the full order of sends and deliveries after the run.

Each frame's drain pass has a limit on how many messages it will dispatch. The default is 1000, and you can change it with `JAIPH_INBOX_MAX_DISPATCH`. When a drain pass hits the limit, it stops with `E_INBOX_DISPATCH_LIMIT` instead of running forever, which catches a circular send loop.

When you need concurrency inside dispatch, use `run async` inside a target's body. Dispatch across targets is always sequential and does not give you concurrency.

## Routed and unrouted sends

A `send` behaves in one of two ways, depending on whether any running workflow declares a route for the channel:

- **Routed.** Some running workflow has a route for the channel under its bare name. If the channel is written with an imported `alias.` prefix, the runtime strips the prefix before it looks up the route. The runtime walks outward from the sender until it finds that workflow's frame and adds the message to that frame's queue. It also writes an audit copy of the message to `inbox/NNN-<channel>.txt` under the run directory.
- **Unrouted.** No running workflow has a route for the channel. The runtime still adds the message to the sender's own queue and still writes an `INBOX_ENQUEUE` event to `run_summary.jsonl`. It does not write an audit file, and the sender's drain pass skips the message because there are no targets to run.

An unrouted send is dropped on purpose, and it is not an error. Subscribers can be optional this way. A workflow can send on `metrics` even when nothing listens today, and you can add a subscriber later without changing the producer. If a missing subscriber should be a hard failure, check for it in a test or a `def`, not in the channel runtime.

## How a receiver workflow is called

A receiver is a normal def. Dispatch binds a prefix of three positional arguments:

| Position | Meaning |
|---|---|
| 1st parameter | The message payload |
| 2nd parameter | The channel name (bare, e.g. `findings`) |
| 3rd parameter | The sender, which is the name of the def that ran the send |

The receiver chooses its own parameter names and may declare 1, 2, or 3 parameters. Extra args are not passed.

## Summary

Channels are a deliberately small feature. A channel passes a message from one workflow to one or more other workflows, inside the same process. You declare the routes once at the top of the module, and the compiler validates them. Delivery happens when a step list finishes, and the runtime dispatches the targets one at a time. The runtime records every send and every delivery in `run_summary.jsonl`, and it writes an `inbox/` audit file for each routed send, so you can inspect what happened after the run. Channels leave out concurrency, message brokers, retries, and dead-letter queues on purpose. Those problems belong to other tools, and leaving them out keeps channels small enough to understand without going outside the runtime.

## Related

- [Architecture](architecture.md#channels-and-hooks-in-context) explains where the in-memory queue and the dispatch loop live in the runtime.
- [Spec: Async Handles](spec-async-handles.md) describes the implicit join that runs before a workflow's queue drains.
- [Language](language.md) and [Grammar](grammar.md) cover the `channel` and `send` syntax.
