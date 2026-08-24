#!/usr/bin/env python3
"""
Ingest a product's public documentation into the QA knowledge layer.

Why this exists
---------------
A knowledge file needs two kinds of thing. Structure — settings, options,
capabilities — is derivable from source. *Intent* — what a setting is supposed to
do, what the user is promised, what should happen after they click Save — is not
in the source at all. It is in the docs, written by people who know the product.

So the docs are the missing input. They give three things the source cannot:

  1. Expected outcomes, in the product owner's own words. "You will be redirected
     to the appropriate page" is an assertion an agent can check.
  2. Field, button and tab labels, plus admin menu paths. An agent drives the
     accessibility tree via getByLabel/getByRole, so labels are exactly the right
     granularity — more useful here than CSS selectors would be.
  3. An area decomposition. Doc sections are a human-authored breakdown of the
     product, which is precisely what the sweep needs to shard on.

Output
------
    .themegrill-qa/docs/<section>.md      one file per doc section
    .themegrill-qa/docs-index.json        sections, article counts, suggested areas

Usage
-----
    python3 scripts/ingest-docs.py https://docs.wpuserregistration.com/sitemap.xml
    python3 scripts/ingest-docs.py <sitemap-url> --section membership --limit 5
    python3 scripts/ingest-docs.py <sitemap-url> --out ../user-registration/.themegrill-qa

Only the standard library is required. Fetches are cached on disk, so re-running
is cheap and a partial run can be resumed.
"""

import argparse
import json
import os
import re
import sys
import time
import urllib.error
import urllib.request
from collections import OrderedDict, defaultdict
from html.parser import HTMLParser
from urllib.parse import urlparse

UA = "themegrill-qa-docs-ingest/1.0 (+internal QA tooling)"

# Below this, an article is flagged for review — but still included. A thin entry
# is a nuisance; a silently dropped one is a hole in coverage nobody notices.
MIN_ARTICLE_CHARS = 150

# Chrome, nav and boilerplate we never want in the extracted text.
DROP_TAGS = {"script", "style", "nav", "header", "footer", "aside",
             "noscript", "svg", "form", "button"}
BLOCK_TAGS = {"p", "div", "section", "article", "br", "tr", "ul", "ol",
              "table", "blockquote", "pre"}
HEADINGS = {"h1", "h2", "h3", "h4", "h5", "h6"}


class Extractor(HTMLParser):
    """Pull readable text out of an article page, keeping heading and list structure."""

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.parts = []
        self._drop_depth = 0
        self._heading = None
        self._in_li = False
        self.title = None

    def handle_starttag(self, tag, attrs):
        if tag in DROP_TAGS:
            self._drop_depth += 1
            return
        if self._drop_depth:
            return
        if tag in HEADINGS:
            self._heading = tag
            self.parts.append("\n\n" + "#" * int(tag[1]) + " ")
        elif tag == "li":
            self._in_li = True
            self.parts.append("\n- ")
        elif tag in BLOCK_TAGS:
            self.parts.append("\n")
        elif tag in ("strong", "b"):
            self.parts.append("**")
        elif tag == "code":
            self.parts.append("`")

    def handle_endtag(self, tag):
        if tag in DROP_TAGS:
            self._drop_depth = max(0, self._drop_depth - 1)
            return
        if self._drop_depth:
            return
        if tag in HEADINGS:
            self._heading = None
            self.parts.append("\n")
        elif tag == "li":
            self._in_li = False
        elif tag in ("strong", "b"):
            self.parts.append("**")
        elif tag == "code":
            self.parts.append("`")

    def handle_data(self, data):
        if self._drop_depth:
            return
        text = re.sub(r"[ \t\r\f\v]+", " ", data)
        if not text.strip():
            if self.parts and not self.parts[-1].endswith((" ", "\n")):
                self.parts.append(" ")
            return
        if self.title is None and self._heading == "h1":
            self.title = text.strip()
        self.parts.append(text)

    def text(self):
        raw = "".join(self.parts)
        raw = re.sub(r"\n{3,}", "\n\n", raw)
        raw = re.sub(r"[ \t]+\n", "\n", raw)
        raw = re.sub(r"\*\*\s*\*\*", "", raw)
        return raw.strip()


