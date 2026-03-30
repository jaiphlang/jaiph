import { test, expect } from '@playwright/test';
import { chmodSync, copyFileSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, delimiter } from 'path';
import { spawnSync } from 'child_process';

const ROOT = join(__dirname, '../..');
const EXAMPLES = join(ROOT, 'examples');
/** Prefer repo jaiph so shebang `#!/usr/bin/env jaiph` resolves in tests. */
const JAIPH_BIN_DIR = join(ROOT, 'node_modules', '.bin');

function withJaiphOnPath(): NodeJS.ProcessEnv {
  const p = process.env.PATH ?? '';
  return { ...process.env, PATH: `${JAIPH_BIN_DIR}${delimiter}${p}` };
}

/** Strip trailing whitespace per line for source written to disk. */
function normalizeSource(text: string): string {
  return text
    .split('\n')
    .map((l: string) => l.trimEnd())
    .join('\n')
    .trim();
}

/** Strip ANSI (CSI sequences). */
function stripAnsi(text: string): string {
  return text.replace(/\x1B\[[0-9;]*[A-Za-z]/g, '');
}

/**
 * Mirrors e2e/lib/common.sh e2e::normalize_output, plus log path placeholders
 * so failure output matches the landing page (which uses &lt;path&gt;).
 */
function normalize(text: string): string {
  const lines = stripAnsi(text)
    .replace(/\u00a0/g, ' ')
    .split('\n')
    .map((l) => l.trimEnd());
  return lines
    .join('\n')
    .replace(/\((\d+(\.\d+)?s|\d+m \d+s)\)/g, '(<time>)')
    .replace(/\((\d+(\.\d+)?s|\d+m \d+s) failed\)/g, '(<time> failed)')
    .replace(/✓ \d+(\.\d+)?s/g, '✓ <time>')
    .replace(/✗ \d+(\.\d+)?s/g, '✗ <time>')
    .replace(/✗ (.*) (\d+)(\.\d+)?s$/gm, '✗ $1 <time>')
    .replace(/^( *)(cursor-agent|printf %s) .*$/gm, '$1<agent-command>')
    .replace(/\(1="\/[^"]*"/g, '(1="<script-path>"')
    .replace(/^  Logs: .+$/gm, '  Logs: <path>')
    .replace(/^  Summary: .+$/gm, '  Summary: <path>')
    .replace(/^    out: .+$/gm, '    out: <path>')
    .replace(/^    err: .+$/gm, '    err: <path>')
    .replace(/expectEqual failed: \d+(\.\d+)?s/g, 'expectEqual failed: <time>')
    .replace(/[ \t]+$/gm, '')
    .trim();
}

/** Remove the first line (➜ command) from a sample output block. */
function stripRunCommandLine(text: string): string {
  return text.replace(/^➜ [^\n]*\n/, '');
}

function parseRunCommand(rawBlock: string): { rel: string; args: string[] } | null {
  const first = rawBlock.split('\n').find((l) => l.trim().length > 0) ?? '';
  const m = first.match(/^➜\s+(.+)$/);
  if (!m) return null;
  const tokens = m[1].trim().split(/\s+/);
  const rel = tokens[0]!;
  const args = tokens.slice(1);
  return { rel, args };
}

function resolveInTmp(tmpRoot: string, rel: string): string {
  const r = rel.replace(/^\.\//, '');
  return join(tmpRoot, r);
}

/** Run an executable .jh in tmpRoot (shebang → jaiph). */
function runScript(tmpRoot: string, rel: string, args: string[]): { combined: string; status: number | null } {
  const exe = resolveInTmp(tmpRoot, rel);
  const r = spawnSync(exe, args, {
    cwd: tmpRoot,
    encoding: 'utf-8',
    env: withJaiphOnPath(),
  });
  const combined = (r.stdout ?? '') + (r.stderr ?? '');
  return { combined, status: r.status };
}

/** Outputs that depend on LLMs or agents — page text is illustrative only. */
const SKIP_OUTPUT: Record<string, Set<string>> = {
  'say-hello': new Set(['success']),
  'ensure-ci-passes': new Set(['run']),
  async: new Set(['run']),
};

test.describe('landing page samples', () => {
  test('each tab: source from page runs and output matches (normalized)', async ({ page }) => {
    await page.goto('/#samples');
    /* #samples is on the h2; panels are siblings under the section, not inside the heading */
    const panels = page.locator('.code-tab-panel[data-sample-file]');
    const n = await panels.count();
    expect(n).toBeGreaterThanOrEqual(1);

    for (let i = 0; i < n; i++) {
      const panel = panels.nth(i);
      const sampleId = (await panel.getAttribute('data-sample')) ?? '';
      const file = (await panel.getAttribute('data-sample-file')) ?? '';
      const dataPanel = await panel.getAttribute('data-panel');
      expect(dataPanel).toBeTruthy();

      await page.locator(`[data-target="${dataPanel}"]`).click();

      const sourceEl = panel.locator('[data-sample-source]');
      if ((await sourceEl.count()) === 0) continue;

      const pageSource = normalizeSource(await sourceEl.innerText());
      const tmpRoot = mkdtempSync(join(tmpdir(), 'jaiph-lp-'));
      try {
        writeFileSync(join(tmpRoot, file), pageSource, 'utf-8');
        chmodSync(join(tmpRoot, file), 0o755);

        if (file === 'say_hello.test.jh') {
          copyFileSync(join(EXAMPLES, 'say_hello.jh'), join(tmpRoot, 'say_hello.jh'));
          chmodSync(join(tmpRoot, 'say_hello.jh'), 0o755);
        }

        const outputs = panel.locator('[data-sample-output]');
        const outCount = await outputs.count();
        for (let j = 0; j < outCount; j++) {
          const outEl = outputs.nth(j);
          const key = (await outEl.getAttribute('data-sample-output')) ?? '';
          if (SKIP_OUTPUT[sampleId]?.has(key)) continue;

          const raw = await outEl.innerText();
          const parsed = parseRunCommand(raw);
          expect(parsed, `${sampleId} output "${key}": missing ➜ command line`).not.toBeNull();

          const { combined } = runScript(tmpRoot, parsed!.rel, parsed!.args);
          const actual = normalize(combined);
          const expected = normalize(stripRunCommandLine(raw));

          expect(actual, `${sampleId} / ${key}`).toBe(expected);
        }
      } finally {
        rmSync(tmpRoot, { recursive: true, force: true });
      }
    }
  });
});
