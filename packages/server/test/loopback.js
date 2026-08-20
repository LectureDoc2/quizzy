/**
 * Loopback address selection for tests.
 *
 * Hardcoding 127.0.0.1 makes the suite unrunnable on IPv6-only infrastructure:
 * `listen(0, '127.0.0.1')` fails there with EADDRNOTAVAIL. Picking the family
 * that the host actually has, and using the *same* literal to bind and to
 * connect, keeps the tests working on either.
 */
import os from 'os';

/** Loopback literal for binding: '::1' where IPv6 exists, else '127.0.0.1'. */
export function loopbackHost(interfaces = os.networkInterfaces()) {
  const internal = Object.values(interfaces)
    .flat()
    .filter((entry) => entry && entry.internal);
  const hasIpv6 = internal.some((entry) => entry.family === 'IPv6' || entry.family === 6);
  const hasIpv4 = internal.some((entry) => entry.family === 'IPv4' || entry.family === 4);
  if (hasIpv4) return '127.0.0.1';
  if (hasIpv6) return '::1';
  // Nothing enumerable: let the OS choose rather than guessing wrong.
  return undefined;
}

/** Wrap an IPv6 literal in brackets so it can go into a URL authority. */
export function hostForUrl(host) {
  const value = host === undefined ? '127.0.0.1' : host;
  return value.includes(':') ? `[${value}]` : value;
}

/** Convenience: "http://[::1]:1234" / "ws://127.0.0.1:1234". */
export function originFor(scheme, host, port) {
  return `${scheme}://${hostForUrl(host)}:${port}`;
}
