---
title: Execution flow
permalink: /reference/execution-flow
diataxis: reference
mermaid: true
redirect_from:
  - /reference/graph
---

# Execution flow

`jaiph graph` shows how a workflow runs before anyone runs it. It draws the order of the steps, where the workflow branches, which calls run in parallel, what happens when a step fails, and which def handles each message. The command reads a `.jh` file and prints a [Mermaid](https://mermaid.js.org/syntax/flowchart.html) flowchart, which GitHub, many Markdown editors, and the Mermaid live editor can draw. It doesn't call any agent or script, so it is safe to run on any file that compiles.

```bash
jaiph graph examples/say_hello.jh > say_hello.mmd
```

The chart starts at `main` unless `--def <name>` picks another def. The flags are listed in [CLI reference](cli.md#jaiph-graph), and the [examples](#examples) at the end of this page show the chart for each program in the `examples` folder.

## How to read the chart

Each def is a grey box with the def's name at the top. The steps inside the box run from top to bottom, from **start** to **end**. When a def calls another def, an arrow goes from the call into the box of the called def, and the arrow that leaves that box's **end** goes back to the step after the call. Each def is drawn once, even when several steps call it. The def the chart starts at is on the left, and the defs it calls are to its right. Two defs that the starting def runs in parallel with `async` are drawn on either side of it.

A def from an imported file keeps the name it was imported under, e.g. `git.commit`, and its box has a dashed border. The shapes follow the ISO 5807 flowchart standard, and Mermaid 11.3 or later is needed to draw the bars of `async` calls. ISO 5807 has no dashed variants, so the dashed border of an imported def and the dashed outline of a def call that isn't drawn are Jaiph's own markings.

## Steps

| Shape | Step | ISO 5807 symbol | What it shows |
|---|---|---|---|
| <span class="flow-icon flow-icon-term" aria-hidden="true"></span> | Start and end | Terminator | Where a def begins and where it returns. |
| <span class="flow-icon flow-icon-input" aria-hidden="true"></span> | Parameters | Data | The def's parameters, e.g. `in: name`. |
| <span class="flow-icon flow-icon-def" aria-hidden="true"></span> | Def call | Predefined process | A call to another def. A dashed outline, which is Jaiph's own marking and not part of ISO 5807, means the called def isn't drawn, as explained in [Defs that aren't drawn](#defs-that-arent-drawn). |
| <span class="flow-icon flow-icon-script" aria-hidden="true"></span> | Script | Process | A script, an inline script, or one stage of a `stdin` pipeline. |
| <span class="flow-icon flow-icon-prompt" aria-hidden="true"></span> | Prompt | Process | A prompt sent to an agent. |
| <span class="flow-icon flow-icon-send" aria-hidden="true"></span> | Send | Process | A message sent to a channel. |
| <span class="flow-icon flow-icon-inbox" aria-hidden="true"></span> | Inbox | Stored data | Messages that wait until the entry def has finished its own steps. The inbox appears when a def sends to a channel that the entry file routes. |
| <span class="flow-icon flow-icon-decision" aria-hidden="true"></span> | Condition | Decision | An `if` or a `match`. Each arrow out of it is labelled with `yes`, `no`, or the `match` pattern. |
| <span class="flow-icon flow-icon-loop" aria-hidden="true"></span> | Loop | Preparation | A `for … in` loop. The `next` arrow goes back for the next line, and the `done` arrow leaves the loop. |
| <span class="flow-icon flow-icon-join" aria-hidden="true"></span> | Join point | Connector | The point where the arms of a `match` meet again, or where the entry def starts handling its inbox. |
| <span class="flow-icon flow-icon-fork" aria-hidden="true"></span> | Parallel bar | Parallel mode | The first bar starts a group of `async` calls, and the second bar waits until all of them finish. |
| <span class="flow-icon flow-icon-fail" aria-hidden="true"></span> | Failure | Terminator | A `fail` step, or a `match` arm that fails. The workflow stops there. |

## Arrows

| Line | Arrow | ISO 5807 symbol | What it shows |
|---|---|---|---|
| <span class="flow-line flow-line-flow" aria-hidden="true"></span> | Next step | Flow line | The step that runs next. A label on the arrow names the branch (`yes`, `no`, or a `match` pattern), the returned value, `stdout → stdin` between pipeline stages, or `async`. |
| <span class="flow-line flow-line-fail" aria-hidden="true"></span> | **recover** or **catch** | Dashed line (alternative path) | The step failed, so its `recover` or `catch` body runs. |
| <span class="flow-line flow-line-flow" aria-hidden="true"></span> | `retry` | Flow line | The `recover` body has finished, so the failed step runs again. |
| <span class="flow-line flow-line-comm" aria-hidden="true"></span> | `↯ channel` | Communication link | A `send` puts a message in the inbox. The def that sent it doesn't wait and goes on with its next step. |
| <span class="flow-line flow-line-control" aria-hidden="true"></span> | `deliver channel` | Control transfer | The entry def has finished its own steps, so it passes the waiting messages of that channel to the def the channel routes to. |

Messages are delivered one channel at a time, in the order in which each channel first got a message. When a def that receives a message sends to another channel, that channel is delivered after the ones before it. Only routes declared in the entry file are used, the same as when the workflow runs, so a message to a channel that is routed only in an imported file is never delivered.

## Labels

- Keywords such as **def**, **script**, **prompt**, **send**, **fail**, **if**, and **match** are bold.
- When a step stores its result, the variable comes first, e.g. `name = def valid_name(name_arg)`. Words that change how a step runs, such as `async` and `stdin`, come before the keyword.
- A prompt shows the first line of its text, and a `fail` shows the first line of its message. Text longer than 40 characters is cut at the end of a word and ends with `...`. A named prompt shows its call instead, e.g. `prompt review(diff)`.
- Other labels are cut at 70 characters.
- The chart leaves out `log`, `logerr`, `logwarn`, comments, and any `const` that only stores a plain value.
- The command prints the same text every time for the same file, so the output can be kept in a repository and reviewed as a diff.

## Defs that aren't drawn

The chart draws only the defs that are close to the entry def, so a large workflow stays readable. A def that isn't drawn appears as a call with a dashed outline, and its steps aren't shown. A def isn't drawn when any of these is true:

- It is more than `--depth` calls away from the entry def. The default is 3. A def that a channel routes to counts as one call away.
- It is in a file that is more than `--import-depth` imports away from the entry file. The default is 1, so defs in files that the entry file imports directly are drawn.
- It is in a library under `.jaiph/libs/`, and the `--libs` flag isn't set.

The value `all` removes a limit, e.g. `jaiph graph -d all -i all -l flow.jh` draws every def. When the chart leaves defs out, its last line is a comment that counts them and names the flags that would draw them:

```text
%% collapsed: 2 defs beyond --depth 3, 4 library defs (use -d all, -l to expand)
```

## Examples

Each example below is a program from the `examples` folder of the Jaiph repository, with the chart that `jaiph graph` prints for it. The **Graph** tab shows the rendered chart, the next tab shows the source file, and the **Mermaid** tab shows the command and the text it printed. A test runs the command for every example and fails when the text on this page differs from the output.

<!-- graph-samples -->

### One prompt

The smallest workflow sends one prompt and stores the answer in `response`. The `log` step isn't drawn.

{% raw %}
<div class="graph-sample" data-graph-sample="hello">
<div class="code-tabs">
<div class="code-tab-list">
<button type="button" class="code-tab-button is-active" data-target="hello-graph">Graph</button>
<button type="button" class="code-tab-button" data-target="hello-src-0">hello.jh</button>
<button type="button" class="code-tab-button" data-target="hello-mermaid">Mermaid</button>
</div>
<div class="code-tab-panel is-active" data-panel="hello-graph">
<div class="graph-render" role="img" aria-label="Execution flow of hello.jh"></div>
</div>
<div class="code-tab-panel" data-panel="hello-src-0">
<pre><code class="language-jaiph" data-sample-source="hello.jh">export def main() {
  const response = prompt "Say: Hello, I am [model name]!"
  log response
}</code></pre>
</div>
<div class="code-tab-panel" data-panel="hello-mermaid">
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
  n2 --&gt; n3

  style g1 fill:#f6f7f6,stroke:#b9c0bb,color:#1d2420</code></pre>
</div>
</div>
</div>
{% endraw %}

### say_hello.jh

`main` calls `valid_name`, so `valid_name` gets its own box. The `match` in `valid_name` either returns the name or fails, and the prompt in `main` shows the first line of its text.

{% raw %}
<div class="graph-sample" data-graph-sample="say-hello" data-sample-file="say_hello.jh">
<div class="code-tabs">
<div class="code-tab-list">
<button type="button" class="code-tab-button is-active" data-target="say-hello-graph">Graph</button>
<button type="button" class="code-tab-button" data-target="say-hello-src-0">say_hello.jh</button>
<button type="button" class="code-tab-button" data-target="say-hello-mermaid">Mermaid</button>
</div>
<div class="code-tab-panel is-active" data-panel="say-hello-graph">
<div class="graph-render" role="img" aria-label="Execution flow of say_hello.jh"></div>
</div>
<div class="code-tab-panel" data-panel="say-hello-src-0">
<pre><code class="language-jaiph" data-sample-source="say_hello.jh">#!/usr/bin/env jaiph

# check the name before calling the agent
def valid_name(name_arg) {
  return match name_arg {
    /[A-Z][a-z]+/ =&gt; name_arg
    _ =&gt; fail "You provided an invalid name :("
  }
}

# jaiph run starts at export def main
export def main(name_arg) {
  const name = valid_name(name_arg)

  # a prompt calls an agent (Cursor by default)
  const response = prompt """
    Say hello to ${name} and provide a fun fact
    about a person with the same name.
    Respond with a single line.
    Do not inspect files or run tools.
  """

  return response
}</code></pre>
</div>
<div class="code-tab-panel" data-panel="say-hello-mermaid">
<pre><code class="language-bash">jaiph graph examples/say_hello.jh</code></pre>
<pre><code class="language-text" data-graph-mermaid>flowchart TD
  classDef term fill:#ffffff,stroke:#8a938d,color:#1d2420
  classDef fail fill:#fde2e2,stroke:#b42318,color:#7a1a12
  classDef input fill:#fff3d1,stroke:#b7871a,color:#4d3600
  classDef def fill:#dce7fb,stroke:#3563c9,color:#132f66,stroke-width:1.5px
  classDef prompt fill:#eee2fd,stroke:#7646d6,color:#381a72
  classDef decision fill:#f1f2f1,stroke:#5f6762,color:#1d2420

  subgraph g2 ["&lt;b&gt;def&lt;/b&gt; valid_name"]
    n4(["start"]):::term
    n5[/"in: name_arg"/]:::input
    n6{"&lt;b&gt;match&lt;/b&gt; name_arg"}:::decision
    n7(["&lt;b&gt;fail&lt;/b&gt; #quot;You provided an invalid name :(#quot;"]):::fail
    n8(["end"]):::term
  end
  subgraph g1 ["&lt;b&gt;def&lt;/b&gt; main"]
    n1(["start"]):::term
    n2[/"in: name_arg"/]:::input
    n3[["name = &lt;b&gt;def&lt;/b&gt; valid_name(name_arg)"]]:::def
    n9["response = &lt;b&gt;prompt&lt;/b&gt; #quot;Say hello to $#123;name#125; and provide a fun...#quot;"]:::prompt
    n10(["end"]):::term
  end

  n1 --&gt; n2
  n2 --&gt; n3
  n3 --&gt; n4
  n4 --&gt; n5
  n5 --&gt; n6
  n6 --&gt;|"_"| n7
  n6 --&gt;|"/[A-Z][a-z]+/ → name_arg"| n8
  n8 --&gt; n9
  n9 --&gt;|"return response"| n10

  style g1 fill:#f6f7f6,stroke:#b9c0bb,color:#1d2420
  style g2 fill:#f6f7f6,stroke:#b9c0bb,color:#1d2420</code></pre>
</div>
</div>
</div>
{% endraw %}

### recover_loop.jh

When `check_report_exists` fails, the red **recover** arrow leads to the prompt that creates the report. The `retry` arrow then goes back to `check_report_exists`, which runs again.

{% raw %}
<div class="graph-sample" data-graph-sample="recover-loop" data-sample-file="recover_loop.jh">
<div class="code-tabs">
<div class="code-tab-list">
<button type="button" class="code-tab-button is-active" data-target="recover-loop-graph">Graph</button>
<button type="button" class="code-tab-button" data-target="recover-loop-src-0">recover_loop.jh</button>
<button type="button" class="code-tab-button" data-target="recover-loop-mermaid">Mermaid</button>
</div>
<div class="code-tab-panel is-active" data-panel="recover-loop-graph">
<div class="graph-render" role="img" aria-label="Execution flow of recover_loop.jh"></div>
</div>
<div class="code-tab-panel" data-panel="recover-loop-src-0">
<pre><code class="language-jaiph" data-sample-source="recover_loop.jh">#!/usr/bin/env jaiph

# a script body goes in '…' or '''…''' quotes
# it is bash by default; for another language, put the
# interpreter before the quotes: node'''…''', python3'''…'''
script check_report_exists = '''
  test -f report.txt
'''

export def main() {
  # when check_report_exists() fails, the recover body runs,
  # and then check_report_exists() runs again (up to 10 times)
  check_report_exists() recover (failure) {
    logerr "Failed to check report.txt"
    prompt "report.txt is missing. Create it with a short dummy summary."
  }

  # a script can also be written inline
  return 'cat report.txt'()
}</code></pre>
</div>
<div class="code-tab-panel" data-panel="recover-loop-mermaid">
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

  style g1 fill:#f6f7f6,stroke:#b9c0bb,color:#1d2420
  linkStyle 1 stroke:#b42318,color:#b42318</code></pre>
</div>
</div>
</div>
{% endraw %}

### agent_inbox.jh

`scanner` sends a message to `findings`, and the message waits in the inbox of `main`. When `main` has finished its own steps, it delivers `findings` to `analyst`. `analyst` sends to `report`, so `main` then delivers `report` to `reviewer`.

{% raw %}
<div class="graph-sample" data-graph-sample="agent-inbox" data-sample-file="agent_inbox.jh">
<div class="code-tabs">
<div class="code-tab-list">
<button type="button" class="code-tab-button is-active" data-target="agent-inbox-graph">Graph</button>
<button type="button" class="code-tab-button" data-target="agent-inbox-src-0">agent_inbox.jh</button>
<button type="button" class="code-tab-button" data-target="agent-inbox-mermaid">Mermaid</button>
</div>
<div class="code-tab-panel is-active" data-panel="agent-inbox-graph">
<div class="graph-render" role="img" aria-label="Execution flow of agent_inbox.jh"></div>
</div>
<div class="code-tab-panel" data-panel="agent-inbox-src-0">
<pre><code class="language-jaiph" data-sample-source="agent_inbox.jh">#!/usr/bin/env jaiph

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
</div>
<div class="code-tab-panel" data-panel="agent-inbox-mermaid">
<pre><code class="language-bash">jaiph graph examples/agent_inbox.jh</code></pre>
<pre><code class="language-text" data-graph-mermaid>flowchart TD
  classDef term fill:#ffffff,stroke:#8a938d,color:#1d2420
  classDef input fill:#fff3d1,stroke:#b7871a,color:#4d3600
  classDef def fill:#dce7fb,stroke:#3563c9,color:#132f66,stroke-width:1.5px
  classDef send fill:#d8f1ee,stroke:#22857b,color:#0d3a35
  classDef channel fill:#d8f1ee,stroke:#22857b,color:#0d3a35
  classDef join fill:#8a938d,stroke:#8a938d,color:#8a938d

  subgraph g4 ["&lt;b&gt;def&lt;/b&gt; reviewer"]
    n12(["start"]):::term
    n13[/"in: msg"/]:::input
    n14(["end"]):::term
  end
  subgraph g3 ["&lt;b&gt;def&lt;/b&gt; analyst"]
    n8(["start"]):::term
    n9[/"in: msg"/]:::input
    n10["&lt;b&gt;send&lt;/b&gt; #quot;Summary: $#123;msg#125;#quot; → report"]:::send
    n11(["end"]):::term
  end
  subgraph g2 ["&lt;b&gt;def&lt;/b&gt; scanner"]
    n3(["start"]):::term
    n4["&lt;b&gt;send&lt;/b&gt; #quot;Found 3 issues in auth module#quot; → findings"]:::send
    n6(["end"]):::term
  end
  subgraph g1 ["&lt;b&gt;def&lt;/b&gt; main"]
    n1(["start"]):::term
    n2[["&lt;b&gt;def&lt;/b&gt; scanner()"]]:::def
    n5[("main inbox")]:::channel
    n7((" ")):::join
    n15(["end"]):::term
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

  style g1 fill:#f6f7f6,stroke:#b9c0bb,color:#1d2420
  style g2 fill:#f6f7f6,stroke:#b9c0bb,color:#1d2420
  style g3 fill:#f6f7f6,stroke:#b9c0bb,color:#1d2420
  style g4 fill:#f6f7f6,stroke:#b9c0bb,color:#1d2420
  linkStyle 3 stroke:#22857b,stroke-width:2px
  linkStyle 8 stroke:#22857b,stroke-width:2px</code></pre>
</div>
</div>
</div>
{% endraw %}

### async.jh

`main` starts two `async` calls at the first bar, and both calls run at the same time. `main` waits at the second bar until both calls have finished.

{% raw %}
<div class="graph-sample" data-graph-sample="async" data-sample-file="async.jh">
<div class="code-tabs">
<div class="code-tab-list">
<button type="button" class="code-tab-button is-active" data-target="async-graph">Graph</button>
<button type="button" class="code-tab-button" data-target="async-src-0">async.jh</button>
<button type="button" class="code-tab-button" data-target="async-mermaid">Mermaid</button>
</div>
<div class="code-tab-panel is-active" data-panel="async-graph">
<div class="graph-render" role="img" aria-label="Execution flow of async.jh"></div>
</div>
<div class="code-tab-panel" data-panel="async-src-0">
<pre><code class="language-jaiph" data-sample-source="async.jh">#!/usr/bin/env jaiph

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

# main waits until both async calls finish
export def main(name) {
  async cursor_say_hello(name)
  async claude_say_hello(name)
}</code></pre>
</div>
<div class="code-tab-panel" data-panel="async-mermaid">
<pre><code class="language-bash">jaiph graph examples/async.jh</code></pre>
<pre><code class="language-text" data-graph-mermaid>flowchart TD
  classDef term fill:#ffffff,stroke:#8a938d,color:#1d2420
  classDef input fill:#fff3d1,stroke:#b7871a,color:#4d3600
  classDef def fill:#dce7fb,stroke:#3563c9,color:#132f66,stroke-width:1.5px
  classDef prompt fill:#eee2fd,stroke:#7646d6,color:#381a72
  classDef fork fill:#1d2420,stroke:#1d2420

  subgraph g3 ["&lt;b&gt;def&lt;/b&gt; claude_say_hello"]
    n10(["start"]):::term
    n11[/"in: name"/]:::input
    n12["response = &lt;b&gt;prompt&lt;/b&gt; #quot;$#123;prompt_text#125;#quot;"]:::prompt
    n13(["end"]):::term
  end
  subgraph g2 ["&lt;b&gt;def&lt;/b&gt; cursor_say_hello"]
    n5(["start"]):::term
    n6[/"in: name"/]:::input
    n7["response = &lt;b&gt;prompt&lt;/b&gt; #quot;$#123;prompt_text#125;#quot;"]:::prompt
    n8(["end"]):::term
  end
  subgraph g1 ["&lt;b&gt;def&lt;/b&gt; main"]
    n1(["start"]):::term
    n2[/"in: name"/]:::input
    n3@{ shape: fork, label: "" }
    n4[["async &lt;b&gt;def&lt;/b&gt; cursor_say_hello(name)"]]:::def
    n9[["async &lt;b&gt;def&lt;/b&gt; claude_say_hello(name)"]]:::def
    n14@{ shape: fork, label: "" }
    n15(["end"]):::term
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
  class n14 fork
  style g1 fill:#f6f7f6,stroke:#b9c0bb,color:#1d2420
  style g2 fill:#f6f7f6,stroke:#b9c0bb,color:#1d2420
  style g3 fill:#f6f7f6,stroke:#b9c0bb,color:#1d2420</code></pre>
</div>
</div>
</div>
{% endraw %}

### stdin.jh

The three scripts form a `stdin` pipeline, so the output of each script is the input of the next one.

{% raw %}
<div class="graph-sample" data-graph-sample="stdin" data-sample-file="stdin.jh">
<div class="code-tabs">
<div class="code-tab-list">
<button type="button" class="code-tab-button is-active" data-target="stdin-graph">Graph</button>
<button type="button" class="code-tab-button" data-target="stdin-src-0">stdin.jh</button>
<button type="button" class="code-tab-button" data-target="stdin-mermaid">Mermaid</button>
</div>
<div class="code-tab-panel is-active" data-panel="stdin-graph">
<div class="graph-render" role="img" aria-label="Execution flow of stdin.jh"></div>
</div>
<div class="code-tab-panel" data-panel="stdin-src-0">
<pre><code class="language-jaiph" data-sample-source="stdin.jh">#!/usr/bin/env jaiph

# stdin connects scripts with -&gt;, and the data streams
# from one script to the next without being held in memory
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
  # make three lines -&gt; uppercase them -&gt; count them
  const n = stdin gen() -&gt; upper() -&gt; count()
  return n
}</code></pre>
</div>
<div class="code-tab-panel" data-panel="stdin-mermaid">
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
  n4 --&gt;|"return n"| n5

  style g1 fill:#f6f7f6,stroke:#b9c0bb,color:#1d2420</code></pre>
</div>
</div>
</div>
{% endraw %}

### say_hello.jh with -d 0

With `-d 0` the chart draws only `main`. The call to `valid_name` has a dashed outline, and the last line of the Mermaid text names the flag that would draw it.

{% raw %}
<div class="graph-sample" data-graph-sample="say-hello-d0" data-sample-file="say_hello.jh" data-graph-args="-d 0">
<div class="code-tabs">
<div class="code-tab-list">
<button type="button" class="code-tab-button is-active" data-target="say-hello-d0-graph">Graph</button>
<button type="button" class="code-tab-button" data-target="say-hello-d0-src-0">say_hello.jh</button>
<button type="button" class="code-tab-button" data-target="say-hello-d0-mermaid">Mermaid</button>
</div>
<div class="code-tab-panel is-active" data-panel="say-hello-d0-graph">
<div class="graph-render" role="img" aria-label="Execution flow of say_hello.jh"></div>
</div>
<div class="code-tab-panel" data-panel="say-hello-d0-src-0">
<pre><code class="language-jaiph" data-sample-source="say_hello.jh">#!/usr/bin/env jaiph

# check the name before calling the agent
def valid_name(name_arg) {
  return match name_arg {
    /[A-Z][a-z]+/ =&gt; name_arg
    _ =&gt; fail "You provided an invalid name :("
  }
}

# jaiph run starts at export def main
export def main(name_arg) {
  const name = valid_name(name_arg)

  # a prompt calls an agent (Cursor by default)
  const response = prompt """
    Say hello to ${name} and provide a fun fact
    about a person with the same name.
    Respond with a single line.
    Do not inspect files or run tools.
  """

  return response
}</code></pre>
</div>
<div class="code-tab-panel" data-panel="say-hello-d0-mermaid">
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

  style g1 fill:#f6f7f6,stroke:#b9c0bb,color:#1d2420

%% collapsed: 1 def beyond --depth 0 (use -d all to expand)</code></pre>
</div>
</div>
</div>
{% endraw %}
