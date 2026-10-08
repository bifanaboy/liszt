import { createServer } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { pathToFileURL } from "node:url";
import { validSxyprnUrl } from "../lib/tubes/sxyprn.js";

const MAX_BODY_BYTES = 4096;
const MAX_RESPONSE_BYTES = 65_536;
const MAX_QUERY_LENGTH = 200;
const VIDEO_FIELDS = ["url", "title", "durationSeconds", "views", "isExternal", "author"];
const DETAIL_FIELDS = [...VIDEO_FIELDS, "streamUrl", "uploadDate", "sizeBytes"];

function send(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    "cache-control": "no-store",
    "content-type": "application/json; charset=utf-8",
  });
  res.end(data);
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    let tooLarge = false;
    const chunks = [];
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        tooLarge = true;
        chunks.length = 0;
      } else if (!tooLarge) {
        chunks.push(chunk);
      }
    });
    req.on("end", () => {
      if (tooLarge) {
        reject(Object.assign(new Error("request too large"), { status: 413 }));
        return;
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        reject(Object.assign(new Error("invalid JSON"), { status: 400 }));
      }
    });
    req.on("error", () => reject(Object.assign(new Error("request failed"), { status: 400 })));
  });
}

function authorized(req, secret) {
  const supplied = req.headers.authorization;
  if (typeof supplied !== "string") return false;
  const expectedBytes = Buffer.from(`Bearer ${secret}`);
  const suppliedBytes = Buffer.from(supplied);
  return (
    suppliedBytes.length === expectedBytes.length && timingSafeEqual(suppliedBytes, expectedBytes)
  );
}

function pickFields(value, fields) {
  const result = {};
  for (const field of fields) {
    const item = value?.[field];
    if (typeof item === "string" && item.length <= 4096) result[field] = item;
    else if (typeof item === "number" && Number.isFinite(item)) result[field] = item;
    else if (typeof item === "boolean") result[field] = item;
  }
  return result;
}

async function withinTimeout(operation, timeoutMs) {
  let timer;
  let pending;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(
      () => reject(Object.assign(new Error("upstream timeout"), { status: 504 })),
      timeoutMs,
    );
  });
  try {
    pending = Promise.resolve().then(operation);
    return await Promise.race([pending, deadline]);
  } catch (error) {
    pending?.catch(() => {});
    if (error?.status === 504) throw error;
    throw Object.assign(new Error("upstream unavailable"), { status: 502 });
  } finally {
    clearTimeout(timer);
  }
}

export function createSxyprnRelayHandler({ secret, api, timeoutMs = 15_000 } = {}) {
  if (!secret) throw new Error("SXYPRN_RELAY_SECRET is required");
  if (!api?.videos?.search || !api?.videos?.details)
    throw new Error("Sxyprn package API is unavailable");

  return async (req, res) => {
    const path = new URL(req.url, "http://relay.local").pathname;
    if (req.method !== "POST" || (path !== "/v1/search" && path !== "/v1/details")) {
      send(res, 404, { error: "not found" });
      return;
    }
    if (!authorized(req, secret)) {
      send(res, 401, { error: "unauthorized" });
      return;
    }
    if (!/^application\/json(?:\s*;|$)/i.test(req.headers["content-type"] ?? "")) {
      send(res, 415, { error: "JSON required" });
      return;
    }

    try {
      const input = await readJson(req);
      let output;
      if (path === "/v1/search") {
        const query = typeof input?.query === "string" ? input.query.trim() : "";
        if (!query || query.length > MAX_QUERY_LENGTH) {
          send(res, 400, { error: "invalid search query" });
          return;
        }
        const page = await withinTimeout(() => api.videos.search(query, { page: 0 }), timeoutMs);
        if (!Array.isArray(page?.videos)) {
          send(res, 502, { error: "invalid Sxyprn response" });
          return;
        }
        output = {
          videos: page.videos.slice(0, 100).map((video) => pickFields(video, VIDEO_FIELDS)),
        };
      } else {
        if (!validSxyprnUrl(input?.url)) {
          send(res, 400, { error: "invalid Sxyprn post URL" });
          return;
        }
        const detail = await withinTimeout(() => api.videos.details({ url: input.url }), timeoutMs);
        if (!detail || typeof detail !== "object" || Array.isArray(detail)) {
          send(res, 502, { error: "invalid Sxyprn response" });
          return;
        }
        output = pickFields(detail, DETAIL_FIELDS);
      }

      if (Buffer.byteLength(JSON.stringify(output)) > MAX_RESPONSE_BYTES) {
        send(res, 502, { error: "Sxyprn response too large" });
        return;
      }
      send(res, 200, output);
    } catch (error) {
      const status =
        error?.status === 413
          ? 413
          : error?.status === 400
            ? 400
            : error?.status === 504
              ? 504
              : 502;
      send(res, status, {
        error:
          status === 504
            ? "Sxyprn request timed out"
            : status === 413
              ? "request too large"
              : status === 400
                ? "invalid request"
                : "Sxyprn unavailable",
      });
    }
  };
}

export function createSxyprnRelayServer(options = {}) {
  const server = createServer(createSxyprnRelayHandler(options));
  server.requestTimeout = 10_000;
  server.headersTimeout = 5_000;
  return server;
}

export async function startSxyprnRelay(env = process.env) {
  const imported = await import("sxyprn");
  const api = imported.default;
  const server = createSxyprnRelayServer({ secret: env.SXYPRN_RELAY_SECRET, api });
  server.listen(Number(env.PORT) || 10_000, "0.0.0.0");
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  startSxyprnRelay().catch(() => {
    console.error("Sxyprn relay failed to start");
    process.exitCode = 1;
  });
}
