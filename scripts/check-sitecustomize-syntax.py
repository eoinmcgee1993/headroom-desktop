#!/usr/bin/env python3
"""Syntax-check the Python we inject into the managed runtime.

`SITECUSTOMIZE_PY` in tool_manager.rs is ~2,300 lines of Python stored as a Rust
raw string. Nothing in the Rust build looks inside it, and every functional test
that exercises it (`*_behaves_against_the_installed_wheel`) opens with
`if !python.exists() { return; }` -- true on every CI runner except test-macos's
wheel step, so everywhere else they report green without executing a line of it.
This check is the fast, runtime-free half; the wheel step is the functional one.

A syntax error therefore ships: the file writes fine, the interpreter fails the
sitecustomize import, and all eleven vendored patches go inert with no error
anyone sees. That is the exact silent-inertness failure the wheel-bump rules in
CLAUDE.md keep warning about, so it gets a gate that runs with no runtime
installed.

Compiles rather than just parses, so a `return` outside a function or another
bytecode-stage error is caught too.
"""

import ast
import pathlib
import sys

SOURCE = pathlib.Path(__file__).resolve().parent.parent / "src-tauri" / "src" / "tool_manager.rs"
OPEN = 'const SITECUSTOMIZE_PY: &str = r#"'
CLOSE = '"#;'


def extract(rust: str) -> str:
    start = rust.find(OPEN)
    if start < 0:
        sys.exit(f"check-sitecustomize: {OPEN!r} not found in {SOURCE} (was it renamed?)")
    start += len(OPEN)
    end = rust.find(CLOSE, start)
    if end < 0:
        sys.exit("check-sitecustomize: unterminated raw string for SITECUSTOMIZE_PY")
    return rust[start:end]


def main() -> None:
    payload = extract(SOURCE.read_text(encoding="utf-8"))
    try:
        compile(ast.parse(payload, filename="sitecustomize.py"), "sitecustomize.py", "exec")
    except SyntaxError as err:
        line = payload.split("\n")[err.lineno - 1] if err.lineno else ""
        sys.exit(
            f"check-sitecustomize: SITECUSTOMIZE_PY is not valid Python\n"
            f"  {err.msg} at sitecustomize.py:{err.lineno}:{err.offset}\n"
            f"  {line.strip()}"
        )
    print(f"check-sitecustomize: SITECUSTOMIZE_PY compiles ({payload.count(chr(10))} lines)")


if __name__ == "__main__":
    main()
