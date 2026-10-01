"""Recording proxy for isolated Stash integration fixtures only."""
import http.client
import http.server
import json
import re
import threading
import time


class MediaProxy:
    def __init__(self, backend_port):
        self.requests = []
        self.delay = None
        self.lock = threading.Lock()
        owner = self

        class Handler(http.server.BaseHTTPRequestHandler):
            protocol_version = "HTTP/1.1"

            def log_message(self, *args):
                pass

            def json(self, body):
                data = json.dumps(body).encode()
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

            def forward(self):
                path = self.path.split("?", 1)[0]
                if path == "/_test/requests":
                    with owner.lock:
                        self.json(list(owner.requests))
                    return
                if path == "/_test/reset":
                    with owner.lock:
                        owner.requests.clear()
                    self.json({"reset": True})
                    return
                if path.startswith("/_test/delay/"):
                    match = re.fullmatch(r"/_test/delay/(\d+|off)", path)
                    if not match:
                        self.send_error(400)
                        return
                    owner.delay = None if match[1] == "off" else match[1]
                    self.json({"delay": owner.delay})
                    return
                stream = re.fullmatch(r"/scene/(\d+)/stream", path)
                entry = None
                if stream:
                    entry = {"id": stream[1], "range": self.headers.get("Range"), "bytes": 0,
                             "destination": self.headers.get("Sec-Fetch-Dest"), "started": time.monotonic()}
                    with owner.lock:
                        owner.requests.append(entry)
                    if owner.delay == stream[1]:
                        time.sleep(2)
                connection = http.client.HTTPConnection("127.0.0.1", backend_port, timeout=30)
                try:
                    body = self.rfile.read(int(self.headers.get("Content-Length", "0"))) or None
                    headers = {name: value for name, value in self.headers.items()
                               if name.lower() not in ["connection", "accept-encoding"]}
                    headers["Connection"] = "close"
                    connection.request(self.command, self.path, body=body, headers=headers)
                    response = connection.getresponse()
                    self.send_response(response.status)
                    for name, value in response.getheaders():
                        if name.lower() not in ["connection", "transfer-encoding", "cache-control"]:
                            self.send_header(name, value)
                    if stream:
                        self.send_header("Cache-Control", "no-store")
                    self.send_header("Connection", "close")
                    self.end_headers()
                    if entry is not None:
                        entry["status"] = response.status
                        entry["contentRange"] = response.getheader("Content-Range")
                    while data := response.read(65536):
                        self.wfile.write(data)
                        if entry is not None:
                            entry["bytes"] += len(data)
                    if entry is not None:
                        entry["finished"] = time.monotonic()
                except (BrokenPipeError, ConnectionResetError):
                    if entry is not None:
                        entry["cancelled"] = True
                finally:
                    connection.close()
                    self.close_connection = True

            do_GET = forward
            do_POST = forward
            do_HEAD = forward

        self.server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.url = f"http://127.0.0.1:{self.server.server_port}"

    def close(self):
        self.server.shutdown()
        self.server.server_close()
