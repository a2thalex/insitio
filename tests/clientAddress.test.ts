import { describe, it, expect } from "vitest";
import { addressBucket, clientAddress } from "../src/clientAddress.js";
import { loadConfig } from "../src/config.js";

const LOOPBACK = ["127.0.0.1", "::1"];

describe("addressBucket", () => {
  it("keeps IPv4 addresses (and the unknown placeholder) as they are", () => {
    expect(addressBucket("203.0.113.9")).toBe("203.0.113.9");
    expect(addressBucket("unknown")).toBe("unknown");
  });

  it("turns an IPv4-mapped IPv6 address into the IPv4 address", () => {
    expect(addressBucket("::ffff:203.0.113.9")).toBe("203.0.113.9");
    expect(addressBucket("::FFFF:cb00:7109")).toBe("203.0.113.9");
    expect(addressBucket("0:0:0:0:0:ffff:cb00:7109")).toBe("203.0.113.9");
  });

  it("buckets IPv6 addresses by /64, however they are written", () => {
    const bucket = addressBucket("2001:db8:1:2::1");
    expect(addressBucket("2001:db8:1:2:aaaa:bbbb:cccc:dddd")).toBe(bucket);
    expect(addressBucket("2001:0DB8:0001:0002:0:0:0:99")).toBe(bucket);
    expect(addressBucket("2001:db8:1:2::")).toBe(bucket);
    expect(addressBucket("2001:db8:1:2::1%eth0")).toBe(bucket);
    expect(addressBucket("2001:db8:1:3::1")).not.toBe(bucket);
    expect(addressBucket("2001:db8:2:2::1")).not.toBe(bucket);
    expect(addressBucket("2001:db9:1:2::1")).not.toBe(bucket);
  });

  it("copes with :: covering part of the /64 prefix", () => {
    expect(addressBucket("2001:db8::1")).toBe(addressBucket("2001:db8:0:0:7::2"));
    expect(addressBucket("2001:db8::1")).not.toBe(addressBucket("2001:db8:0:1::1"));
    expect(addressBucket("::1")).toBe(addressBucket("0:0:0:0:9::"));
    expect(addressBucket("::")).toBe(addressBucket("::1"));
  });

  it("never collides an IPv6 bucket with an IPv4 address", () => {
    expect(addressBucket("2001:db8:1:2::1")).not.toMatch(/^\d+\.\d+\.\d+\.\d+$/);
  });

  it("passes anything that is not an address through unchanged", () => {
    expect(addressBucket("not-an-address")).toBe("not-an-address");
    expect(addressBucket("1:2:3:4:5:6:7:8:9")).toBe("1:2:3:4:5:6:7:8:9");
    expect(addressBucket("1::2::3")).toBe("1::2::3");
    expect(addressBucket("")).toBe("");
  });
});

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
