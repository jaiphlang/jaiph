import { test, expect } from '@playwright/test';
import { chmodSync, copyFileSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { delimiter, join } from 'path';
import { spawnSync } from 'child_process';
import { LOCAL_DOCS_SITE } from './docs-site';

const ROOT = join(__dirname, '../..');
const EXAMPLES = join(ROOT, 'examples');

/** Repo root for local install (CI sets GITHUB_WORKSPACE). */
const JAIPH_REPO_ROOT = process.env.GITHUB_WORKSPACE || ROOT;

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
    .map((l: string) => l.trimEnd());
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
    /** Collapse multiple blank lines before ✓ PASS (TTY vs non-TTY spacing). */
    .replace(/\n\n+(?=✓ PASS)/g, '\n')
    .replace(/[ \t]+$/gm, '')
    .trim();
}

/** Try it out: isolate workflow run block; only ℹ is non-deterministic. */
function normalizeTryItOutForAssert(combined: string): string {
  const n = normalize(combined);
  const idx = n.indexOf('workflow default');
  const fromWorkflow = idx >= 0 ? n.slice(idx) : n;
  return fromWorkflow.replace(/^  ℹ .+$/gm, '  ℹ <model-response>').trim();
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

/** Run an executable .jh in tmpRoot (shebang → jaiph). Prefer ~/.local/bin after Try it out install. */
function runScript(tmpRoot: string, rel: string, args: string[]): { combined: string; status: number | null } {
  const exe = resolveInTmp(tmpRoot, rel);
  const home = process.env.HOME ?? process.env.USERPROFILE ?? '';
  const env = { ...process.env };
  if (home) {
    env.PATH = `${join(home, '.local', 'bin')}${delimiter}${env.PATH ?? ''}`;
  }
  const r = spawnSync(exe, args, { cwd: tmpRoot, encoding: 'utf-8', env });
  const combined = (r.stdout ?? '') + (r.stderr ?? '');
  return { combined, status: r.status };
}

/** Outputs that depend on LLMs or agents — cannot match page text deterministically. */
const SKIP_OUTPUT: Record<string, Set<string>> = {
  'say-hello': new Set(['success']),
  'ensure-ci-passes': new Set(['run']),
  async: new Set(['run']),
};

test.describe.serial('docs landing page', () => {
  test.describe('Try it out', () => {
    test('run script from page (localhost) installs Jaiph and workflow output matches', async ({ page }) => {
      test.setTimeout(600_000);

      await page.goto('/');

      const codeEl = page.locator('section.try-it-out [data-panel="try-run-sample"] pre code');
      await expect(codeEl).toBeVisible();
      let script = (await codeEl.innerText()).trim();
      script = script.replace(/https:\/\/jaiph\.org/g, LOCAL_DOCS_SITE);
      console.log('script', script);

      // docs/run uses JAIPH_SITE for the *inner* curl …/install (defaults to jaiph.org if unset).
      // Replacing the outer URL only is not enough — without this, CI would fetch production install.
      const r = spawnSync('bash', ['-c', script], {
        encoding: 'utf-8',
        env: {
          ...process.env,
          JAIPH_REPO_URL: JAIPH_REPO_ROOT,
          JAIPH_SITE: LOCAL_DOCS_SITE,
        },
        maxBuffer: 50 * 1024 * 1024,
        timeout: 600_000,
      });
      const combined = (r.stdout ?? '') + (r.stderr ?? '');
      expect(r.status, combined.slice(0, 4000)).toBe(0);

      const actual = normalizeTryItOutForAssert(combined);
      const expected = normalizeTryItOutForAssert(
        [
          'workflow default',
          '  ▸ prompt cursor "Say: Hello, I am [model ..."',
          '  ✓ prompt cursor (<time>)',
          '  ℹ Hello, I am Composer!',
          '✓ PASS workflow default (<time>)',
        ].join('\n'),
      );
      console.log('actual', actual);
      console.log('expected', expected);
      expect(actual, combined.slice(-4000)).toBe(expected);
    });
  });

  test.describe('landing page samples', () => {
    test('each tab: source from page runs and output matches (normalized)', async ({ page }) => {
      await page.goto('/#samples');
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
          expect(outCount, `${sampleId}: expected at least one [data-sample-output] block on the page`).toBeGreaterThan(
            0,
          );

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
            console.log('actual', actual);
            console.log('expected', expected);

            expect(actual, `${sampleId} / ${key}`).toBe(expected);
          }
        } finally {
          rmSync(tmpRoot, { recursive: true, force: true });
        }
      }
    });
  });
});
