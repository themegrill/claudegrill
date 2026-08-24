#!/usr/bin/env python3
"""
Ingest an existing Selenium / Robot Framework suite as a specification.

Why this is an extractor and not a converter
--------------------------------------------
The valuable content in a QA team's existing suite is not the code. It is the
inventory of journeys somebody decided were worth testing, the assertions that
define what "correct" means, the test data, and — most of all — the cases that
were added because a real bug got through once.

The code itself is mostly locators and framework plumbing, and locators are
precisely the part that must not be carried across: they are bound to Selenium's
strategies and to markup we do not own, which is the brittleness CONVENTIONS.md
rule 1 exists to prevent. A faithful mechanical port would faithfully reproduce
it.

So this reads a suite the way `ingest-docs.py` reads a documentation site: pull
out the intent, and let the specs be written fresh in house style against it.

Robot Framework is an unusually good source for this. Test case names are
sentences, `[Documentation]` states intent, `[Tags]` is already an area
taxonomy — which is exactly what the sweep needs to shard on — and keywords like
`Page Should Contain` are assertions in plain words.

Output
------
    .themegrill-qa/testcases/<area>.md     inventory + assertions per area
    .themegrill-qa/testcase-index.json     areas, counts, suggested area list

Usage
-----
    python3 scripts/ingest-testsuite.py ~/src/qa-automation --out .themegrill-qa
    python3 scripts/ingest-testsuite.py ~/src/qa-automation --area-from tags

Standard library only.
"""

import argparse
import json
import os
import re
import sys
from collections import OrderedDict, defaultdict

# ---------------------------------------------------------------- Robot parsing

SECTION_RE = re.compile(r"^\*+\s*(settings?|variables?|test\s*cases?|tasks?|keywords?)\s*\**",
                        re.I)
CELL_SPLIT = re.compile(r"\t+|[ ]{2,}")

# A step whose keyword asserts something. These become expected outcomes.
ASSERT_RE = re.compile(
    r"(should\b|^wait\s+until|^verify|^assert|^check\s|^confirm|"
    r"^element\s+text|^title\s+should|^location\s+should)", re.I)

# Locator strategies we deliberately do not carry over, but do report.
LOCATOR_RE = re.compile(r"\b(id|name|xpath|css|class|link|partial\s*link|tag|data)\s*[:=]\s*(\S.*)$",
                        re.I)
XPATH_RE = re.compile(r"(^|\s)(//|\(//)")


def parse_robot(path):
    """Parse one .robot / .resource file into test cases and keywords."""
    tests, keywords = [], []
    section = None
    current = None
    kw_current = None

    with open(path, encoding="utf-8", errors="replace") as fh:
        for raw in fh:
            line = raw.rstrip("\n")

            if not line.strip() or line.lstrip().startswith("#"):
                continue

            m = SECTION_RE.match(line.strip())
            if m:
                name = m.group(1).lower().replace(" ", "")
                section = ("tests" if name.startswith(("testcase", "task"))
                           else "keywords" if name.startswith("keyword")
                           else "other")
                current = kw_current = None
                continue

            if section not in ("tests", "keywords"):
                continue

            indented = line[0] in " \t"
            cells = [c.strip() for c in CELL_SPLIT.split(line.strip()) if c.strip()]
            if not cells:
                continue

            # A name starts at column zero.
            if not indented:
                entry = {"name": cells[0], "doc": "", "tags": [],
                         "steps": [], "assertions": [], "locators": [],
                         "source": path}
                if section == "tests":
                    tests.append(entry)
                    current = entry
                else:
                    keywords.append(entry)
                    kw_current = entry
                continue

            target = current if section == "tests" else kw_current
            if target is None:
                continue

            head = cells[0]

            # Continuation of the previous cell.
            if head == "...":
                if target["steps"]:
                    target["steps"][-1] += " " + " ".join(cells[1:])
                continue

            # [Documentation], [Tags], [Setup] ...
            if head.startswith("["):
                setting = head.strip("[]").lower()
                value = cells[1:]
                if setting == "documentation":
                    target["doc"] = " ".join(value)
                elif setting == "tags":
                    target["tags"] = [t for t in value if t]
                continue

            step = "    ".join(cells)
            target["steps"].append(step)

            if ASSERT_RE.search(head):
                target["assertions"].append(step)

            for cell in cells[1:]:
                if LOCATOR_RE.match(cell) or XPATH_RE.search(cell):
                    target["locators"].append(cell)

    return tests, keywords


# --------------------------------------------------------------- Python parsing

PY_TEST_RE = re.compile(r"^\s*def\s+(test_\w+)\s*\(", re.M)
PY_CLASS_RE = re.compile(r"^\s*class\s+(\w+)", re.M)
# The docstring sits after the signature, which may span lines and carry type
# hints, so anchor on the closing paren and colon rather than on the body start.
PY_DOC_RE = re.compile(r'\)\s*(?:->[^:]+?)?:\s*(?:[rubf]{0,2})("""|\'\'\')(.*?)\1', re.S)
PY_ASSERT_RE = re.compile(r"^\s*(assert\b.*|self\.assert\w+\(.*)$", re.M)
PY_LOCATOR_RE = re.compile(r"By\.(\w+)\s*,\s*([\"'])(.*?)\2")


