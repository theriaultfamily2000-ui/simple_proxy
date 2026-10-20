```javascript
const express = require("express");
const dns = require("node:dns").promises;
const net = require("node:net");
const path = require("node:path");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.static(path.join(__dirname, "public")));

function isPublicIp(ip) {
  const version = net.isIP(ip);

  if (version === 4) {
    const [a, b] = ip.split(".").map(Number);

    return !(
      a === 0 ||
      a === 10 ||
      a === 127 ||
      a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 192 && b === 0) ||
      (a === 198 && (b === 18 || b === 19 || b === 51)) ||
      (a === 203 && b === 0)
    );
  }

  if (version === 6) {
    const normalized = ip.toLowerCase();

    return (
      !normalized.startsWith("::ffff:") &&
      normalized !== "::" &&
      normalized !== "::1" &&
      !normalized.startsWith("fc") &&
      !normalized.startsWith("fd") &&
      !/^fe[89ab]/.test(normalized) &&
      !normalized.startsWith("ff")
    );
  }

  return false;
}

async function validateUrl(value) {
  let url;

  try {
    url = new URL(value);
  } catch {
    throw new Error("Enter a valid URL, including https://");
  }

  if (!["http:", "https:"].includes(url.protocol)) {
    throw new Error("Only HTTP and HTTPS addresses are supported.");
  }

  if (url.username || url.password) {
    throw new Error("URLs containing credentials are not allowed.");
  }

  const hostname = url.hostname.replace(/^\[|\]$/g, "");

  if (!hostname || hostname === "localhost") {
    throw new Error("That hostname is not allowed.");
  }

  if (net.isIP(hostname)) {
    if (!isPublicIp(hostname)) {
      throw new Error("Private or reserved IP addresses are not allowed.");
    }
  } else {
    let addresses;

    try {
      addresses = await dns.lookup(hostname, { all: true });
    } catch {
      throw new Error("Could not resolve that hostname.");
    }

    if (
      !addresses.length ||
      addresses.some(({ address }) => !isPublicIp(address))
    ) {
      throw new Error("That hostname resolves to a restricted address.");
    }
  }

  return url;
}

app.get("/api/fetch", async (req, res) => {
  let timer;

  try {
    const input = String(req.query.url || "");

    if (!input || input.length > 2048) {
      return res.status(400).json({
        error: "Enter a URL shorter than 2048 characters."
      });
    }

    const url = await validateUrl(input);
    const controller = new AbortController();

    timer = setTimeout(() => controller.abort(), 10000);

    const upstream = await fetch(url, {
      redirect: "manual",
      signal: controller.signal,
      headers: {
        "User-Agent": "SimpleWebProxy/1.0",
        "Accept": "text/html, text/plain, application/json"
      }
    });

    if (upstream.status >= 300 && upstream.status < 400) {
      return res.status(502).json({
        error: "This page redirects. Try entering its final destination URL."
      });
    }

    const contentType = upstream.headers.get("content-type") || "";

    if (
      !contentType.includes("text/html") &&
      !contentType.includes("text/plain") &&
      !contentType.includes("application/json")
    ) {
      return res.status(415).json({
        error: "This page type is not supported."
      });
    }

    const body = await upstream.text();

    if (Buffer.byteLength(body, "utf8") > 2 * 1024 * 1024) {
      return res.status(413).json({
        error: "The page is too large. The limit is 2 MB."
      });
    }

    res.set("Cache-Control", "no-store");

    return res.json({
      url: url.href,
      status: upstream.status,
      contentType,
      body
    });
  } catch (error) {
    const message =
      error.name === "AbortError"
        ? "The request timed out."
        : error.message || "Could not fetch that page.";

    return res.status(400).json({ error: message });
  } finally {
    clearTimeout(timer);
  }
});

app.listen(PORT, () => {
  console.log(`Proxy server running on port ${PORT}`);
});
