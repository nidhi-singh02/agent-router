// Reads `router session --json` on stdin and prints the session id, or nothing.
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  input += chunk;
});
process.stdin.on("end", () => {
  try {
    const session = JSON.parse(input.trim() || "null");
    process.stdout.write(session && typeof session.id === "string" ? session.id : "");
  } catch {
    process.stdout.write("");
  }
});
