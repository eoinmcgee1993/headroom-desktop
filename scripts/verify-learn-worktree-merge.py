#!/usr/bin/env python3
"""Probe the learn worktree-merge vendor against the INSTALLED wheel.

Builds a throwaway repo with one linked worktree and fake Claude Code session
folders, then asks the wheel's learn plugin and traffic learner which project
each belongs to. With the vendor bound, the worktree is its repo; without it,
the worktree is a separate project.

Run with the desktop's sitecustomize on PYTHONPATH:

    PYTHONPATH=<pyinject> <managed python> scripts/verify-learn-worktree-merge.py

Prints one line: `only=<paths> both=<paths> scanned=<n> hit=<path> link=<path>`,
each path as `repo`/`wt`/`link`, e.g.
`only=repo both=repo scanned=2 hit=repo link=repo` when merged.
"""

from __future__ import annotations

import json
import re
import shutil
import tempfile
from pathlib import Path

from headroom.learn.plugins.claude import ClaudeCodePlugin
from headroom.memory.traffic_learner import (
    ExtractedPattern,
    PatternCategory,
    _project_for_pattern,
)

base = Path(tempfile.mkdtemp()).resolve()
try:
    main, wt = base / "repo", base / "ws" / "san-salvador"
    gitdir = main / ".git" / "worktrees" / "san-salvador"
    gitdir.mkdir(parents=True)
    (gitdir / "commondir").write_text("../..\n")
    wt.mkdir(parents=True)
    (wt / ".git").write_text(f"gitdir: {gitdir}\n")
    claude = base / "claude"
    label = {str(main): "repo", str(wt): "wt"}

    def session(cwd: Path, name: str) -> None:
        d = claude / "projects" / re.sub(r"[^A-Za-z0-9]", "-", str(cwd))
        d.mkdir(parents=True, exist_ok=True)
        call = {"type": "tool_use", "id": "t1", "name": "Bash", "input": {"command": "ls"}}
        result = {"type": "tool_result", "tool_use_id": "t1", "content": "ok"}
        lines = [
            {"type": "assistant", "cwd": str(cwd), "message": {"content": [call]}},
            {"type": "user", "cwd": str(cwd), "message": {"content": [result]}},
        ]
        (d / f"{name}.jsonl").write_text("\n".join(json.dumps(x) for x in lines) + "\n")

    def names(projects) -> str:
        return ",".join(sorted(label.get(str(p.project_path), "?") for p in projects))

    plugin = ClaudeCodePlugin(claude_dir=claude)
    # Conductor shape: only the worktree has sessions.
    session(wt, "a")
    only = names(plugin.discover_projects())
    session(main, "b")
    projects = plugin.discover_projects()
    scanned = sum(len(plugin.scan_project(p)) for p in projects if str(p.project_path) == str(main))
    pattern = ExtractedPattern(
        category=PatternCategory.PREFERENCE, content=f"edit {wt}/src/x.py", importance=0.5
    )
    hit = _project_for_pattern(pattern, projects)
    # The main checkout reached through a symlinked parent: the merged project
    # is keyed by the resolved root, so its own patterns need an alias too.
    link = base / "link"
    link.symlink_to(base, target_is_directory=True)
    label[str(link / "repo")] = "link"
    session(link / "repo", "c")
    linked = _project_for_pattern(
        ExtractedPattern(
            category=PatternCategory.PREFERENCE,
            content=f"edit {link / 'repo'}/src/y.py",
            importance=0.5,
        ),
        plugin.discover_projects(),
    )
    print(
        f"only={only} both={names(projects)} scanned={scanned} "
        f"hit={label.get(str(hit.project_path), '?') if hit else None} "
        f"link={label.get(str(linked.project_path), '?') if linked else None}"
    )
finally:
    shutil.rmtree(base, ignore_errors=True)
