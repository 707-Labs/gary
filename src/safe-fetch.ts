import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const MAX_REDIRECTS = 5;

export async function fetchPublicUrl(url: string, init: RequestInit = {}): Promise<Response> {
  let current = validatePublicHttpUrl(url);

  for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects += 1) {
    await assertPublicResolution(current.hostname);
    const response = await fetch(current, { ...init, redirect: "manual" });
    if (!REDIRECT_STATUSES.has(response.status)) return response;

    const location = response.headers.get("location");
    if (!location) return response;
    if (redirects === MAX_REDIRECTS) throw new Error(`too many redirects (max ${MAX_REDIRECTS})`);
    current = validatePublicHttpUrl(new URL(location, current).toString());
  }

  throw new Error("unreachable redirect state");
}

export function validatePublicHttpUrl(raw: string): URL {
  const url = new URL(raw);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`only http(s) urls are allowed (got ${url.protocol})`);
  }
  if (url.username || url.password) throw new Error("URL credentials are not allowed");

  const hostname = stripIpv6Brackets(url.hostname).toLowerCase().replace(/\.$/, "");
  if (
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname.endsWith(".local") ||
    hostname.endsWith(".internal")
  ) {
    throw new Error(`private or local URL host is not allowed: ${hostname}`);
  }
  if (isIP(hostname) !== 0 && !isPublicIp(hostname)) {
    throw new Error(`private or non-routable URL address is not allowed: ${hostname}`);
  }
  return url;
}

async function assertPublicResolution(hostnameWithBrackets: string): Promise<void> {
  const hostname = stripIpv6Brackets(hostnameWithBrackets);
  if (isIP(hostname) !== 0) return;
  const addresses = await lookup(hostname, { all: true, verbatim: true });
  if (addresses.length === 0) throw new Error(`URL host did not resolve: ${hostname}`);
  for (const { address } of addresses) {
    if (!isPublicIp(address)) {
      throw new Error(`URL host resolves to a private or non-routable address: ${hostname}`);
    }
  }
}

export function isPublicIp(address: string): boolean {
  const version = isIP(address);
  if (version === 4) return isPublicIpv4(address);
  if (version === 6) return isPublicIpv6(address);
  return false;
}

function isPublicIpv4(address: string): boolean {
  const octets = address.split(".").map(Number);
  if (octets.length !== 4 || octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return false;
  }
  const [a = 0, b = 0, c = 0] = octets;
  if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
  if (a === 100 && b >= 64 && b <= 127) return false; // shared/CGNAT, including the tailnet
  if (a === 169 && b === 254) return false;
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return false;
  if (a === 192 && b === 168) return false;
  if (a === 198 && (b === 18 || b === 19)) return false;
  if (a === 198 && b === 51 && c === 100) return false;
  if (a === 203 && b === 0 && c === 113) return false;
  return true;
}

function isPublicIpv6(address: string): boolean {
  const normalized = address.toLowerCase();
  if (normalized === "::" || normalized === "::1") return false;
  if (normalized.startsWith("::ffff:")) {
    const mapped = normalized.slice("::ffff:".length);
    return isIP(mapped) === 4 && isPublicIpv4(mapped);
  }
  const first = Number.parseInt(normalized.split(":", 1)[0] || "0", 16);
  if (!Number.isFinite(first)) return false;
  if ((first & 0xfe00) === 0xfc00) return false; // unique-local fc00::/7
  if ((first & 0xffc0) === 0xfe80) return false; // link-local fe80::/10
  if ((first & 0xff00) === 0xff00) return false; // multicast ff00::/8
  if (normalized.startsWith("2001:db8:")) return false; // documentation
  return true;
}

function stripIpv6Brackets(hostname: string): string {
  return hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
}
