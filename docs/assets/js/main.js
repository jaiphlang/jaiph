(function () {

    function escapeHTML(str) {
        return str
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;");
    }

    const STATEMENT_KEYWORDS = new Set([
        "import",
        "as",
        "config",
        "export",
        "local",
        "rule",
        "workflow",
        "function",
        "test",
        "ensure",
        "recover",
        "run",
        "prompt",
        "returns",
        "mock",
        "log",
        "on",
        "respond",
        "contains",
        "expectContain",
        "expectNotContain",
        "expectEqual",
        "allow_failure",
        "if",
        "elif",
        "then",
        "else",
        "fi"
    ]);

    /**
     * Tokenizes one Jaiph line while preserving multiline-string state.
     *
     * Args:
     *   line: Source line.
     *   state: Mutable lexer state ({ inString: boolean }).
     * Returns:
     *   Array of token objects.
     */
    function tokenizeJaiphLine(line, state) {
        const tokens = [];
        let i = 0;

        while (i < line.length) {
            const ch = line[i];

            if (state.inString) {
                const start = i;
                while (i < line.length) {
                    if (line[i] === '"' && line[i - 1] !== "\\") {
                        i += 1;
                        state.inString = false;
                        break;
                    }
                    i += 1;
                }
                tokens.push({ type: "string", value: line.slice(start, i), kind: "string" });
                continue;
            }

            if (ch === " " || ch === "\t") {
                const start = i;
                while (i < line.length && (line[i] === " " || line[i] === "\t")) {
                    i += 1;
                }
                tokens.push({ type: "whitespace", value: line.slice(start, i), kind: "plain" });
                continue;
            }

            if (ch === "/" && line[i + 1] === "/") {
                tokens.push({ type: "comment", value: line.slice(i), kind: "comment" });
                break;
            }

            if (ch === "#") {
                tokens.push({ type: "comment", value: line.slice(i), kind: "comment" });
                break;
            }

            if (ch === '"') {
                const start = i;
                let closed = false;
                i += 1;
                while (i < line.length) {
                    if (line[i] === '"' && line[i - 1] !== "\\") {
                        i += 1;
                        closed = true;
                        break;
                    }
                    i += 1;
                }
                if (!closed) {
                    state.inString = true;
                }
                tokens.push({ type: "string", value: line.slice(start, i), kind: "string" });
                continue;
            }

            if (/[A-Za-z_]/.test(ch)) {
                const start = i;
                i += 1;
                while (i < line.length && /[A-Za-z0-9_]/.test(line[i])) {
                    i += 1;
                }
                const value = line.slice(start, i);
                tokens.push({
                    type: "identifier",
                    value: value,
                    kind: "plainIdentifier"
                });
                continue;
            }

            if (ch === ".") {
                tokens.push({ type: "dot", value: ".", kind: "plain" });
                i += 1;
                continue;
            }

            if (ch === "-" && line[i + 1] === ">") {
                tokens.push({ type: "arrow", value: "->", kind: "operator" });
                i += 2;
                continue;
            }

            tokens.push({ type: "symbol", value: ch, kind: "plain" });
            i += 1;
        }

        return tokens;
    }

    /**
     * Applies semantic meaning to Jaiph tokens (AST-like annotation pass).
     *
     * Args:
     *   tokens: Flat token list for one line.
     * Returns:
     *   New token list with refined token kinds.
     */
    function annotateJaiphTokens(tokens, knownSymbols) {
        const annotated = tokens.map(function (token) {
            return { type: token.type, value: token.value, kind: token.kind };
        });

        const significant = annotated
            .map(function (token, index) {
                return { token: token, index: index };
            })
            .filter(function (entry) {
                return entry.token.type !== "whitespace" && entry.token.type !== "comment";
            });

        if (significant.length === 0) {
            return annotated;
        }

        const first = significant[0];
        const firstValue = first.token.type === "identifier" ? first.token.value : "";

        // Mark all keyword identifiers anywhere on the line
        significant.forEach(function (entry) {
            if (entry.token.type === "identifier" && STATEMENT_KEYWORDS.has(entry.token.value)) {
                annotated[entry.index].kind = "keyword";
            }
        });

        // Definition names after rule / workflow / function
        if (
            (firstValue === "rule" || firstValue === "workflow" || firstValue === "function") &&
            significant[1] &&
            significant[1].token.type === "identifier"
        ) {
            annotated[significant[1].index].kind = "definition";
        }

        // Assignment: identifier = ... → variable and operator
        for (let i = 0; i < significant.length - 1; i += 1) {
            const curr = significant[i];
            const next = significant[i + 1];
            if (
                curr.token.type === "identifier" &&
                curr.token.kind !== "keyword" &&
                next.token.type === "symbol" &&
                next.token.value === "="
            ) {
                annotated[curr.index].kind = "variable";
                annotated[next.index].kind = "operator";
            }
        }

        // Known local functions referenced in shell lines
        significant.forEach(function (entry) {
            if (
                entry.token.type === "identifier" &&
                annotated[entry.index].kind === "plainIdentifier" &&
                knownSymbols.functionNames.has(entry.token.value)
            ) {
                annotated[entry.index].kind = "identifier";
            }
        });

        if (firstValue === "import") {
            for (let i = 1; i < significant.length - 1; i += 1) {
                if (
                    significant[i].token.type === "identifier" &&
                    significant[i].token.value === "as" &&
                    significant[i + 1].token.type === "identifier"
                ) {
                    annotated[significant[i].index].kind = "keyword";
                    annotated[significant[i + 1].index].kind = "qualifier";
                    break;
                }
            }
        }

        if (firstValue === "if") {
            for (let i = 1; i < significant.length; i += 1) {
                if (
                    significant[i].token.type === "identifier" &&
                    significant[i].token.value === "then"
                ) {
                    annotated[significant[i].index].kind = "keyword";
                }
            }

            for (let i = 1; i < significant.length - 1; i += 1) {
                if (
                    significant[i].token.type === "identifier" &&
                    (significant[i].token.value === "ensure" || significant[i].token.value === "run")
                ) {
                    annotated[significant[i].index].kind = "keyword";
                    if (significant[i + 1].token.type === "identifier") {
                        annotated[significant[i + 1].index].kind = "identifier";
                    }
                    break;
                }
            }
        }

        for (let i = 0; i < annotated.length - 2; i += 1) {
            if (
                annotated[i].type === "identifier" &&
                annotated[i + 1].type === "dot" &&
                annotated[i + 2].type === "identifier" &&
                knownSymbols.importAliases.has(annotated[i].value)
            ) {
                annotated[i].kind = "qualifier";
                annotated[i + 2].kind = "identifier";
            }
        }

        if (firstValue === "ensure" || firstValue === "run") {
            if (significant[1] && significant[1].token.type === "identifier") {
                annotated[significant[1].index].kind = "identifier";
            }
        }

        // on channel -> workflow, workflow2
        if (firstValue === "on") {
            for (let i = 1; i < significant.length; i += 1) {
                if (significant[i].token.type === "arrow") {
                    // mark workflow targets after ->
                    for (let j = i + 1; j < significant.length; j += 1) {
                        if (significant[j].token.type === "identifier") {
                            annotated[significant[j].index].kind = "identifier";
                        }
                    }
                    break;
                }
            }
        }

        // local name = value → definition for variable name
        if (firstValue === "local") {
            if (significant[1] && significant[1].token.type === "identifier") {
                annotated[significant[1].index].kind = "definition";
            }
        }

        if (firstValue === "ensure") {
            for (let i = 1; i < significant.length; i += 1) {
                if (
                    significant[i].token.type === "identifier" &&
                    significant[i].token.value === "else"
                ) {
                    annotated[significant[i].index].kind = "keyword";
                    if (
                        significant[i + 1] &&
                        significant[i + 1].token.type === "identifier" &&
                        significant[i + 1].token.value === "run"
                    ) {
                        annotated[significant[i + 1].index].kind = "keyword";
                        if (significant[i + 2] && significant[i + 2].token.type === "identifier") {
                            annotated[significant[i + 2].index].kind = "identifier";
                        }
                    }
                    break;
                }
            }
        }

        return annotated;
    }

    function collectJaiphSymbols(tokenLines) {
        const knownSymbols = {
            importAliases: new Set(),
            functionNames: new Set()
        };

        tokenLines.forEach(function (tokens) {
            const significant = tokens
                .map(function (token, index) {
                    return { token: token, index: index };
                })
                .filter(function (entry) {
                    return entry.token.type !== "whitespace" && entry.token.type !== "comment";
                });

            if (significant.length === 0) {
                return;
            }

            const first = significant[0];
            const firstValue = first.token.type === "identifier" ? first.token.value : "";

            if (firstValue === "import") {
                for (let i = 1; i < significant.length - 1; i += 1) {
                    if (
                        significant[i].token.type === "identifier" &&
                        significant[i].token.value === "as" &&
                        significant[i + 1].token.type === "identifier"
                    ) {
                        knownSymbols.importAliases.add(significant[i + 1].token.value);
                        break;
                    }
                }
                return;
            }

            if (
                firstValue === "function" &&
                significant[1] &&
                significant[1].token.type === "identifier"
            ) {
                knownSymbols.functionNames.add(significant[1].token.value);
            }
        });

        return knownSymbols;
    }

    /**
     * Builds an AST-like representation for a full Jaiph code block.
     *
     * Args:
     *   raw: Full source block.
     * Returns:
     *   Array of line nodes with annotated tokens.
     */
    function parseJaiph(raw) {
        const state = { inString: false };
        const tokenLines = raw.split("\n").map(function (line) {
            return tokenizeJaiphLine(line, state);
        });
        const knownSymbols = collectJaiphSymbols(tokenLines);

        return tokenLines.map(function (tokens, lineIndex) {
            return {
                type: "line",
                lineNumber: lineIndex + 1,
                tokens: annotateJaiphTokens(tokens, knownSymbols)
            };
        });
    }

    /**
     * Renders one token to highlighted HTML.
     *
     * Args:
     *   token: Annotated token object.
     * Returns:
     *   HTML-safe token string.
     */
    function renderJaiphToken(token) {
        const value = escapeHTML(token.value);
        if (token.kind === "keyword") {
            return `<span class="ralph-keyword">${value}</span>`;
        }
        if (token.kind === "definition") {
            return `<span class="ralph-definition">${value}</span>`;
        }
        if (token.kind === "qualifier") {
            return `<span class="ralph-qualifier">${value}</span>`;
        }
        if (token.kind === "identifier") {
            return `<span class="ralph-identifier">${value}</span>`;
        }
        if (token.kind === "variable") {
            return `<span class="ralph-variable">${value}</span>`;
        }
        if (token.kind === "operator") {
            return `<span class="ralph-operator">${value}</span>`;
        }
        if (token.kind === "string") {
            return `<span class="ralph-string">${value}</span>`;
        }
        if (token.kind === "comment") {
            return `<span class="ralph-comment">${value}</span>`;
        }
        return value;
    }

    /**
     * Parses and renders Jaiph with line wrappers for numbering.
     *
     * Args:
     *   raw: Full Jaiph source block.
     * Returns:
     *   HTML string containing .code-line rows.
     */
    function highlightJaiphWithParser(raw) {
        const ast = parseJaiph(raw);
        return ast
            .map(function (lineNode) {
                const html = lineNode.tokens.map(renderJaiphToken).join("");
                return `<span class="code-line">${html || "&nbsp;"}</span>`;
            })
            .join("");
    }

    function highlightBashFragment(fragment) {
        let code = escapeHTML(fragment);
        const stringTokens = [];
        code = code.replace(/"([^"\\]|\\.)*"|'([^'\\]|\\.)*'/g, function (match) {
            const token = `___BSTR_${stringTokens.length}___`;
            stringTokens.push(match);
            return token;
        });

        code = code.replace(
            /\b(set|source|if|then|fi|local|return|export|function)\b/g,
            '<span class="ralph-keyword">$1</span>'
        );
        code = code.replace(
            /\$[A-Za-z_][A-Za-z0-9_]*/g,
            '<span class="ralph-identifier">$&</span>'
        );

        code = code.replace(/___BSTR_(\d+)___/g, function (_, idx) {
            return `<span class="ralph-string">${stringTokens[Number(idx)]}</span>`;
        });

        return code;
    }

    function highlightBashWithParser(raw) {
        return raw
            .split("\n")
            .map(function (line) {
                const trimmed = line.trim();
                if (!trimmed) {
                    return '<span class="code-line">&nbsp;</span>';
                }
                if (trimmed.startsWith("#")) {
                    return `<span class="code-line"><span class="ralph-comment">${escapeHTML(line)}</span></span>`;
                }
                const fnDeclMatch = line.match(/^(\s*)([A-Za-z_][A-Za-z0-9_]*)(\(\)\s*\{.*)$/);
                if (fnDeclMatch) {
                    const rendered =
                        escapeHTML(fnDeclMatch[1]) +
                        `<span class="ralph-definition">${fnDeclMatch[2]}</span>` +
                        highlightBashFragment(fnDeclMatch[3]);
                    return `<span class="code-line">${rendered}</span>`;
                }
                return `<span class="code-line">${highlightBashFragment(line)}</span>`;
            })
            .join("");
    }

    /**
     * Applies highlighting and line numbers to all pre/code blocks.
     *
     * Args:
     *   None.
     * Returns:
     *   None.
     */
    function highlightAll() {
        document.querySelectorAll("pre code").forEach(block => {
            if (block.matches(".jaiph-run")) {
                block.dataset.copySource = block.textContent;
                const html = block.innerHTML;
                block.innerHTML = html
                    .split("\n")
                    .map(function (line) {
                        return `<span class="code-line">${line || "&nbsp;"}</span>`;
                    })
                    .join("");
                return;
            }
            const raw = block.textContent;
            block.dataset.copySource = raw;
            const isJaiphBlock = block.matches(".language-ralph, .language-jaiph, .language-jh");
            const isBashBlock = block.matches(".language-bash");
            const rendered = isJaiphBlock
                ? highlightJaiphWithParser(raw)
                : isBashBlock
                    ? highlightBashWithParser(raw)
                    : raw
                        .split("\n")
                        .map(function (line) {
                            return `<span class="code-line">${escapeHTML(line) || "&nbsp;"}</span>`;
                        })
                        .join("");
            block.innerHTML = rendered;
        });
    }

    function legacyCopyText(text) {
        const textArea = document.createElement("textarea");
        textArea.value = text;
        textArea.setAttribute("readonly", "");
        textArea.style.position = "fixed";
        textArea.style.top = "-9999px";
        textArea.style.left = "-9999px";
        document.body.appendChild(textArea);
        textArea.focus();
        textArea.select();
        let copied = false;
        try {
            copied = document.execCommand("copy");
        } catch (_) {
            copied = false;
        }
        document.body.removeChild(textArea);
        return copied;
    }

    async function writeTextToClipboard(text) {
        if (
            window.isSecureContext &&
            navigator.clipboard &&
            typeof navigator.clipboard.writeText === "function"
        ) {
            await navigator.clipboard.writeText(text);
            return true;
        }
        return legacyCopyText(text);
    }

    async function copyCodeFromBlock(button, block) {
        const originalLabel = button.textContent;
        const copySource = block.dataset.copySource != null ? block.dataset.copySource : (block.textContent || "");
        try {
            const copied = await writeTextToClipboard(copySource);
            button.textContent = copied ? "Copied!" : "Copy failed";
        } catch (error) {
            button.textContent = legacyCopyText(copySource) ? "Copied!" : "Copy failed";
        }
        window.setTimeout(function () {
            button.textContent = originalLabel;
        }, 1400);
    }

    function attachCopyButtons() {
        document.querySelectorAll("pre").forEach(function (pre) {
            const block = pre.querySelector("code");
            if (!block || block.matches(".jaiph-run")) {
                return;
            }
            let wrapper = pre.parentElement;
            if (!wrapper || !wrapper.classList.contains("code-block-wrap")) {
                wrapper = document.createElement("div");
                wrapper.className = "code-block-wrap";
                pre.parentNode.insertBefore(wrapper, pre);
                wrapper.appendChild(pre);
            }
            if (wrapper.querySelector(".copy-code-button")) {
                return;
            }
            const button = document.createElement("button");
            button.type = "button";
            button.className = "copy-code-button";
            button.textContent = "Copy";
            button.addEventListener("click", function () {
                copyCodeFromBlock(button, block);
            });
            wrapper.appendChild(button);
        });
    }

    function attachCodeTabs() {
        const buttons = document.querySelectorAll(".code-tab-button");
        buttons.forEach(function (button) {
            button.addEventListener("click", function () {
                const target = button.getAttribute("data-target");
                if (!target) {
                    return;
                }

                document.querySelectorAll(".code-tab-button").forEach(function (btn) {
                    btn.classList.toggle("is-active", btn === button);
                });

                document.querySelectorAll(".code-tab-panel").forEach(function (panel) {
                    panel.classList.toggle("is-active", panel.getAttribute("data-panel") === target);
                });
            });
        });
    }

    /**
     * Restructures doc-sections content so that:
     * - h1 stays unwrapped; any content below it until the first h2 is wrapped in a .card.
     * - Each h2 sits outside a .card, with its section content inside.
     */
    function restructureDocSections() {
        var container = document.querySelector(".doc-sections");
        if (!container) {
            return;
        }

        var children = Array.prototype.slice.call(container.childNodes);
        var fragment = document.createDocumentFragment();

        var heroNodes = [];
        var currentCard = null;
        var inHero = true;

        for (var i = 0; i < children.length; i++) {
            var child = children[i];

            if (child.nodeType === 1 && child.tagName === "H2") {
                inHero = false;
                if (currentCard) {
                    fragment.appendChild(currentCard);
                }
                fragment.appendChild(child);
                currentCard = document.createElement("div");
                currentCard.className = "card";
            } else if (inHero) {
                heroNodes.push(child);
            } else {
                if (!currentCard) {
                    currentCard = document.createElement("div");
                    currentCard.className = "card";
                }
                currentCard.appendChild(child);
            }
        }

        if (currentCard) {
            fragment.appendChild(currentCard);
        }

        container.innerHTML = "";
        if (heroNodes.length > 0) {
            var heroH1 = null;
            for (var h = 0; h < heroNodes.length; h++) {
                if (heroNodes[h].nodeType === 1 && heroNodes[h].tagName === "H1") {
                    heroH1 = heroNodes[h];
                    break;
                }
            }
            if (heroH1) {
                container.appendChild(heroH1);
            }
            var rest = [];
            for (var r = 0; r < heroNodes.length; r++) {
                if (heroNodes[r] !== heroH1) {
                    rest.push(heroNodes[r]);
                }
            }
            if (rest.length > 0) {
                var heroCard = document.createElement("div");
                heroCard.className = "card";
                for (var j = 0; j < rest.length; j++) {
                    heroCard.appendChild(rest[j]);
                }
                container.appendChild(heroCard);
            }
        }
        container.appendChild(fragment);
    }

    /**
     * Wraps each table in .doc-sections (and .doc-content) in a scroll container
     * so wide tables don't expand the card on mobile.
     */
    function wrapTablesInScrollContainer() {
        var containers = document.querySelectorAll(".doc-sections .card, .doc-content");
        containers.forEach(function (container) {
            if (!container) {
                return;
            }
            var tables = container.querySelectorAll(":scope > table");
            tables.forEach(function (table) {
                if (table.parentElement.classList.contains("table-scroll")) {
                    return;
                }
                var wrapper = document.createElement("div");
                wrapper.className = "table-scroll";
                table.parentNode.insertBefore(wrapper, table);
                wrapper.appendChild(table);
            });
        });
    }

    // Auto-run on DOM ready
    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", function () {
            restructureDocSections();
            wrapTablesInScrollContainer();
            highlightAll();
            attachCopyButtons();
            attachCodeTabs();
        });
    } else {
        restructureDocSections();
        wrapTablesInScrollContainer();
        highlightAll();
        attachCopyButtons();
        attachCodeTabs();
    }

})();