def fetch(url, cache_dir, delay=0.4, retries=2):
    """GET with an on-disk cache. Cache key is the URL path, so reruns are free."""
    key = re.sub(r"[^a-zA-Z0-9._-]", "_", urlparse(url).path.strip("/")) or "index"
    path = os.path.join(cache_dir, key + ".html")
    if os.path.exists(path) and os.path.getsize(path) > 0:
        with open(path, encoding="utf-8", errors="replace") as f:
            return f.read()

    last = None
    for attempt in range(retries + 1):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": UA})
            with urllib.request.urlopen(req, timeout=30) as r:
                body = r.read().decode("utf-8", errors="replace")
            os.makedirs(cache_dir, exist_ok=True)
            with open(path, "w", encoding="utf-8") as f:
                f.write(body)
            time.sleep(delay)          # be polite to your own docs server
            return body
        except (urllib.error.URLError, urllib.error.HTTPError, TimeoutError) as e:
            last = e
            time.sleep(1.5 * (attempt + 1))
    print(f"  ! fetch failed: {url} ({last})", file=sys.stderr)
    return None


def sitemap_urls(xml):
    """Extract <loc> values. Handles both plain sitemaps and sitemap indexes."""
    return re.findall(r"<loc>\s*([^<\s]+)\s*</loc>", xml)


def section_of(url):
    """First path segment is the doc section, which becomes a QA area."""
    parts = [p for p in urlparse(url).path.strip("/").split("/") if p]
    return parts[0] if parts else "root"


def slug_of(url):
    parts = [p for p in urlparse(url).path.strip("/").split("/") if p]
    return parts[-1] if len(parts) > 1 else "_index"


# Sentences that state an outcome are the ones worth surfacing to the agent,
# because each is a candidate assertion.
OUTCOME = re.compile(
    r"\b(will be|will then|you will|should (?:see|be|now)|is displayed|are displayed|"
    r"appears?|redirect(?:ed|s)? to|takes? you to|instead of|results? in|"
    r"is (?:created|saved|sent|applied|shown)|becomes?|receives?)\b", re.I)


