"""A scripted debug adapter for tests: speaks DAP with Content-Length framing over stdio, or over
TCP with `--tcp` (printing "DAP server listening at: host:port" like `dlv dap`). It stops once at
the first breakpoint, reports one frame/scope/variable, and terminates on continue."""
import json
import socket
import sys


def main():
    if "--tcp" in sys.argv:
        srv = socket.socket()
        srv.bind(("127.0.0.1", 0))
        srv.listen(1)
        print("DAP server listening at: 127.0.0.1:%d" % srv.getsockname()[1], flush=True)
        conn, _ = srv.accept()
        rf, wf = conn.makefile("rb"), conn.makefile("wb")
    else:
        rf, wf = sys.stdin.buffer, sys.stdout.buffer
    print("fake adapter ready", file=sys.stderr, flush=True)
    seq = [0]

    def send(msg):
        seq[0] += 1
        msg["seq"] = seq[0]
        data = json.dumps(msg, ensure_ascii=False).encode("utf-8")
        wf.write(b"Content-Length: %d\r\n\r\n" % len(data) + data)
        wf.flush()

    def respond(req, body=None, success=True, message=None):
        msg = {"type": "response", "request_seq": req["seq"], "command": req["command"], "success": success}
        if body is not None:
            msg["body"] = body
        if message:
            msg["message"] = message
        send(msg)

    def event(name, body=None):
        msg = {"type": "event", "event": name}
        if body is not None:
            msg["body"] = body
        send(msg)

    def read():
        length = None
        while True:
            line = rf.readline()
            if not line:
                return None
            line = line.strip()
            if not line:
                break
            key, _, value = line.decode().partition(":")
            if key.strip().lower() == "content-length":
                length = int(value)
        return json.loads(rf.read(length).decode("utf-8"))

    program, lines = None, []
    while True:
        req = read()
        if req is None:
            return
        cmd, args = req["command"], req.get("arguments") or {}
        if cmd == "initialize":
            respond(req, {"supportsConfigurationDoneRequest": True})
        elif cmd == "launch":
            program = args.get("program")
            respond(req)
            event("initialized")
        elif cmd == "setBreakpoints":
            lines = [b["line"] for b in args.get("breakpoints", [])]
            respond(req, {"breakpoints": [{"id": i + 1, "verified": True, "line": l} for i, l in enumerate(lines)]})
        elif cmd == "configurationDone":
            respond(req)
            event("output", {"category": "stdout", "output": "สวัสดี from the debuggee\n"})
            event("stopped", {"reason": "breakpoint", "threadId": 1, "allThreadsStopped": True})
        elif cmd == "threads":
            respond(req, {"threads": [{"id": 1, "name": "main"}]})
        elif cmd == "stackTrace":
            frame = {"id": 100, "name": "main", "line": lines[0] if lines else 1, "column": 1, "source": {"path": program}}
            respond(req, {"stackFrames": [frame], "totalFrames": 1})
        elif cmd == "scopes":
            respond(req, {"scopes": [{"name": "Locals", "variablesReference": 7, "expensive": False}]})
        elif cmd == "variables":
            respond(req, {"variables": [{"name": "x", "value": "42", "type": "int", "variablesReference": 0}]})
        elif cmd == "continue":
            respond(req, {"allThreadsContinued": True})
            event("continued", {"threadId": 1, "allThreadsContinued": True})
            event("exited", {"exitCode": 0})
            event("terminated")
        elif cmd == "disconnect":
            respond(req)
            return
        else:
            respond(req, success=False, message="unsupported: " + cmd)


main()
