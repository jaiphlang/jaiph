/**
 * Subprocess execution for managed Jaiph steps (script / workflow / rule).
 * Invoked from jaiph::run_step (steps.sh); tracking, stack, and STEP_* events stay in Bash.
 */
import { spawnSync } from "node:child_process";
import { closeSync, existsSync, fstatSync, openSync, writeFileSync } from "node:fs";

const MAX_BUFFER = 256 * 1024 * 1024;
const MAX_DISPATCH_DEPTH = 200;

/**
 * Node only wires stdio 0–2 unless we extend the array. Nested managed-step children must keep the
 * same __JAIPH_EVENT__ fd as the parent (see jaiph::event_fd: 3 when open, else 2). Without passing
 * it through, child events fall back to stderr — redirected here to step .err files — so events
 * only reach the CLI when the step ends.
 *
 * We read the fd number from the parent shell (env) and refuse to duplicate if it equals an
 * already-mapped capture fd; otherwise `openSync` could occupy fd 3 and `fstatSync(3)` would lie.
 */
function stdioWithJaiphEventFd(
  stdin: "inherit" | "ignore",
  stdout: number | "pipe",
  stderr: number,
): Array<"inherit" | "ignore" | "pipe" | number> {
  const io: Array<"inherit" | "ignore" | "pipe" | number> = [stdin, stdout, stderr];
  const raw = process.env.JAIPH_RUN_STEP_KERNEL_EXTRA_FD;
  if (raw === undefined || raw === "") return io;
  const fd = Number(raw);
  if (fd !== 2 && fd !== 3) return io;
  if (fd === stdout || fd === stderr) return io;
  try {
    fstatSync(fd);
  } catch {
    return io;
  }
  io.push(fd);
  return io;
}

function isolatedScriptEnv(): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH ?? "",
    HOME: process.env.HOME ?? "",
    TERM: process.env.TERM ?? "",
    USER: process.env.USER ?? "",
    JAIPH_LIB: process.env.JAIPH_LIB ?? "",
    JAIPH_SCRIPTS: process.env.JAIPH_SCRIPTS ?? "",
    JAIPH_WORKSPACE: process.env.JAIPH_WORKSPACE ?? "",
  };
}

function runScriptCapture(exe: string, args: string[], outPath: string, errPath: string): number {
  const outFd = openSync(outPath, "w");
  const errFd = openSync(errPath, "w");
  const r = spawnSync(exe, args, {
    stdio: ["ignore", outFd, errFd],
    env: isolatedScriptEnv(),
    cwd: process.cwd(),
    maxBuffer: MAX_BUFFER,
  });
  closeSync(outFd);
  closeSync(errFd);
  if (r.error) {
    process.stderr.write(`jaiph run-step-exec: ${r.error.message}\n`);
    return 1;
  }
  return r.status ?? 1;
}

function runScriptTee(exe: string, args: string[], outPath: string, errPath: string): number {
  const errFd = openSync(errPath, "w");
  const r = spawnSync(exe, args, {
    stdio: ["ignore", "pipe", errFd],
    env: isolatedScriptEnv(),
    cwd: process.cwd(),
    maxBuffer: MAX_BUFFER,
  });
  closeSync(errFd);
  if (r.error) {
    process.stderr.write(`jaiph run-step-exec: ${r.error.message}\n`);
    return 1;
  }
  const buf = r.stdout ?? Buffer.alloc(0);
  process.stdout.write(buf);
  writeFileSync(outPath, buf);
  return r.status ?? 1;
}

function runModuleDispatchCommand(cmdArgs: string[], outPath: string, errPath: string, useTee: boolean): number {
  const mod = process.env.JAIPH_RUN_STEP_MODULE;
  if (!mod || !existsSync(mod)) {
    process.stderr.write("jaiph run-step-exec: JAIPH_RUN_STEP_MODULE must name an existing workflow module\n");
    return 1;
  }
  const rawDepth = process.env.JAIPH_RUN_STEP_DISPATCH_DEPTH;
  const depth = rawDepth && /^\d+$/.test(rawDepth) ? parseInt(rawDepth, 10) : 0;
  if (depth >= MAX_DISPATCH_DEPTH) {
    process.stderr.write(
      `jaiph run-step-exec: dispatch depth exceeded ${MAX_DISPATCH_DEPTH} (possible recursive module dispatch)\n`,
    );
    return 1;
  }
  const childEnv: NodeJS.ProcessEnv = {
    ...process.env,
    JAIPH_RUN_STEP_DISPATCH_DEPTH: String(depth + 1),
  };
  const argv = ["__jaiph_dispatch", ...cmdArgs];
  if (useTee) {
    const errFd = openSync(errPath, "w");
    const r = spawnSync(mod, argv, {
      stdio: stdioWithJaiphEventFd("inherit", "pipe", errFd),
      env: childEnv,
      cwd: process.cwd(),
      maxBuffer: MAX_BUFFER,
    });
    closeSync(errFd);
    if (r.error) {
      process.stderr.write(`jaiph run-step-exec: ${r.error.message}\n`);
      return 1;
    }
    const buf = r.stdout ?? Buffer.alloc(0);
    process.stdout.write(buf);
    writeFileSync(outPath, buf);
    return r.status ?? 1;
  }
  const outFd = openSync(outPath, "w");
  const errFd = openSync(errPath, "w");
  const r = spawnSync(mod, argv, {
    stdio: stdioWithJaiphEventFd("inherit", outFd, errFd),
    env: childEnv,
    cwd: process.cwd(),
    maxBuffer: MAX_BUFFER,
  });
  closeSync(outFd);
  closeSync(errFd);
  if (r.error) {
    process.stderr.write(`jaiph run-step-exec: ${r.error.message}\n`);
    return 1;
  }
  return r.status ?? 1;
}

function main(): number {
  const funcName = process.argv[2];
  const stepKind = process.argv[3];
  const cmdArgs = process.argv.slice(4);
  const outTmp = process.env.JAIPH_RUN_STEP_OUT_TMP;
  const errTmp = process.env.JAIPH_RUN_STEP_ERR_TMP;
  if (!funcName || !stepKind) {
    process.stderr.write("jaiph run-step-exec: missing func_name or step_kind\n");
    return 1;
  }
  if (!outTmp || !errTmp) {
    process.stderr.write("jaiph run-step-exec: JAIPH_RUN_STEP_OUT_TMP and JAIPH_RUN_STEP_ERR_TMP required\n");
    return 1;
  }
  if (cmdArgs.length === 0) {
    process.stderr.write("jaiph run-step-exec: missing command argv\n");
    return 1;
  }

  const useTee = process.env.JAIPH_RUN_STEP_USE_TEE === "1";
  if (stepKind === "script") {
    const exe = cmdArgs[0]!;
    const args = cmdArgs.slice(1);
    return useTee ? runScriptTee(exe, args, outTmp, errTmp) : runScriptCapture(exe, args, outTmp, errTmp);
  }
  if (stepKind === "workflow" || stepKind === "rule") {
    return runModuleDispatchCommand(cmdArgs, outTmp, errTmp, useTee);
  }

  process.stderr.write(`jaiph run-step-exec: unsupported step_kind ${stepKind}\n`);
  return 1;
}

process.exit(main());