def outcome_sentences(text, limit=12):
    out = []
    for s in re.split(r"(?<=[.!?])\s+", text):
        s = " ".join(s.split())
        if 25 <= len(s) <= 260 and OUTCOME.search(s):
            out.append(s)
        if len(out) >= limit:
            break
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("sitemap", help="URL of the docs sitemap.xml")
    ap.add_argument("--out", default=".themegrill-qa", help="output directory (default .themegrill-qa)")
    ap.add_argument("--section", action="append", help="limit to these sections")
    ap.add_argument("--limit", type=int, help="max articles per section")
    ap.add_argument("--delay", type=float, default=0.4, help="seconds between fetches")
    ap.add_argument("--cache", default=".themegrill-qa/.docs-cache")
    a = ap.parse_args()

    os.makedirs(a.cache, exist_ok=True)
    docs_dir = os.path.join(a.out, "docs")
    os.makedirs(docs_dir, exist_ok=True)

    print(f"sitemap  {a.sitemap}")
    xml = fetch(a.sitemap, a.cache, a.delay)
    if not xml:
        sys.exit("could not fetch the sitemap")

    urls = [u for u in sitemap_urls(xml) if not u.endswith(".xml")]
    if not urls:
        sys.exit("no <loc> entries found — is that really a sitemap?")

    grouped = defaultdict(list)
    for u in urls:
        grouped[section_of(u)].append(u)
    grouped = OrderedDict(sorted(grouped.items(), key=lambda kv: -len(kv[1])))

    print(f"found    {len(urls)} urls across {len(grouped)} sections\n")

    index = {"source": a.sitemap, "sections": [], "suggested_areas": []}

    for section, sec_urls in grouped.items():
        if a.section and section not in a.section:
            continue
        sec_urls = sorted(sec_urls)
        if a.limit:
            sec_urls = sec_urls[:a.limit]

        print(f"{section}  ({len(sec_urls)} urls)")
        articles, all_outcomes, failed, skipped = [], [], 0, []

        for u in sec_urls:
            html = fetch(u, a.cache, a.delay)
            if not html:
                failed += 1
                continue
            ex = Extractor()
            try:
                ex.feed(html)
            except Exception as e:                       # malformed markup
                print(f"  ! parse failed {u}: {e}", file=sys.stderr)
                failed += 1
                continue
            text = ex.text()

            # A section landing page carries only a link list, so it has nothing
            # to contribute. Anything else short is reported rather than dropped:
            # silently discarding a real article is far worse than including a
            # thin one, because nobody ever finds out it went missing.
            is_landing = slug_of(u) in ("_index", section) or \
                         urlparse(u).path.strip("/").rstrip("/").endswith(f"{section}/index.html")
            if is_landing:
                print(f"  · {'(section landing page, skipped)':<66} {len(text):>6}c")
                continue
            if len(text) < MIN_ARTICLE_CHARS:
                skipped.append({"url": u, "chars": len(text)})
                print(f"  ! THIN, review: {u}  ({len(text)}c) — included anyway",
                      file=sys.stderr)
            title = ex.title or slug_of(u).replace("-", " ").title()
            outs = outcome_sentences(text)
            all_outcomes.extend(outs)
            articles.append({"title": title, "url": u, "slug": slug_of(u),
                             "chars": len(text), "outcomes": len(outs),
                             "text": text})
            print(f"  · {title[:66]:<66} {len(text):>6}c {len(outs):>2} outcomes")

        if not articles:
            continue

        path = os.path.join(docs_dir, f"{section}.md")
        with open(path, "w", encoding="utf-8") as f:
            f.write(f"# Docs — {section}\n\n")
            f.write(f"<!-- Generated by ingest-docs.py from {a.sitemap}\n"
                    f"     {len(articles)} articles. This is the INTENT source for QA:\n"
                    f"     what the product promises, in the product owner's words.\n"
                    f"     Do not hand-edit — re-run the ingest instead. -->\n\n")

            if all_outcomes:
                f.write("## Stated outcomes in this section\n\n")
                f.write("_Each of these is a candidate assertion. If the product "
                        "does not do this, that is either a regression or a stale "
                        "doc — both are findings._\n\n")
                for s in dict.fromkeys(all_outcomes):     # dedupe, keep order
                    f.write(f"- {s}\n")
                f.write("\n---\n\n")

            for art in articles:
                f.write(f"## {art['title']}\n\n<{art['url']}>\n\n{art['text']}\n\n---\n\n")

        index["sections"].append({
            "section": section,
            "file": os.path.relpath(path, a.out),
            "articles": len(articles),
            "failed": failed,
            "thin": skipped,
            "outcomes": len(all_outcomes),
            "titles": [x["title"] for x in articles],
        })
        print(f"  → {path}\n")

    # Doc sections are a human-authored decomposition of the product, which is
    # exactly what the sweep wants to shard on. Biggest sections first: they carry
    # the most surface area and deserve their own shard.
    index["suggested_areas"] = [s["section"] for s in index["sections"]]

    ipath = os.path.join(a.out, "docs-index.json")
    with open(ipath, "w", encoding="utf-8") as f:
        json.dump(index, f, indent=2)

    tot  = sum(s["articles"] for s in index["sections"])
    bad  = sum(s["failed"] for s in index["sections"])
    thin = sum(len(s["thin"]) for s in index["sections"])
    print("=" * 68)
    print(f"{tot} articles in {len(index['sections'])} sections → {docs_dir}")
    if bad:
        print(f"{bad} pages failed to fetch or parse — rerun to retry (cache keeps the rest)")
    if thin:
        print(f"{thin} articles came out unusually short — listed under \"thin\" in the "
              f"index. Usually a JS-rendered page the parser could not read; check one.")
    print(f"index → {ipath}")
    print("\nareas_json for the sweep caller:")
    print(json.dumps(index["suggested_areas"]))


if __name__ == "__main__":
    main()
