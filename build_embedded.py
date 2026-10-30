#!/usr/bin/env python3
"""Inline CDN scripts into standalone HTML files under release/ (stdlib only)."""

from html import escape
from html.parser import HTMLParser
from pathlib import Path
import re
import sys
from urllib.error import URLError
from urllib.request import Request, urlopen


ROOT = Path(__file__).resolve().parent
RELEASE = ROOT / "release"
SOURCES = ("index.html", "airscan-fountain.html")
SCRIPT = re.compile(r"<script\b(?P<attrs>[^>]*)>(?P<body>.*?)</script\s*>", re.I | re.S)


class ScriptAttributes(HTMLParser):
    def handle_starttag(self, tag, attrs):
        self.attrs = dict(attrs)


def load_dependency(url):
    if not url.startswith(("https://", "http://")):
        raise ValueError(f"Only HTTP(S) script URLs are supported: {url}")
    print(f"  download: {url}")
    request = Request(url, headers={"User-Agent": "AirScan-QR-Embedded-Builder/1.0"})
    with urlopen(request, timeout=60) as response:
        content_type = response.headers.get_content_type()
        if content_type in ("text/html", "application/json"):
            raise ValueError(f"Expected JavaScript, received {content_type}: {url}")
        code = response.read().decode("utf-8-sig")
    if not code.strip():
        raise ValueError(f"Empty script: {url}")
    return code


def build_html(source, dependencies):
    def inline(match):
        parser = ScriptAttributes()
        parser.feed("<script" + match["attrs"] + "></script>")
        attrs = parser.attrs
        url = attrs.get("src")
        if url is None:
            return match.group(0)
        # These execution modes need more than a simple inline substitution.
        unsupported = set(attrs) - {"src", "type"}
        if unsupported or attrs.get("type", "text/javascript") not in (
            "text/javascript", "application/javascript",
        ):
            raise ValueError(f"Unsupported external script attributes: {attrs}")
        if url not in dependencies:
            dependencies[url] = load_dependency(url)
        code = dependencies[url]
        # DevTools must not try fetching source maps while using the offline file.
        code = re.sub(r"(?m)^[ \t]*//[#@]\s*sourceMappingURL=[^\r\n]*", "", code)
        # An HTML parser closes a script even when this text occurs inside JS strings.
        code = re.sub(r"</script", lambda m: "<\\/" + m.group(0)[2:], code, flags=re.I)
        return f'<script data-embedded-src="{escape(url, quote=True)}">\n{code}\n</script>'

    html = source.read_text(encoding="utf-8")
    return SCRIPT.sub(inline, html)


def main():
    dependencies = {}
    outputs = []
    try:
        # Download fresh dependencies each run; share them between both pages.
        # Convert both pages before replacing any release file.
        for name in SOURCES:
            print(f"Building {name}")
            html = build_html(ROOT / name, dependencies)
            outputs.append((RELEASE / f"{Path(name).stem}-embedded.html", html))
        RELEASE.mkdir(exist_ok=True)
        for target, html in outputs:
            temporary = target.with_suffix(".html.tmp")
            temporary.write_text(html, encoding="utf-8", newline="\n")
            temporary.replace(target)
            print(f"Created release/{target.name} ({target.stat().st_size:,} bytes)")
    except (OSError, URLError, UnicodeError, ValueError) as exc:
        print(f"Build failed: {exc}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
