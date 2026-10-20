"""A scripted stand-in for js-debug's dapDebugServer.js in tests: prints "Debug server listening at
127.0.0.1:port" like js-debug, then serves DAP on every connection. The first connection is the
parent session: after its launch it asks the client to start a child session with the
`startDebugging` reverse request (a `__pendingTargetId` configuration, like js-debug). A connection
whose launch carries that id is the child: it stops at its first breakpoint and terminates on
continue. The server exits once the parent connection closes."""
import json
import socket
import sys
import threading


def serve(conn, state):
    rf, wf = conn.makefile("rb"), conn.makefile("wb")
    lock = threading.Lock()
    seq = [0]

    def send(msg):
        with lock:
            seq[0] += 1
            msg["seq"] = seq[0]
            data = json.dumps(msg).encode("utf-8")
            wf.write(b"Content-Length: %d\r\n\r\n" % len(data) + data)
            wf.flush()

    def respond(req, body=None):
        msg = {"type": "response", "request_seq": req["seq"], "command": req["command"], "success": True}
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
            k, _, v = line.decode().partition(":")
            if k.lower() == "content-length":
                length = int(v)
        return json.loads(rf.read(length))

    child = False
    breakpoints = []
    while True:
        msg = read()
        if msg is None:
            break
        if msg["type"] == "response":
            continue
        cmd = msg["command"]
        if cmd == "initialize":
            respond(msg, {"supportsConfigurationDoneRequest": True, "exceptionBreakpointFilters": [{"filter": "uncaught", "label": "Uncaught Exceptions", "default": True}]})
        elif cmd == "launch":
            child = msg["arguments"].get("__pendingTargetId") == "target-1"
            respond(msg)
            send({"type": "event", "event": "initialized"})
            if not child:
                send({"type": "request", "command": "startDebugging", "arguments": {"request": "launch", "configuration": {"type": "pwa-node", "name": "child", "__pendingTargetId": "target-1"}}})
        elif cmd == "setBreakpoints":
            breakpoints = [b["line"] for b in msg["arguments"].get("breakpoints", [])]
            respond(msg, {"breakpoints": [{"id": i + 1, "verified": True, "line": l} for i, l in enumerate(breakpoints)]})
        elif cmd == "setExceptionBreakpoints":
            respond(msg, {})
        elif cmd == "configurationDone":
            respond(msg)
            if child and breakpoints:
                send({"type": "event", "event": "stopped", "body": {"reason": "breakpoint", "threadId": 7}})
        elif cmd == "continue":
            respond(msg, {"allThreadsContinued": True})
            send({"type": "event", "event": "terminated"})
        elif cmd == "disconnect":
            respond(msg)
            break
        else:
            respond(msg, {})
    conn.close()
    if not child:
        state["parent_done"].set()


def main():
    srv = socket.socket()
    srv.bind(("127.0.0.1", 0))
    srv.listen(4)
    print("Debug server listening at 127.0.0.1:%d" % srv.getsockname()[1], flush=True)
    state = {"parent_done": threading.Event()}
    srv.settimeout(0.2)
    while not state["parent_done"].is_set():
        try:
            conn, _ = srv.accept()
        except socket.timeout:
            continue
        threading.Thread(target=serve, args=(conn, state), daemon=True).start()


if __name__ == "__main__":
    main()
