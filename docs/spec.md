Good. We will **not drift** into research-engine land.

You’re defining:

* 🟢 **Scripting language**
* 🟢 Transpiles to **pure bash**
* 🟢 A file/module/rule = process
* 🟢 Exit code = truth
* 🟢 stdout = output artifact
* 🟢 Simple composition
* 🟢 Deterministic execution
* 🟢 No hidden inference engine

This is much cleaner.

You’re basically designing:

> A typed, structured, AI-aware shell DSL that compiles to strict bash.

That’s excellent.

Let’s formalize this carefully.

---

# 🔷 Core Philosophy of Early jalph

1. **Everything is a process**
2. Exit code = success/failure (0 = pass)
3. stdout = result
4. Rules are functions
5. Workflows orchestrate rules
6. Transpiled output is readable bash
7. No runtime dependency other than bash

No magic.

---

# 🔷 Minimal Mental Model

A `.jrh` file:

* defines rules (functions)
* defines workflows (functions calling rules)
* may import other files
* exports selected symbols

It transpiles to `.sh`.

---

# 🔷 Example — jalph (Source)

```jalph id="aqn6yq"
import "../my_other_workflow.jrh"

export rule rule1 {
  run coder.modify "./repo"
}

rule rule2 {
  run "npm test"
}

workflow my_workflow_1 {

  prompt "lorem ipsum"

  repeat 10

  rules:
    - my_other_workflow.rule42
    - rule1
    - rule2
}
```

---

# 🔷 Transpiled Bash (Readable, Not Obfuscated)

```bash
set -euo pipefail

source "../my_other_workflow.sh"

my_workflow_1__rule1() {
  coder modify "./repo"
}

my_workflow_1__rule2() {
  npm test
}

my_workflow_1() (
  repeat_limit=10

  for i in $(seq 1 "$repeat_limit"); do
    echo "Prompt: lorem ipsum"

    my_other_workflow__rule42 || continue
    my_workflow_1__rule1 || continue
    my_workflow_1__rule2 || continue

    exit 0
  done

  exit 1
)
```

Notice:

* Workflow executes in subshell `()`
* If all rules pass → exit 0
* If any fails → retry until limit
* After limit → exit 1

Deterministic.

---

# 🔷 Now Let’s Properly Specify jalph 0.1

We stay minimal.

---

# 1️⃣ File Structure

Extension: `.jrh`

Top-level elements:

* import
* export
* rule
* workflow

Nothing else for v0.1.

---

# 2️⃣ Imports

```jalph id="s4he7q"
import "../x.jrh"
```

Transpiles to:

```bash
source "../x.sh"
```

Import is compile-time.
No dynamic loading.

---

# 3️⃣ Rule Definition

```jalph id="z5a3m0"
rule rule_name {
  ...
}
```

Semantics:

* Compiles to bash function
* Returns exit code
* stdout preserved
* No implicit retry
* Must not exit the shell directly

Example:

```jalph id="xf3m9p"
rule lint {
  run "eslint ."
}
```

Transpiles:

```bash
lint() {
  eslint .
}
```

---

# 4️⃣ Export

```jalph id="m7b8cv"
export rule rule1
```

Marks symbol as public.

Implementation:

* Transpiler tracks exports
* Optional validation
* No runtime effect

---

# 5️⃣ Workflow

```jalph id="j73w3u"
workflow name {
  prompt "text"
  repeat 10
  rules:
    - ruleA
    - module.ruleB
}
```

Semantics:

* Workflow is bash function
* Executes in subshell
* Iterative retry
* Stops when all rules return 0

---

# 6️⃣ Rule Execution Semantics

Within workflow:

```bash
ruleA || continue
```

Important design decision:

You chose:

> If rule fails, continue loop (retry entire chain).

Not:

> fail immediately.

That’s correct for AI orchestration.

---

# 🔷 Important: Deterministic Rule Chain

Rules run sequentially.

If:

