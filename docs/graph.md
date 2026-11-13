---
title: Flowcharts
permalink: /reference/graph
diataxis: reference
mermaid: true
---

# Flowcharts

[`jaiph graph`](cli.md#jaiph-graph) prints a def's execution flow as a Mermaid `flowchart TD` document, drawn with the flowchart symbols of ISO 5807. This page is the legend for that output: what each node shape and edge style means, how labels are written, and what the command leaves out. The samples at the bottom are the landing-page programs with their real `jaiph graph` output; a test regenerates each one and fails when the page drifts from the command. Rendering the fork bar needs Mermaid 11.3 or later.

## Nodes

| Node | ISO 5807 symbol | Mermaid | Drawn for |
|---|---|---|---|
| start / end | Terminator | `([ ])`, white | the def's entry and exit |
| `fail` | Terminator | `([ ])`, red | a `fail` step or a `match` arm that fails; the flow stops there |
| `in: a, b` | Data | `[/ /]`, amber | the def's parameters |
| `def` call | Predefined process | `[[ ]]`, blue | a call into another def; solid when its body is drawn as a subgraph, dashed when collapsed |
| `script` | Process | `[ ]`, green | a script or inline script call |
| `prompt` | Process | `[ ]`, violet | an agent prompt |
| `send` | Process | `[ ]`, teal | a `send` to a channel |
| inbox | Stored data | `[( )]`, teal | the entry def's message queue, when a routed channel is sent to |
| `if` / `match` | Decision | `{ }`, grey | a branch: `yes` / `no`, or one edge per arm |
| `for … in` | Preparation | `{{ }}`, grey | a loop; `next` returns to it, `done` leaves it |
| connector | Connector | small grey circle | `match` arms converging, or the entry def draining its inbox |
| fork / join bar | Parallel mode | black bar | a run of `async` calls fanning out, and the def's implicit wait for all of them |

Each def reached from the entry is one subgraph titled **def** *name*, drawn once; recursion and repeated calls link into the same subgraph. A def from another module keeps the alias it was imported under (`git.commit`) and its subgraph has a dashed border.

## Edges

| Edge | Mermaid | Meaning |
|---|---|---|
| flow | `-->` | the next step; labelled `yes` / `no`, a `match` arm, `return …`, `stdout → stdin` between pipeline stages, or `async` out of a fork bar |
| failure | dotted, bold red **recover** / **catch** | the step failed and its `recover` or `catch` body runs |
| retry | `-->` labelled `retry` | the end of a `recover` body goes back to the failing call |
| communication link | `--o` teal, labelled `↯ channel` | a `send` puts a message in the entry def's inbox; the sender carries on |
| control transfer | `==>` labelled `deliver channel` | after its steps, the entry def calls each route target with the message, in route order |

The diagram delivers each channel once, in the order channels are first sent to, including channels that a route target sends to while the inbox drains. Only channels routed in the entry file are delivered, which matches the runtime: a channel routed only in an imported module is dropped.

## Labels

- Construct keywords are bold: **def**, **script**, **prompt**, **send**, **fail**, **if**, **match**. A binding comes first and a modifier sits before the keyword: `x = def f()`, `async def f()`, `stdin script gen()`, `stdin v → script s()`.
- A prompt is shown as `prompt "…"` with the first non-blank line of its text, and a failure as `fail "…"` with the first line of its message. Text over 40 characters is cut at a word boundary and ends in `...`. A named prompt shows its call: `prompt review(diff)`.
- Any other label is cut at 70 characters with `...`. Quotes, `#`, braces, `<`, `>`, and `|` are written as Mermaid entities (`#quot;`, `#35;`, …), so every Jaiph string renders.
- `log`, `logerr`, `logwarn`, comments, and a `const` bound to a plain value are not drawn. A `const` bound to a call, prompt, or `match` shows the binding on that node.
- Node ids (`n1`, `n2`, …) follow depth-first source order, so the same input always gives the same text.

## Collapsed defs

A call is drawn collapsed (a dashed **def** node with no subgraph) when the def is more than `--depth` calls below the entry def, lives in a project module more than `--import-depth` import hops away, or lives in a library under `.jaiph/libs/` and `--libs` is not set. The defaults are `-d 3`, `-i 1`, and no libraries (flags in [CLI — `jaiph graph`](cli.md#jaiph-graph)). The output then ends with a comment that counts what was left out and names the flags that draw it:

```text
%% collapsed: 2 defs beyond --depth 3, 4 library defs (use -d all, -l to expand)
```

## Samples

<!-- graph-samples -->
{% raw %}
<div class="graph-samples">
<div class="code-tab-list">
<button type="button" class="code-tab-button is-active" data-target="graph-hero">run snippet</button>
<button type="button" class="code-tab-button" data-target="graph-say-hello">say_hello.jh</button>
<button type="button" class="code-tab-button" data-target="graph-recover-loop">recover_loop.jh</button>
<button type="button" class="code-tab-button" data-target="graph-agent-inbox">agent_inbox.jh</button>
<button type="button" class="code-tab-button" data-target="graph-async">async.jh</button>
<button type="button" class="code-tab-button" data-target="graph-stdin">stdin.jh</button>
<button type="button" class="code-tab-button" data-target="graph-say-hello-d0">say_hello.jh -d 0</button>
</div>

<div class="code-tab-panel is-active" data-panel="graph-hero" data-graph-sample>
<p>The one-line run from the landing page: one prompt, its answer bound to <code>response</code>, and a <code>log</code> that is not drawn.</p>
<pre><code class="language-jaiph" data-sample-source>export def main() {
  const response = prompt "Say: Hello, I am [model name]!"
  log response
}</code></pre>
<pre><code class="language-bash">jaiph graph hello.jh</code></pre>
<pre><code class="language-text" data-graph-mermaid>flowchart TD
  classDef term fill:#ffffff,stroke:#8a938d,color:#1d2420
  classDef prompt fill:#eee2fd,stroke:#7646d6,color:#381a72

  subgraph g1 ["&lt;b&gt;def&lt;/b&gt; main"]
    n1(["start"]):::term
    n2["response = &lt;b&gt;prompt&lt;/b&gt; #quot;Say: Hello, I am [model name]!#quot;"]:::prompt
    n3(["end"]):::term
  end

  n1 --&gt; n2
  n2 --&gt; n3</code></pre>
<div class="graph-render" role="img" aria-label="Rendered flowchart"></div>
</div>

<div class="code-tab-panel" data-panel="graph-say-hello" data-graph-sample data-sample-file="say_hello.jh">
<p>A def call drawn as a subgraph, a <code>match</code> with a failing arm, and a prompt whose label is the first line of its text.</p>
<pre><code class="language-jaiph" data-sample-source>#!/usr/bin/env jaiph

# check the name before calling the agent
def valid_name(name_arg) {
  return match name_arg {
    /[A-Z][a-z]+/ =&gt; name_arg
    _ =&gt; fail "You provided an invalid name :("
  }
}

# export def main is the jaiph run entry
export def main(name_arg) {
  const name = valid_name(name_arg)

  # prompts call agents - cursor by default, but it's configurable
  const response = prompt """
    Say hello to ${name} and provide a fun fact about a person with the same name.
    Respond with a single line. Do not inspect files or run tools.
  """

  return response
}</code></pre>
<pre><code class="language-bash">jaiph graph examples/say_hello.jh</code></pre>
<pre><code class="language-text" data-graph-mermaid>flowchart TD
  classDef term fill:#ffffff,stroke:#8a938d,color:#1d2420
  classDef fail fill:#fde2e2,stroke:#b42318,color:#7a1a12
  classDef input fill:#fff3d1,stroke:#b7871a,color:#4d3600
  classDef def fill:#dce7fb,stroke:#3563c9,color:#132f66,stroke-width:1.5px
  classDef prompt fill:#eee2fd,stroke:#7646d6,color:#381a72
  classDef decision fill:#f1f2f1,stroke:#5f6762,color:#1d2420

  subgraph g1 ["&lt;b&gt;def&lt;/b&gt; main"]
    n1(["start"]):::term
    n2[/"in: name_arg"/]:::input
    n3[["name = &lt;b&gt;def&lt;/b&gt; valid_name(name_arg)"]]:::def
    n9["response = &lt;b&gt;prompt&lt;/b&gt; #quot;Say hello to $#123;name#125; and provide a fun...#quot;"]:::prompt
    n10(["end"]):::term
  end
  subgraph g2 ["&lt;b&gt;def&lt;/b&gt; valid_name"]
    n4(["start"]):::term
    n5[/"in: name_arg"/]:::input
    n6{"&lt;b&gt;match&lt;/b&gt; name_arg"}:::decision
    n7(["&lt;b&gt;fail&lt;/b&gt; #quot;You provided an invalid name :(#quot;"]):::fail
    n8(["end"]):::term
  end

  n1 --&gt; n2
  n2 --&gt; n3
  n3 --&gt; n4
  n4 --&gt; n5
  n5 --&gt; n6
  n6 --&gt;|"_"| n7
  n6 --&gt;|"/[A-Z][a-z]+/ → name_arg"| n8
  n8 --&gt; n9
  n9 --&gt;|"return response"| n10</code></pre>
<div class="graph-render" role="img" aria-label="Rendered flowchart"></div>
</div>

<div class="code-tab-panel" data-panel="graph-recover-loop" data-graph-sample data-sample-file="recover_loop.jh">
<p>A <b>recover</b> edge into the repair prompt, and <code>retry</code> back to the failing script.</p>
<pre><code class="language-jaiph" data-sample-source>#!/usr/bin/env jaiph

# scripts are defined in fenced blocks or single line backticks
# by default it's bash, but it cany be any env: ```node, ```python3, etc.
script check_report_exists = '''
  test -f report.txt
'''

export def main() {
  # Recovery in loop: when check_report_exists() fails, the recovery body
  # is executed to fix it, and then check_report_exists() is retried.
  # By default, the retry limit is 10.
  check_report_exists() recover (failure) {
    logerr "Failed to check report.txt"
    prompt "report.txt is missing. Create it with a short dummy summary."
  }

  # scripts can be also executed inline
  return 'cat report.txt'()
}</code></pre>
<pre><code class="language-bash">jaiph graph examples/recover_loop.jh</code></pre>
<pre><code class="language-text" data-graph-mermaid>flowchart TD
  classDef term fill:#ffffff,stroke:#8a938d,color:#1d2420
  classDef script fill:#e2f1e7,stroke:#3a8657,color:#163b25
  classDef prompt fill:#eee2fd,stroke:#7646d6,color:#381a72

  subgraph g1 ["&lt;b&gt;def&lt;/b&gt; main"]
    n1(["start"]):::term
    n2["&lt;b&gt;script&lt;/b&gt; check_report_exists()"]:::script
    n3["&lt;b&gt;prompt&lt;/b&gt; #quot;report.txt is missing. Create it with a...#quot;"]:::prompt
    n4["&lt;b&gt;script&lt;/b&gt; 'cat report.txt'()"]:::script
    n5(["end"]):::term
  end

  n1 --&gt; n2
  n2 -. "&lt;b&gt;recover&lt;/b&gt;" .-&gt; n3
  n3 --&gt;|"retry"| n2
  n2 --&gt; n4
  n4 --&gt;|"return"| n5

  linkStyle 1 stroke:#b42318,color:#b42318</code></pre>
<div class="graph-render" role="img" aria-label="Rendered flowchart"></div>
</div>

<div class="code-tab-panel" data-panel="graph-agent-inbox" data-graph-sample data-sample-file="agent_inbox.jh">
<p>Sends fill the entry def's inbox (<code>↯</code>); after its steps, <code>main</code> delivers each channel to its route target in turn.</p>
<pre><code class="language-jaiph" data-sample-source>#!/usr/bin/env jaiph

channel findings -&gt; analyst
channel report -&gt; reviewer

def scanner() {
  log "Scanning for issues..."
  send "Found 3 issues in auth module" -&gt; findings
}

def analyst(msg) {
  send "Summary: ${msg}" -&gt; report
}

def reviewer(msg) {
  logerr "Critical issue: ${msg}"
}

export def main() {
  scanner()
}</code></pre>
<pre><code class="language-bash">jaiph graph examples/agent_inbox.jh</code></pre>
<pre><code class="language-text" data-graph-mermaid>flowchart TD
  classDef term fill:#ffffff,stroke:#8a938d,color:#1d2420
  classDef input fill:#fff3d1,stroke:#b7871a,color:#4d3600
  classDef def fill:#dce7fb,stroke:#3563c9,color:#132f66,stroke-width:1.5px
  classDef send fill:#d8f1ee,stroke:#22857b,color:#0d3a35
  classDef channel fill:#d8f1ee,stroke:#22857b,color:#0d3a35
  classDef join fill:#8a938d,stroke:#8a938d,color:#8a938d

  subgraph g1 ["&lt;b&gt;def&lt;/b&gt; main"]
    n1(["start"]):::term
    n2[["&lt;b&gt;def&lt;/b&gt; scanner()"]]:::def
    n5[("main inbox")]:::channel
    n7((" ")):::join
    n15(["end"]):::term
  end
  subgraph g2 ["&lt;b&gt;def&lt;/b&gt; scanner"]
    n3(["start"]):::term
    n4["&lt;b&gt;send&lt;/b&gt; #quot;Found 3 issues in auth module#quot; → findings"]:::send
    n6(["end"]):::term
  end
  subgraph g3 ["&lt;b&gt;def&lt;/b&gt; analyst"]
    n8(["start"]):::term
    n9[/"in: msg"/]:::input
    n10["&lt;b&gt;send&lt;/b&gt; #quot;Summary: $#123;msg#125;#quot; → report"]:::send
    n11(["end"]):::term
  end
  subgraph g4 ["&lt;b&gt;def&lt;/b&gt; reviewer"]
    n12(["start"]):::term
    n13[/"in: msg"/]:::input
    n14(["end"]):::term
  end

  n1 --&gt; n2
  n2 --&gt; n3
  n3 --&gt; n4
  n4 --o|"↯ findings"| n5
  n4 --&gt; n6
  n6 --&gt;|"steps done"| n7
  n8 --&gt; n9
  n9 --&gt; n10
  n10 --o|"↯ report"| n5
  n10 --&gt; n11
  n7 ==&gt;|"deliver findings"| n8
  n12 --&gt; n13
  n13 --&gt; n14
  n11 ==&gt;|"deliver report"| n12
  n14 --&gt; n15

  linkStyle 3 stroke:#22857b,stroke-width:2px
  linkStyle 8 stroke:#22857b,stroke-width:2px</code></pre>
<div class="graph-render" role="img" aria-label="Rendered flowchart"></div>
</div>

<div class="code-tab-panel" data-panel="graph-async" data-graph-sample data-sample-file="async.jh">
<p>Two <code>async</code> calls fan out from a fork bar and meet again at the join bar before <code>main</code> ends.</p>
<pre><code class="language-jaiph" data-sample-source>#!/usr/bin/env jaiph

const prompt_text = "Say: Greetings! I am [model name]."

def cursor_say_hello(name) {
  config {
    agent.backend = "cursor"
  }
  const response = prompt "${prompt_text}"
  log response
}

def claude_say_hello(name) {
  config {
    agent.backend = "claude"
  }
  const response = prompt "${prompt_text}"
  log response
}

# surrounding workflow waits for all to complete
export def main(name) {
  async cursor_say_hello(name)
  async claude_say_hello(name)
}</code></pre>
<pre><code class="language-bash">jaiph graph examples/async.jh</code></pre>
<pre><code class="language-text" data-graph-mermaid>flowchart TD
  classDef term fill:#ffffff,stroke:#8a938d,color:#1d2420
  classDef input fill:#fff3d1,stroke:#b7871a,color:#4d3600
  classDef def fill:#dce7fb,stroke:#3563c9,color:#132f66,stroke-width:1.5px
  classDef prompt fill:#eee2fd,stroke:#7646d6,color:#381a72
  classDef fork fill:#1d2420,stroke:#1d2420

  subgraph g1 ["&lt;b&gt;def&lt;/b&gt; main"]
    n1(["start"]):::term
    n2[/"in: name"/]:::input
    n3@{ shape: fork, label: "" }
    n4[["async &lt;b&gt;def&lt;/b&gt; cursor_say_hello(name)"]]:::def
    n9[["async &lt;b&gt;def&lt;/b&gt; claude_say_hello(name)"]]:::def
    n14@{ shape: fork, label: "" }
    n15(["end"]):::term
  end
  subgraph g2 ["&lt;b&gt;def&lt;/b&gt; cursor_say_hello"]
    n5(["start"]):::term
    n6[/"in: name"/]:::input
    n7["response = &lt;b&gt;prompt&lt;/b&gt; #quot;$#123;prompt_text#125;#quot;"]:::prompt
    n8(["end"]):::term
  end
  subgraph g3 ["&lt;b&gt;def&lt;/b&gt; claude_say_hello"]
    n10(["start"]):::term
    n11[/"in: name"/]:::input
    n12["response = &lt;b&gt;prompt&lt;/b&gt; #quot;$#123;prompt_text#125;#quot;"]:::prompt
    n13(["end"]):::term
  end

  n1 --&gt; n2
  n2 --&gt; n3
  n3 --&gt;|"async"| n4
  n4 --&gt; n5
  n5 --&gt; n6
  n6 --&gt; n7
  n7 --&gt; n8
  n3 --&gt;|"async"| n9
  n9 --&gt; n10
  n10 --&gt; n11
  n11 --&gt; n12
  n12 --&gt; n13
  n8 --&gt; n14
  n13 --&gt; n14
  n14 --&gt;|"all done"| n15

  class n3 fork
  class n14 fork</code></pre>
<div class="graph-render" role="img" aria-label="Rendered flowchart"></div>
</div>

<div class="code-tab-panel" data-panel="graph-stdin" data-graph-sample data-sample-file="stdin.jh">
<p>A <code>stdin</code> pipeline: each stage's stdout is the next stage's stdin.</p>
<pre><code class="language-jaiph" data-sample-source>#!/usr/bin/env jaiph

# Jaiph streams stdin pipelines so a script can produce a lot of data
# without loading it all into memory. Chain stages with -&gt;.
script gen = bash'''
  printf 'alpha\nbeta\ngamma\n'
'''

script upper = bash'''
  tr 'a-z' 'A-Z'
'''

script count = bash'''
  wc -l | tr -d ' '
'''

export def main() {
  # generate lines -&gt; uppercase them -&gt; reduce to a line count
  const n = stdin gen() -&gt; upper() -&gt; count()
  return n
}</code></pre>
<pre><code class="language-bash">jaiph graph examples/stdin.jh</code></pre>
<pre><code class="language-text" data-graph-mermaid>flowchart TD
  classDef term fill:#ffffff,stroke:#8a938d,color:#1d2420
  classDef script fill:#e2f1e7,stroke:#3a8657,color:#163b25

  subgraph g1 ["&lt;b&gt;def&lt;/b&gt; main"]
    n1(["start"]):::term
    n2["stdin &lt;b&gt;script&lt;/b&gt; gen()"]:::script
    n3["&lt;b&gt;script&lt;/b&gt; upper()"]:::script
    n4["n = &lt;b&gt;script&lt;/b&gt; count()"]:::script
    n5(["end"]):::term
  end

  n1 --&gt; n2
  n2 --&gt;|"stdout → stdin"| n3
  n3 --&gt;|"stdout → stdin"| n4
  n4 --&gt;|"return n"| n5</code></pre>
<div class="graph-render" role="img" aria-label="Rendered flowchart"></div>
</div>

<div class="code-tab-panel" data-panel="graph-say-hello-d0" data-graph-sample data-sample-file="say_hello.jh" data-graph-args="-d 0">
<p>The same <code>say_hello.jh</code> with <code>-d 0</code>: <code>valid_name</code> is collapsed to a dashed call, and the closing comment says how to draw it.</p>
<pre><code class="language-jaiph" data-sample-source>#!/usr/bin/env jaiph

# check the name before calling the agent
def valid_name(name_arg) {
  return match name_arg {
    /[A-Z][a-z]+/ =&gt; name_arg
    _ =&gt; fail "You provided an invalid name :("
  }
}

# export def main is the jaiph run entry
export def main(name_arg) {
  const name = valid_name(name_arg)

  # prompts call agents - cursor by default, but it's configurable
  const response = prompt """
    Say hello to ${name} and provide a fun fact about a person with the same name.
    Respond with a single line. Do not inspect files or run tools.
  """

  return response
}</code></pre>
<pre><code class="language-bash">jaiph graph -d 0 examples/say_hello.jh</code></pre>
<pre><code class="language-text" data-graph-mermaid>flowchart TD
  classDef term fill:#ffffff,stroke:#8a938d,color:#1d2420
  classDef input fill:#fff3d1,stroke:#b7871a,color:#4d3600
  classDef defx fill:#dce7fb,stroke:#3563c9,color:#132f66,stroke-width:1.5px,stroke-dasharray:4 3
  classDef prompt fill:#eee2fd,stroke:#7646d6,color:#381a72

  subgraph g1 ["&lt;b&gt;def&lt;/b&gt; main"]
    n1(["start"]):::term
    n2[/"in: name_arg"/]:::input
    n3[["name = &lt;b&gt;def&lt;/b&gt; valid_name(name_arg)"]]:::defx
    n4["response = &lt;b&gt;prompt&lt;/b&gt; #quot;Say hello to $#123;name#125; and provide a fun...#quot;"]:::prompt
    n5(["end"]):::term
  end

  n1 --&gt; n2
  n2 --&gt; n3
  n3 --&gt; n4
  n4 --&gt;|"return response"| n5

%% collapsed: 1 def beyond --depth 0 (use -d all to expand)</code></pre>
<div class="graph-render" role="img" aria-label="Rendered flowchart"></div>
</div>
</div>
{% endraw %}
