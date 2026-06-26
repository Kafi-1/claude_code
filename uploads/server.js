const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { spawn } = require("child_process");

const PORT = process.env.PORT || 3000;
const MODEL = process.env.ANTHROPIC_MODEL || "claude-opus-4-6";
const UPLOAD_DIR = path.join(__dirname, "uploads");

if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", chunk => {
      body += chunk;
      if (body.length > 25 * 1024 * 1024) { // 25MB safety cap
        reject(new Error("Payload too large"));
        req.destroy();
      }
    });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

// Runs the REAL Claude Code CLI in non-interactive print mode.
// No headers are forged here — this just talks to the actual `claude` binary,
// exactly like running it from the terminal, so it works the same way it
// does when you run it directly in Termux.
function runClaudeCode(promptText, model) {
  return new Promise((resolve, reject) => {
    const args = ["-p", promptText, "--output-format", "text"];
    if (model) args.push("--model", model);

    const child = spawn("claude", args, {
      env: process.env, // inherits ANTHROPIC_BASE_URL / ANTHROPIC_AUTH_TOKEN / etc set in your shell
      cwd: UPLOAD_DIR    // so the CLI can see uploaded files via relative paths
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", d => stdout += d);
    child.stderr.on("data", d => stderr += d);

    child.on("error", err => reject(err)); // e.g. "claude" not found in PATH

    child.on("close", code => {
      if (code !== 0 && !stdout.trim()) {
        reject(new Error(stderr.trim() || `claude exited with code ${code}`));
      } else {
        resolve(stdout.trim());
      }
    });
  });
}

const server = http.createServer(async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }

  // Serve UI
  if (req.method === "GET" && req.url === "/") {
    fs.readFile(path.join(__dirname, "index.html"), (err, data) => {
      if (err) { res.writeHead(404); res.end("Not found"); return; }
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(data);
    });
    return;
  }

  // Frontend config
  if (req.method === "GET" && req.url === "/config") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      model: MODEL,
      hasKey: !!process.env.ANTHROPIC_AUTH_TOKEN
    }));
    return;
  }

  // File upload -> saves to /uploads, returns a path the CLI can read
  if (req.method === "POST" && req.url === "/upload") {
    try {
      const body = await readBody(req);
      const { filename, dataBase64 } = JSON.parse(body);
      if (!filename || !dataBase64) throw new Error("filename and dataBase64 required");

      const safeName = crypto.randomBytes(6).toString("hex") + "_" +
        filename.replace(/[^a-zA-Z0-9._-]/g, "_");
      const filePath = path.join(UPLOAD_DIR, safeName);

      fs.writeFileSync(filePath, Buffer.from(dataBase64, "base64"));

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ path: safeName }));
    } catch (e) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // Chat -> runs the real Claude Code CLI
  if (req.method === "POST" && req.url === "/chat") {
    try {
      const body = await readBody(req);
      const { messages, model, attachments } = JSON.parse(body);

      if (!Array.isArray(messages) || !messages.length) {
        throw new Error("messages array required");
      }

      // Claude Code's -p mode is single-shot, so we fold the conversation
      // history into one prompt. Simple and good enough for a phone chat app.
      let prompt = messages.map(m =>
        `${m.role === "user" ? "User" : "Assistant"}: ${m.content}`
      ).join("\n\n");

      if (Array.isArray(attachments) && attachments.length) {
        prompt += "\n\nAttached files (read these from the current directory):\n" +
          attachments.map(a => `- ${a}`).join("\n");
      }

      const reply = await runClaudeCode(prompt, model);

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ content: [{ type: "text", text: reply }] }));
    } catch (e) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: { message: e.message } }));
    }
    return;
  }

  res.writeHead(404); res.end("Not found");
});

server.listen(PORT, () => {
  console.log("✅ Claude Chat (via real Claude Code CLI): http://localhost:" + PORT);
  console.log("🤖 Model: " + MODEL);
  console.log("📁 Uploads dir: " + UPLOAD_DIR);
  console.log("ℹ️  Make sure ANTHROPIC_BASE_URL / ANTHROPIC_AUTH_TOKEN / ANTHROPIC_MODEL / CLAUDE_CODE_USE_AUTH_TOKEN are exported in this shell before running.");
});