* rule1 fails → retry
* rule1 passes, rule2 fails → retry from start
* All pass → success

That gives:

* deterministic state progression
* predictable retry

---

# 🔷 Prompt Semantics

You wrote:

```jalph id="blb1ce"
prompt "lorem ipsum"
# or
prompt "$1"
```

This likely maps to:

```bash
JALPH_PROMPT="lorem ipsum"
```

Or:

```bash
JALPH_PROMPT="$1"
```

Better:

* prompt becomes environment variable
* rules can read it

Transpiled:

```bash
export JALPH_PROMPT="lorem ipsum"
```

or

```bash
export JALPH_PROMPT="$1"
```

No runtime prompt engine inside jalph.
Agents are external commands.

Example rule:

```jalph id="cld08r"
rule ask_ai {
  run ai_cli --prompt "$JALPH_PROMPT"
}
```

Clean separation.

---

# 🔷 run Semantics

```jalph id="nyg3f0"
run "npm test"
```

Transpiles to:

```bash
eval "npm test"
```

Or better:

```bash
npm test
```

Transpiler should detect if string literal → emit raw command.

We must avoid unsafe eval unless necessary.

---

# 🔷 Repeat

```jalph id="q85ly7"
repeat 10
```

Optional.
Default maybe 1.

Transpiles to:

```bash
repeat_limit=10
```

---

# 🔷 Rule Namespacing

Imported module:

```jalph id="u5hn80"
import "../mod.jrh"
```

Transpiler converts:

* `mod.rule42` → `mod__rule42`

Avoid bash namespace collision.

So rule function name =:

```
<module>__<rule>
```

Workflow-local rule:

```
<workflow>__<rule>
```

Or simpler:

```
<module>__<rule>
```

Keep consistent.

---

# 🔷 Minimal Formal Grammar (v0.1)

```
file        := statement*
statement   := import | export | rule | workflow

import      := "import" STRING
export      := "export" "rule" IDENT

rule        := "rule" IDENT block

workflow    := "workflow" IDENT block

block       := "{" element* "}"

element     := prompt | repeat | rules | run

prompt      := "prompt" STRING
repeat      := "repeat" NUMBER
rules       := "rules:" rule_ref_list
rule_ref    := IDENT | IDENT "." IDENT
```

Keep it tiny.

---

# 🔷 What We Are NOT Adding (Yet)

* no logical inference
* no SQL
* no fact engine
* no type system
* no constraints DSL
* no parallelism
* no dynamic rule generation

We resist drift.

---

# 🔷 Why This Design Is Strong

Because it is:

* Debuggable (bash output visible)
* CI-friendly
* No hidden runtime
* Can run without AI
* Compatible with any agent CLI
* Portable
* Auditable

You are essentially building:

> “Typed, structured, composable shell for AI workflows.”

That’s powerful enough.

---

# 🔷 Where This Can Evolve (Later)

Without breaking 0.1:

1. Add `require` sugar (transpiles to rule)
2. Add `timeout`
3. Add `retry` per rule
4. Add `on_fail` hooks
5. Add artifact capture
6. Add pipe support
7. Add strict mode flags

But not now.

---

# 🔷 Key Engineering Questions (Early Stage Critical)

1. Is transpiler written in Node? (likely yes)
2. Do we enforce no global variables?
3. Do we auto-inject `set -euo pipefail`?
4. Do we enforce bash version?
5. Do we forbid subshell inside rules?

These affect long-term stability.

---

# 🔷 Summary

jalph 0.1 =

* Structured bash
* AI-aware
* Retry orchestration
* Namespaced
* Deterministic
* Zero runtime dependency

That is clean.
That is buildable.
That does not drift.

---

If you want next step, we can:

* Define exact transpilation algorithm
* Define AST structure
* Design error reporting model
* Define how rule outputs are captured/propagated
* Or design jalph CLI UX (`jalph run file.jrh workflow`)

Your call.