def parse_python(path):
    """Extract test functions, docstrings, assertions and locators."""
    with open(path, encoding="utf-8", errors="replace") as fh:
        src = fh.read()

    tests = []
    matches = list(PY_TEST_RE.finditer(src))

    for i, m in enumerate(matches):
        body = src[m.end(): matches[i + 1].start() if i + 1 < len(matches) else len(src)]
        # Only look near the top: a triple-quoted string further down is a
        # comment on some later statement, not the test's own docstring.
        doc = PY_DOC_RE.search(body[:600])
        tests.append({
            "name": m.group(1).replace("test_", "").replace("_", " ").strip().capitalize(),
            "raw_name": m.group(1),
            "doc": " ".join(doc.group(2).split()) if doc else "",
            "tags": [],
            "steps": [],
            "assertions": [a.strip() for a in PY_ASSERT_RE.findall(body)][:12],
            "locators": [f"{s.lower()}={v}" for s, _, v in PY_LOCATOR_RE.findall(body)][:12],
            "source": path,
        })

    return tests, []


# ------------------------------------------------------------------------ areas

# Tags that say *when* a test runs, not *what* it covers. Never an area.
LIFECYCLE_TAGS = {"smoke", "regression", "sanity", "critical", "wip", "skip",
                  "slow", "fast", "flaky", "nightly", "ci", "manual",
                  "p1", "p2", "p3", "p0", "high", "medium", "low",
                  "validation", "security", "negative", "positive", "e2e", "ui", "api"}


def path_area(entry, root):
    """Area from the suite's own file organisation."""
    rel = os.path.relpath(entry["source"], root)
    parts = [p for p in rel.split(os.sep) if p not in (".", "")]

    if len(parts) > 1:
        return parts[-2].lower().replace("_", "-")

    stem = os.path.splitext(parts[-1])[0]
    return re.sub(r"^(test_?|tests_?)", "", stem).lower().replace("_", "-") or "uncategorised"


