import { describe, it, expect } from "vitest";
import { clientAddress } from "../src/clientAddress.js";
import { loadConfig } from "../src/config.js";

const LOOPBACK = ["127.0.0.1", "::1"];

describe("clientAddress", () => {
  it("ignores X-Forwarded-For from untrusted peers", () => {
    expect(clientAddress("203.0.113.9", "1.2.3.4", LOOPBACK)).toBe("203.0.113.9");
    expect(clientAddress("203.0.113.9", "1.2.3.4", [])).toBe("203.0.113.9");
  });

  it("takes the right-most untrusted hop when the peer is a trusted proxy", () => {
    expect(clientAddress("127.0.0.1", "198.51.100.7", LOOPBACK)).toBe("198.51.100.7");
    // A client can prepend anything; only the hop the proxy appended counts.
    expect(clientAddress("127.0.0.1", "1.1.1.1, 198.51.100.7", LOOPBACK)).toBe("198.51.100.7");
    expect(clientAddress("::ffff:127.0.0.1", "198.51.100.7", LOOPBACK)).toBe("198.51.100.7");
  });

  it("falls back to the peer when every hop is a proxy or the header is missing", () => {
    expect(clientAddress("127.0.0.1", "127.0.0.1", LOOPBACK)).toBe("127.0.0.1");
    expect(clientAddress("127.0.0.1", undefined, LOOPBACK)).toBe("127.0.0.1");
    expect(clientAddress(undefined, "1.2.3.4", LOOPBACK)).toBe("unknown");
  });
});

describe("proxy config", () => {
  it("binds to loopback and trusts it when TRUST_PROXY is on", () => {
    expect(loadConfig({ TRUST_PROXY: "1" })).toMatchObject({ trustedProxies: LOOPBACK, host: "127.0.0.1" });
    expect(loadConfig({ TRUST_PROXY: "10.0.0.2, 10.0.0.3" }).trustedProxies).toEqual(["10.0.0.2", "10.0.0.3"]);
    expect(loadConfig({})).toMatchObject({ trustedProxies: [], host: undefined });
    expect(loadConfig({ TRUST_PROXY: "1", HOST: "0.0.0.0" }).host).toBe("0.0.0.0");
  });
});
