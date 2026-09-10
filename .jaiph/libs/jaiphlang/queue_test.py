#!/usr/bin/env python3
"""Fixture tests for queue.py state + views. Run from any cwd."""
import os, subprocess, sys, tempfile, textwrap

HERE = os.path.dirname(os.path.abspath(__file__))
_LOCAL = os.path.join(HERE, "queue.py")
_WS = os.path.join(os.environ.get("JAIPH_WORKSPACE", "."), ".jaiph", "libs", "jaiphlang", "queue.py")
QUEUE_PY = _LOCAL if os.path.isfile(_LOCAL) else _WS


def run_cmd(env, *args):
    r = subprocess.run(
        [sys.executable, QUEUE_PY, *args],
        cwd=env["JAIPH_WORKSPACE"],
        env={**os.environ, **env},
        capture_output=True,
        text=True,
    )
    return r


def main():
    with tempfile.TemporaryDirectory() as tmp:
        ws = os.path.join(tmp, "ws")
        os.makedirs(os.path.join(ws, ".jaiph"))
        state = os.path.join(tmp, "hidden", "queue-state.md")
        os.makedirs(os.path.dirname(state))
        env = {"JAIPH_WORKSPACE": ws, "JAIPH_QUEUE_STATE": state}

        qview = os.path.join(ws, "QUEUE.md")
        with open(qview, "w", encoding="utf-8") as f:
            f.write(textwrap.dedent("""\
                # Old preamble

                ## First #dev-ready

                Do the first thing.

                ## Second #dev-ready

                Do the second thing.
                """))

        r = run_cmd(env, "get_available")
        assert r.returncode == 0, r.stderr
        assert "First" in r.stdout
        assert os.path.isfile(state), "bootstrap must write state"

        r = run_cmd(env, "mark", "First", "in-progress")
        assert r.returncode == 0, r.stderr

        r = run_cmd(env, "get_available")
        assert r.returncode == 0, r.stderr
        assert "Second" in r.stdout
        assert "First" not in r.stdout.split("\n")[0]

        with open(qview, "w", encoding="utf-8") as f:
            f.write("# corrupted by agent\n")

        r = run_cmd(env, "get_by_header", "First")
        assert r.returncode == 0, r.stderr
        assert "Do the first thing" in r.stdout

        notes = os.path.join(tmp, "notes.md")
        with open(notes, "w", encoding="utf-8") as f:
            f.write("looks good")
        r = run_cmd(env, "archive_to_done", "First", notes)
        assert r.returncode == 0, r.stderr

        r = run_cmd(env, "get_by_header", "First")
        assert r.returncode != 0

        done = open(os.path.join(ws, "DONE.md"), encoding="utf-8").read()
        assert "First" in done
        assert "looks good" in done
        assert "corrupted by agent" not in open(qview, encoding="utf-8").read()
        assert "Second" in open(qview, encoding="utf-8").read()

        addf = os.path.join(tmp, "add.md")
        with open(addf, "w", encoding="utf-8") as f:
            f.write("## Third\n\nNo ready tag.\n")
        r = run_cmd(env, "add", addf)
        assert r.returncode == 0, r.stderr
        r = run_cmd(env, "get_by_header", "Third")
        assert r.returncode == 0
        assert "#dev-ready" not in r.stdout.split("\n")[0]

        r = run_cmd(env, "archive_to_done", "Second")
        assert r.returncode == 0
        done2 = open(os.path.join(ws, "DONE.md"), encoding="utf-8").read()
        assert "First" in done2 and "Second" in done2

        r = run_cmd(env, "unmark", "Third", "in-progress")
        assert r.returncode == 0, r.stderr

        other_state = os.path.join(tmp, "other-state.md")
        env2 = {**env, "JAIPH_QUEUE_STATE": other_state}
        with open(os.path.join(ws, "QUEUE.md"), "w", encoding="utf-8") as f:
            f.write("## OnlyInOverride #dev-ready\n\nbody\n")
        # Override path is empty: bootstrap from current QUEUE.md view.
        r = run_cmd(env2, "get_available")
        assert r.returncode == 0, r.stderr
        assert "OnlyInOverride" in r.stdout

    print("queue_test.py: ok")


if __name__ == "__main__":
    try:
        main()
    except Exception:
        import traceback
        traceback.print_exc()
        sys.exit(1)