def area_of(entry, mode, root):
    """
    Work out which QA area a test belongs to.

    Path is the default, because directory structure is how people actually group
    tests by feature, whereas tag sets are usually a mix of feature names and
    cross-cutting facets. A tag like `validation` or `security` describes a facet
    of many features; treating it as an area splits one feature's coverage across
    several shards and leaves a shard that is a theme rather than a surface.

    `--area-from tags` is there for suites whose tags genuinely are feature names.
    The tag inventory printed at the end tells you which kind yours are.
    """
    if mode == "tags" and entry["tags"]:
        real = [t for t in entry["tags"] if t.lower() not in LIFECYCLE_TAGS]
        if real:
            return real[0].lower().replace("_", "-").replace(" ", "-")

    return path_area(entry, root)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("root", help="Directory holding the existing QA suite")
    ap.add_argument("--out", default=".themegrill-qa")
    ap.add_argument("--area-from", choices=["tags", "path"], default="path",
                    help="Where areas come from. Default 'path' uses the suite's own "
                         "directory structure. Use 'tags' only if your Robot tags are "
                         "feature names rather than facets — the tag inventory printed "
                         "at the end will tell you which they are.")
    a = ap.parse_args()

    if not os.path.isdir(a.root):
        sys.exit(f"not a directory: {a.root}")

    files = []
    for dirpath, dirnames, filenames in os.walk(a.root):
        dirnames[:] = [d for d in dirnames
                       if d not in {".git", "node_modules", "venv", ".venv",
                                    "__pycache__", "results", "output", "reports"}]
        for fn in filenames:
            if fn.endswith((".robot", ".resource")) or (
                    fn.endswith(".py") and ("test" in fn.lower() or "spec" in fn.lower())):
                files.append(os.path.join(dirpath, fn))

    if not files:
        sys.exit("found no .robot, .resource or test_*.py files under that path")

    print(f"scanning {len(files)} files under {a.root}\n")

    all_tests, all_keywords = [], []
    for path in sorted(files):
        try:
            if path.endswith((".robot", ".resource")):
                t, k = parse_robot(path)
            else:
                t, k = parse_python(path)
        except Exception as exc:                      # a malformed file is not fatal
            print(f"  ! could not parse {path}: {exc}", file=sys.stderr)
            continue
        all_tests.extend(t)
        all_keywords.extend(k)

    if not all_tests:
        sys.exit("parsed the files but found no test cases — check the paths")

    grouped = defaultdict(list)
    for t in all_tests:
        grouped[area_of(t, a.area_from, a.root)].append(t)
    grouped = OrderedDict(sorted(grouped.items(), key=lambda kv: -len(kv[1])))

    out_dir = os.path.join(a.out, "testcases")
    os.makedirs(out_dir, exist_ok=True)

    index = {"source": os.path.abspath(a.root), "areas": [],
             "suggested_areas": [], "shared_keywords": len(all_keywords),
             "totals": {}}

    for area, tests in grouped.items():
        documented = sum(1 for t in tests if t["doc"])
        assertions = [s for t in tests for s in t["assertions"]]
        locators = sorted({l for t in tests for l in t["locators"]})

        path = os.path.join(out_dir, f"{area}.md")
        with open(path, "w", encoding="utf-8") as f:
            f.write(f"# Existing QA coverage — {area}\n\n")
            f.write("<!-- Generated by ingest-testsuite.py. This is a SPECIFICATION,\n"
                    "     not code to port. It records what the QA team already decided\n"
                    "     is worth testing and what they consider correct. Write fresh\n"
                    "     Playwright specs against it, per CONVENTIONS.md. -->\n\n")
            f.write(f"{len(tests)} existing test cases · {documented} documented · "
                    f"{len(assertions)} assertions\n\n")

            if assertions:
                f.write("## What the existing suite asserts\n\n")
                f.write("_Each of these is a statement about correct behaviour, already "
                        "agreed by the QA team. Reuse the intent; do not reuse the "
                        "locators._\n\n")
                for s in list(dict.fromkeys(assertions))[:60]:
                    f.write(f"- `{s}`\n")
                f.write("\n---\n\n")

            f.write("## Test cases\n\n")
            for t in tests:
                f.write(f"### {t['name']}\n\n")
                if t["doc"]:
                    f.write(f"{t['doc']}\n\n")
                if t["tags"]:
                    f.write(f"Tags: {', '.join(t['tags'])}\n\n")
                f.write(f"Source: `{os.path.relpath(t['source'], a.root)}`\n\n")
                if t["steps"]:
                    f.write("Steps as written:\n\n```\n")
                    for s in t["steps"][:25]:
                        f.write(f"{s}\n")
                    f.write("```\n\n")

            if locators:
                f.write("---\n\n## Locators used — reference only, do not port\n\n")
                f.write("_Listed because a locator tells you which element mattered to "
                        "whoever wrote the test. The selector strategy itself is replaced: "
                        "owned data attributes for plugins, semantic roles for themes._\n\n")
                for l in locators[:40]:
                    f.write(f"- `{l}`\n")
                f.write("\n")

        index["areas"].append({
            "area": area, "file": os.path.relpath(path, a.out),
            "tests": len(tests), "documented": documented,
            "assertions": len(assertions), "locators": len(locators),
            "titles": [t["name"] for t in tests],
        })
        print(f"  {area:<26} {len(tests):>3} tests  {documented:>3} documented  "
              f"{len(assertions):>3} assertions")

    index["suggested_areas"] = [x["area"] for x in index["areas"]]
    index["totals"] = {
        "tests": sum(x["tests"] for x in index["areas"]),
        "documented": sum(x["documented"] for x in index["areas"]),
        "assertions": sum(x["assertions"] for x in index["areas"]),
    }

    # Tag inventory. Lets a human see whether their tags are feature names (worth
    # using as areas) or cross-cutting facets (not), rather than guessing.
    tag_counts = defaultdict(int)
    for t in all_tests:
        for tag in t["tags"]:
            tag_counts[tag.lower()] += 1

    index["tags"] = [
        {"tag": k, "tests": v, "looks_like": "facet" if k in LIFECYCLE_TAGS else "feature"}
        for k, v in sorted(tag_counts.items(), key=lambda kv: -kv[1])
    ]

    ipath = os.path.join(a.out, "testcase-index.json")
    with open(ipath, "w", encoding="utf-8") as f:
        json.dump(index, f, indent=2)

    t = index["totals"]
    print("\n" + "=" * 68)
    print(f"{t['tests']} test cases in {len(index['areas'])} areas → {out_dir}")
    print(f"{t['documented']} carry documentation · {t['assertions']} assertions extracted")
    if all_keywords:
        print(f"{len(all_keywords)} shared keywords found — these map to helpers in "
              f"packages/core, not to individual specs")
    undocumented = t["tests"] - t["documented"]
    if undocumented:
        print(f"\n{undocumented} test cases have no documentation. Their names are all "
              f"the intent\n we have for those, so the names carry more weight than usual.")
    if index["tags"]:
        print("\ntags found (areas came from file paths — switch with --area-from tags")
        print("if the 'feature' ones below are how you would rather shard):")
        for row in index["tags"][:14]:
            print(f"  {row['tag']:<22} {row['tests']:>3} tests   {row['looks_like']}")

    print(f"\nindex → {ipath}")
    print("\nareas_json for the sweep caller:")
    print(json.dumps(index["suggested_areas"]))


if __name__ == "__main__":
    try:
        main()
    except BrokenPipeError:
        # Someone piped us into `head`. Not an error.
        os._exit(0)
