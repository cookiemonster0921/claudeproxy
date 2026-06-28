#!/usr/bin/env python3
"""Lightweight web search server — SearXNG-compatible JSON API.

Wraps DuckDuckGo search via the `duckduckgo-search` library.
No Docker, no API key, no configuration.

Usage:
    pip3 install duckduckgo-search
    python3 scripts/search-server.py              # default: 127.0.0.1:8890
    python3 scripts/search-server.py --port 9999   # custom port

API (same as SearXNG):
    GET /search?q=query&format=json
    → { "results": [{ "url": "...", "title": "...", "content": "..." }, ...] }

Set SEARXNG_URL=http://127.0.0.1:8890 in .dev.vars to enable in the proxy.
"""

import argparse
import json
import sys
import time
from http.server import HTTPServer, BaseHTTPRequestHandler
from urllib.parse import urlparse, parse_qs

try:
    from duckduckgo_search import DDGS
except ImportError:
    print("Missing dependency. Install with:")
    print("  pip3 install duckduckgo-search")
    sys.exit(1)


class SearchHandler(BaseHTTPRequestHandler):
    def do_GET(self):
        parsed = urlparse(self.path)

        if parsed.path == "/health":
            self._json_response(200, {"status": "ok"})
            return

        if parsed.path != "/search":
            self.send_error(404)
            return

        params = parse_qs(parsed.query)
        query = params.get("q", [""])[0].strip()
        if not query:
            self._json_response(400, {"error": "Missing q parameter"})
            return

        max_results = int(params.get("max_results", ["5"])[0])
        max_results = min(max_results, 10)

        t0 = time.monotonic()
        try:
            results = []
            with DDGS() as ddgs:
                for r in ddgs.text(query, max_results=max_results):
                    results.append(
                        {
                            "url": r.get("href", ""),
                            "title": r.get("title", ""),
                            "content": r.get("body", ""),
                        }
                    )
            elapsed = time.monotonic() - t0
            print(f"  search q={query!r} results={len(results)} {elapsed:.1f}s")
            self._json_response(200, {"results": results})
        except Exception as e:
            print(f"  search error: {e}")
            self._json_response(500, {"error": str(e), "results": []})

    def _json_response(self, status: int, body: dict):
        data = json.dumps(body).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def log_message(self, format, *args):
        pass


def main():
    parser = argparse.ArgumentParser(description="Lightweight web search server")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8890)
    args = parser.parse_args()

    server = HTTPServer((args.host, args.port), SearchHandler)
    print(f"[search-server] listening on http://{args.host}:{args.port}")
    print(f"[search-server] test: curl 'http://{args.host}:{args.port}/search?q=hello&format=json'")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n[search-server] stopped")


if __name__ == "__main__":
    main()
