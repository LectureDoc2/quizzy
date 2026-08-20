/**
 * Turning a client address into a key the abuse limits can count against.
 *
 * On IPv4 an address is a reasonable proxy for "one client", so the limits can
 * simply count addresses. On IPv6 that assumption collapses: a single
 * subscriber is normally delegated a whole /64 (often a /56 or /48), and any
 * host inside it can pick a fresh source address per connection at no cost.
 * Counting full IPv6 addresses would therefore make every per-client limit --
 * sockets, rooms, failed lookups -- trivially evadable by an ordinary client on
 * an ordinary connection, without tooling and without spoofing.
 *
 * So IPv6 addresses are bucketed by prefix. The default of /64 matches the
 * smallest block normally delegated to an end site; lower it (say /56) if a
 * deployment hands out larger allocations, at the cost of grouping more
 * unrelated people together.
 */

/** Prefix length used to group IPv6 addresses into one client bucket. */
const DEFAULT_IPV6_PREFIX_BITS = 64;

/**
 * Reduce a raw address to a bare IP: no brackets, no port, no zone index, and
 * with IPv4-mapped IPv6 collapsed to its IPv4 form.
 *
 * Node reports IPv4 peers on a dual-stack listener as `::ffff:203.0.113.7`, so
 * without that last step the same client would occupy two buckets depending on
 * which socket it arrived on.
 *
 * @param {string} raw
 * @returns {string} normalized address, or '' if nothing usable was given
 */
function normalizeAddress(raw) {
  if (typeof raw !== 'string') return '';
  let address = raw.trim();
  if (address === '') return '';

  // "[2001:db8::1]:443" -> "2001:db8::1"
  if (address.startsWith('[')) {
    const end = address.indexOf(']');
    if (end === -1) return '';
    address = address.slice(1, end);
  } else if ((address.match(/:/g) || []).length === 1) {
    // Exactly one colon: an IPv4 address with a port. More than one colon is
    // an IPv6 address, which cannot carry a port without brackets.
    address = address.slice(0, address.indexOf(':'));
  }

  // Drop a zone index such as "fe80::1%en0"; it identifies a local interface,
  // not the peer.
  const zone = address.indexOf('%');
  if (zone !== -1) address = address.slice(0, zone);

  // IPv4-mapped and IPv4-compatible forms.
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(address);
  if (mapped) return mapped[1];

  return address.includes(':') ? address.toLowerCase() : address;
}

/** True for something that looks like a dotted-quad IPv4 address. */
function isIpv4(address) {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(address);
}

/**
 * Expand an IPv6 address to its eight 16-bit groups.
 *
 * @param {string} address
 * @returns {number[]|null} eight groups, or null if it cannot be parsed
 */
function expandIpv6(address) {
  if (!address.includes(':')) return null;

  let text = address;

  // A trailing embedded IPv4 part, e.g. "64:ff9b::192.0.2.33", becomes the
  // final two groups.
  const embedded = /(\d{1,3}(?:\.\d{1,3}){3})$/.exec(text);
  if (embedded) {
    const octets = embedded[1].split('.').map(Number);
    if (octets.some((o) => !Number.isInteger(o) || o < 0 || o > 255)) return null;
    const high = (octets[0] << 8) | octets[1];
    const low = (octets[2] << 8) | octets[3];
    text = text.slice(0, embedded.index) +
      high.toString(16) + ':' + low.toString(16);
  }

  const halves = text.split('::');
  if (halves.length > 2) return null;

  const toGroups = (part) =>
    part === '' ? [] : part.split(':').map((group) => {
      if (!/^[0-9a-f]{1,4}$/i.test(group)) return NaN;
      return parseInt(group, 16);
    });

  const head = toGroups(halves[0]);
  const tail = halves.length === 2 ? toGroups(halves[1]) : [];
  if ([...head, ...tail].some((g) => Number.isNaN(g))) return null;

  if (halves.length === 1) {
    return head.length === 8 ? head : null;
  }

  const missing = 8 - head.length - tail.length;
  if (missing < 0) return null;
  return [...head, ...Array(missing).fill(0), ...tail];
}

/**
 * The key an address is counted under by the abuse limits.
 *
 * IPv4 addresses are used as-is. IPv6 addresses are reduced to their routing
 * prefix, so that rotating through a delegated block counts as one client
 * rather than as billions of them.
 *
 * @param {string} raw
 * @param {{ipv6PrefixBits?: number}} [options]
 * @returns {string} a stable bucket key ('unknown' when nothing is parseable)
 */
function clientKey(raw, options = {}) {
  const { ipv6PrefixBits = DEFAULT_IPV6_PREFIX_BITS } = options;
  const address = normalizeAddress(raw);
  if (address === '') return 'unknown';
  if (isIpv4(address)) return address;

  const groups = expandIpv6(address);
  // Not parseable as either family: fall back to the literal, so an odd value
  // still limits itself rather than sharing the catch-all bucket.
  if (!groups) return address;

  const bits = Math.max(0, Math.min(128, ipv6PrefixBits));
  const kept = [];
  for (let i = 0; i < 8; i++) {
    const bitsBefore = i * 16;
    if (bitsBefore >= bits) break;
    const bitsHere = Math.min(16, bits - bitsBefore);
    const mask = bitsHere === 16 ? 0xffff : (0xffff << (16 - bitsHere)) & 0xffff;
    kept.push((groups[i] & mask).toString(16));
  }
  return `${kept.join(':')}/${bits}`;
}

/**
 * First address in an X-Forwarded-For header, normalized.
 *
 * Proxies vary: some emit a bare address, some emit `[2001:db8::1]:1234`.
 * Only meaningful when the header is actually trusted -- see TRUST_PROXY.
 *
 * @param {string|string[]|undefined} header
 * @returns {string} normalized address, or '' if absent/unusable
 */
function parseForwardedFor(header) {
  const value = Array.isArray(header) ? header[0] : header;
  if (typeof value !== 'string' || value.trim() === '') return '';
  return normalizeAddress(value.split(',')[0]);
}

export {
  clientKey,
  normalizeAddress,
  parseForwardedFor,
  expandIpv6,
  isIpv4,
  DEFAULT_IPV6_PREFIX_BITS
};
