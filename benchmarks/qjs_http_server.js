import * as std from "qjs:std";
import * as os from "qjs:os";

const requests = Number(scriptArgs[1] || 5000);
const keepAlive = scriptArgs[2] === "keepalive";
const listener = os.tcpListen("127.0.0.1", 0, 1024);

if (typeof listener === "number") {
  throw new Error(`tcpListen failed: ${listener}`);
}

const responseBody = "quickjs-ng benchmark response\n";
const response =
  "HTTP/1.1 200 OK\r\n" +
  "content-type: text/plain\r\n" +
  `content-length: ${responseBody.length}\r\n` +
  `connection: ${keepAlive ? "keep-alive" : "close"}\r\n` +
  "\r\n" +
  responseBody;

print(`PORT ${listener.port}`);
std.out.flush();

let handled = 0;
let checksum = 0;

while (handled < requests) {
  const fd = os.accept(listener.fd);
  if (fd < 0) {
    if (fd === -4) {
      continue;
    }
    throw new Error(`accept failed: ${fd}`);
  }

  const stream = std.fdopen(fd, "r+");
  if (stream === null) {
    os.close(fd);
    continue;
  }

  while (handled < requests) {
    let sawHeader = false;
    let sawEof = false;

    for (;;) {
      const line = stream.getline();
      if (line === null) {
        sawEof = true;
        break;
      }
      if (line === "" || line === "\r") {
        break;
      }
      sawHeader = true;
      checksum = (checksum + line.length) | 0;
    }

    if (!sawHeader && sawEof) {
      break;
    }

    stream.write(response);
    stream.flush();
    handled++;

    if (!keepAlive) {
      break;
    }
  }

  stream.close();
}

os.close(listener.fd);
print(`DONE requests=${handled} checksum=${checksum >>> 0}`);
