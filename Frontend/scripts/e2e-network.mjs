import dns from "node:dns";
import { isIP } from "node:net";

// Optional, process-local routing for E2E on hosts with partial Neon reachability.
// TLS still verifies the original hostname. No system DNS or hosts file changes.
export function pinLookup(host, address) {
  if (!host.endsWith(".neon.tech") || !isIP(address)) throw new Error("Invalid E2E Neon route");
  const original = dns.lookup.bind(dns);
  dns.lookup = (hostname, options, callback) => {
    if (hostname !== host) return original(hostname, options, callback);
    const fn = typeof options === "function" ? options : callback;
    const family = isIP(address);
    queueMicrotask(() => {
      if (options?.all) fn(null, [{ address, family }]);
      else fn(null, address, family);
    });
  };
}

if (process.env.OTT_E2E_NEON_HOST && process.env.OTT_E2E_NEON_ADDRESS) {
  pinLookup(process.env.OTT_E2E_NEON_HOST, process.env.OTT_E2E_NEON_ADDRESS);
}
