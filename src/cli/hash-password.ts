/**
 * `npm run auth:hash` - read the password behind a masked prompt and print the
 * env line to paste.
 *
 * The prompt sets raw mode and turns echo off, so the password never reaches
 * terminal scrollback, a shell history file, or a process listing. That is the
 * entire reason this is a CLI rather than `node -e "..."`.
 */
import { stdin, stdout } from "node:process";
import { hashPassword } from "../auth/password.ts";

const MAX_PASSWORD_BYTES = 1024;
const MIN_PASSWORD_CHARS = 12;

function readMasked(prompt: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const input = stdin;
    const output = stdout;
    if (!input.isTTY) {
      reject(new Error("auth:hash needs an interactive terminal (stdin is not a TTY)"));
      return;
    }
    output.write(prompt);
    const wasRaw = input.isRaw === true;
    input.setRawMode(true);
    input.resume();
    input.setEncoding("utf8");
    let value = "";
    const cleanup = (): void => {
      input.removeListener("data", onData);
      input.setRawMode(wasRaw);
      input.pause();
    };
    const onData = (chunk: string): void => {
      for (const character of chunk) {
        const code = character.charCodeAt(0);
        if (character === "\r" || character === "\n") {
          cleanup();
          output.write("\n");
          resolve(value);
          return;
        }
        if (code === 3) {
          // Ctrl-C
          cleanup();
          output.write("\n");
          reject(new Error("cancelled"));
          return;
        }
        if (character === "" || character === "\b") {
          value = value.slice(0, -1);
          continue;
        }
        if (code >= 0x20) value += character;
      }
    };
    input.on("data", onData);
  });
}

async function main(): Promise<void> {
  const password = await readMasked("Liszt password (input hidden): ");
  const confirm = await readMasked("Confirm: ");
  if (password !== confirm) throw new Error("Passwords did not match");
  if (Buffer.byteLength(password, "utf8") > MAX_PASSWORD_BYTES) {
    throw new Error("Password is too long");
  }
  if (password.length < MIN_PASSWORD_CHARS) {
    throw new Error(
      `Refusing a password under ${MIN_PASSWORD_CHARS} characters: it is the app's only perimeter`,
    );
  }
  const hash = await hashPassword(password);
  process.stdout.write(
    [
      "",
      "Add this line to your environment file (it is a credential - never commit it):",
      "",
      `LISZT_AUTH_PASSWORD_HASH=${hash}`,
      "",
      "The plaintext was never written to disk, logged, or printed. Losing this hash",
      "means resetting it; there is no recovery path.",
      "",
    ].join("\n"),
  );
}

try {
  await main();
  process.exit(0);
} catch (error) {
  process.stderr.write(`auth:hash failed: ${(error as Error).message}\n`);
  process.exit(1);
}
