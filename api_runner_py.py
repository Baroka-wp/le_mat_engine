#!/usr/bin/env python3
"""
Le Mat — Python API Runner
Receives a request context on stdin (JSON), loads a user API file,
matches the route, executes the handler, and prints the response as JSON to stdout.
"""
import sys
import json
import os
import re
import traceback

def main():
    try:
        req_data = json.loads(sys.stdin.read())
    except Exception as e:
        print(json.dumps({"status": 500, "body": {"error": f"Invalid request data: {e}"}}))
        return

    api_file   = req_data["file"]       # absolute path to the .py file
    method     = req_data["method"]      # GET, POST, PUT, DELETE, PATCH
    route_path = req_data["path"]        # e.g. /users/42
    body       = req_data.get("body")    # parsed JSON body (or None)
    query      = req_data.get("query", {})
    headers    = req_data.get("headers", {})
    project    = req_data["project"]     # project name

    # Shared namespace for init + user code
    ns = {"__builtins__": __builtins__, "__name__": "__main__"}

    # Set up the api decorator registry
    _routes = []

    class _Request:
        def __init__(self, method, path, body, query, headers, params):
            self.method = method
            self.path = path
            self.body = body
            self.query = query
            self.headers = headers
            self.params = params

    class _ApiRouter:
        def _register(self, method, path):
            def decorator(fn):
                _routes.append({"method": method.upper(), "path": path, "handler": fn})
                return fn
            return decorator

        def get(self, path):
            return self._register("GET", path)
        def post(self, path):
            return self._register("POST", path)
        def put(self, path):
            return self._register("PUT", path)
        def delete(self, path):
            return self._register("DELETE", path)
        def patch(self, path):
            return self._register("PATCH", path)

    ns["api"] = _ApiRouter()

    # Load _lemat_init.py first (sets up `lemat` in the shared namespace)
    # CWD is the project root (set by main.py), _lemat_init.py lives there
    project_dir = os.getcwd()
    init_path = os.path.join(project_dir, "_lemat_init.py")
    if os.path.exists(init_path):
        try:
            with open(init_path) as f:
                exec(compile(f.read(), init_path, "exec"), ns)
        except Exception as e:
            # Non-fatal: continue without SDK
            pass

    # Load and execute the user file in the SAME namespace
    try:
        with open(api_file) as f:
            code = f.read()
        exec(compile(code, api_file, "exec"), ns)
    except Exception as e:
        tb = traceback.format_exc()
        print(json.dumps({"status": 500, "body": {"error": f"Error loading API file: {e}", "traceback": tb}}))
        return

    # Match route
    matched = None
    params = {}

    for route in _routes:
        if route["method"] != method.upper():
            continue
        # Convert route pattern to regex:  /users/:id → /users/(?P<id>[^/]+)
        pattern = re.sub(r":(\w+)", r"(?P<\1>[^/]+)", route["path"])
        pattern = "^" + pattern + "$"
        m = re.match(pattern, route_path)
        if m:
            matched = route
            params = m.groupdict()
            break

    if not matched:
        print(json.dumps({"status": 404, "body": {"error": f"No route matches {method} {route_path}"}}))
        return

    # Execute handler
    req = _Request(method, route_path, body, query, headers, params)
    try:
        result = matched["handler"](req)
        # Allow returning (status, body) tuple
        if isinstance(result, tuple) and len(result) == 2:
            status, body_out = result
        elif isinstance(result, dict) and "status" in result and "body" in result:
            status = result.pop("status", 200)
            body_out = result.get("body", result)
        elif isinstance(result, dict):
            status = 200
            body_out = result
        elif isinstance(result, list):
            status = 200
            body_out = result
        elif result is None:
            status = 204
            body_out = None
        else:
            status = 200
            body_out = result
        print(json.dumps({"status": status, "body": body_out}))
    except Exception as e:
        tb = traceback.format_exc()
        print(json.dumps({"status": 500, "body": {"error": str(e), "traceback": tb}}))


if __name__ == "__main__":
    main()
