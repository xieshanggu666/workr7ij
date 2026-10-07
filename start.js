"use strict";
const http = require("http");
const { spawn } = require("child_process");
const path = require("path");

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = http.createServer();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const p = srv.address().port;
      srv.close(() => resolve(p));
    });
  });
}

function openBrowser(url) {
  if (process.platform === "win32") {
    spawn("cmd", ["/c", "start", "", url], { stdio: "ignore", detached: true }).unref();
  } else if (process.platform === "darwin") {
    spawn("open", [url], { stdio: "ignore", detached: true }).unref();
  } else {
    spawn("xdg-open", [url], { stdio: "ignore", detached: true }).unref();
  }
}

(async () => {
  const port = await freePort();
  const child = spawn(process.execPath, [path.join(__dirname, "server.js"), `--port=${port}`], { stdio: "inherit" });
  const kill = () => child.kill();
  process.on("SIGINT", kill);
  process.on("SIGTERM", kill);
  setTimeout(() => openBrowser(`http://127.0.0.1:${port}`), 900);
  child.on("exit", () => process.exit(0));
})();
