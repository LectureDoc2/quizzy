/**
 * These are pure-function tests on purpose: they assert the address handling
 * that the abuse limits depend on without needing an IPv6 stack, so they run
 * identically on an IPv4-only laptop and on IPv6-only infrastructure.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert';
import { clientKey, normalizeAddress, parseForwardedFor, expandIpv6, isIpv4 } from '../src/client-address.js';

describe('normalizeAddress', () => {
  it('passes plain addresses through', () => {
    assert.strictEqual(normalizeAddress('203.0.113.7'), '203.0.113.7');
    assert.strictEqual(normalizeAddress('2001:db8::1'), '2001:db8::1');
  });

  it('collapses IPv4-mapped IPv6 to IPv4', () => {
    // Node reports IPv4 peers this way on a dual-stack listener; without this
    // the same client would occupy two different buckets.
    assert.strictEqual(normalizeAddress('::ffff:203.0.113.7'), '203.0.113.7');
    assert.strictEqual(normalizeAddress('::FFFF:203.0.113.7'), '203.0.113.7');
  });

  it('strips brackets and ports', () => {
    assert.strictEqual(normalizeAddress('[2001:db8::1]:443'), '2001:db8::1');
    assert.strictEqual(normalizeAddress('[2001:db8::1]'), '2001:db8::1');
    assert.strictEqual(normalizeAddress('203.0.113.7:443'), '203.0.113.7');
  });

  it('does not mistake IPv6 colons for a port separator', () => {
    assert.strictEqual(normalizeAddress('2001:db8::1'), '2001:db8::1');
    assert.strictEqual(normalizeAddress('::1'), '::1');
  });

  it('drops a zone index, which names a local interface rather than the peer', () => {
    assert.strictEqual(normalizeAddress('fe80::1%en0'), 'fe80::1');
  });

  it('lower-cases IPv6 so case cannot split a bucket', () => {
    assert.strictEqual(normalizeAddress('2001:DB8::AB'), '2001:db8::ab');
  });

  it('handles junk without throwing', () => {
    for (const input of ['', '   ', undefined, null, 42, '[unterminated']) {
      assert.strictEqual(normalizeAddress(input), '');
    }
  });
});

describe('expandIpv6', () => {
  it('expands compressed forms to eight groups', () => {
    assert.deepStrictEqual(expandIpv6('::1'), [0, 0, 0, 0, 0, 0, 0, 1]);
    assert.deepStrictEqual(expandIpv6('2001:db8::1'), [0x2001, 0xdb8, 0, 0, 0, 0, 0, 1]);
    assert.deepStrictEqual(
      expandIpv6('2001:db8:0:0:0:0:0:0'),
      [0x2001, 0xdb8, 0, 0, 0, 0, 0, 0]
    );
  });

  it('handles an embedded IPv4 tail', () => {
    assert.deepStrictEqual(expandIpv6('64:ff9b::192.0.2.33'), [0x64, 0xff9b, 0, 0, 0, 0, 0xc000, 0x221]);
  });

  it('rejects malformed input rather than guessing', () => {
    for (const input of ['2001:db8::1::2', 'nonsense', '2001:zzzz::1', '1:2:3:4:5:6:7']) {
      assert.strictEqual(expandIpv6(input), null, `should reject ${input}`);
    }
  });
});

describe('clientKey', () => {
  it('uses an IPv4 address as its own bucket', () => {
    assert.strictEqual(clientKey('203.0.113.7'), '203.0.113.7');
    assert.strictEqual(clientKey('::ffff:203.0.113.7'), '203.0.113.7');
  });

  it('groups an entire IPv6 /64 into one bucket', () => {
    // This is the point of the module. A client holding a /64 can pick a new
    // source address per connection, so counting addresses would let anyone
    // reset every limit at will.
    const a = clientKey('2001:db8:1:2:aaaa:bbbb:cccc:dddd');
    const b = clientKey('2001:db8:1:2:1111:2222:3333:4444');
    const c = clientKey('2001:db8:1:2::1');
    assert.strictEqual(a, b);
    assert.strictEqual(a, c);
    assert.strictEqual(a, '2001:db8:1:2/64');
  });

  it('keeps genuinely different prefixes apart', () => {
    assert.notStrictEqual(
      clientKey('2001:db8:1:2::1'),
      clientKey('2001:db8:1:3::1')
    );
  });

  it('honours a configurable prefix width, including partial groups', () => {
    assert.strictEqual(clientKey('2001:db8:1:2::1', { ipv6PrefixBits: 48 }), '2001:db8:1/48');
    assert.strictEqual(clientKey('2001:db8:1:2::1', { ipv6PrefixBits: 32 }), '2001:db8/32');
    // /56 masks the middle of the fourth group.
    assert.strictEqual(clientKey('2001:db8:1:2ff::1', { ipv6PrefixBits: 56 }), '2001:db8:1:200/56');
    assert.strictEqual(
      clientKey('2001:db8:1:2ff::1', { ipv6PrefixBits: 56 }),
      clientKey('2001:db8:1:2aa::9', { ipv6PrefixBits: 56 })
    );
  });

  it('never collapses everything into one bucket by accident', () => {
    const keys = new Set([
      clientKey('2001:db8:1:1::1'),
      clientKey('2001:db8:1:2::1'),
      clientKey('203.0.113.7'),
      clientKey('203.0.113.8')
    ]);
    assert.strictEqual(keys.size, 4);
  });

  it('buckets loopback consistently on either family', () => {
    assert.strictEqual(clientKey('127.0.0.1'), '127.0.0.1');
    assert.strictEqual(clientKey('::1'), '0:0:0:0/64');
    assert.strictEqual(clientKey('[::1]:5050'), clientKey('::1'));
  });

  it('falls back to a self-consistent key for unparseable input', () => {
    assert.strictEqual(clientKey(undefined), 'unknown');
    assert.strictEqual(clientKey(''), 'unknown');
    // Anything unrecognizable still limits itself rather than joining a shared
    // catch-all bucket that everyone else could hide in.
    assert.strictEqual(clientKey('weird-value'), 'weird-value');
  });
});

describe('parseForwardedFor', () => {
  it('takes the first entry of the chain', () => {
    assert.strictEqual(parseForwardedFor('203.0.113.7, 198.51.100.1'), '203.0.113.7');
    assert.strictEqual(parseForwardedFor('2001:db8::1, 2001:db8::2'), '2001:db8::1');
  });

  it('accepts the bracketed form some proxies emit', () => {
    assert.strictEqual(parseForwardedFor('[2001:db8::1]:1234, 198.51.100.1'), '2001:db8::1');
  });

  it('returns nothing usable for an absent or empty header', () => {
    for (const header of [undefined, '', '   ', []]) {
      assert.strictEqual(parseForwardedFor(header), '');
    }
  });

  it('handles the array form node can produce', () => {
    assert.strictEqual(parseForwardedFor(['2001:db8::1']), '2001:db8::1');
  });
});

describe('isIpv4', () => {
  it('recognizes dotted quads only', () => {
    assert.strictEqual(isIpv4('203.0.113.7'), true);
    assert.strictEqual(isIpv4('2001:db8::1'), false);
    assert.strictEqual(isIpv4('::ffff:203.0.113.7'), false);
  });
});

describe('loopbackHost (test infrastructure)', () => {
  it('picks IPv6 loopback when the host has no IPv4', async () => {
    // The target infrastructure is IPv6-only. Binding to 127.0.0.1 there fails
    // with EADDRNOTAVAIL, which would make the whole suite unrunnable.
    const { loopbackHost, hostForUrl, originFor } = await import('./loopback.js');
    const ipv6Only = { lo0: [{ family: 'IPv6', address: '::1', internal: true }] };
    assert.strictEqual(loopbackHost(ipv6Only), '::1');
    assert.strictEqual(hostForUrl('::1'), '[::1]');
    assert.strictEqual(originFor('ws', '::1', 8080), 'ws://[::1]:8080');
  });

  it('prefers IPv4 loopback on a dual-stack host', async () => {
    const { loopbackHost, originFor } = await import('./loopback.js');
    const dual = {
      lo0: [
        { family: 'IPv4', address: '127.0.0.1', internal: true },
        { family: 'IPv6', address: '::1', internal: true }
      ]
    };
    assert.strictEqual(loopbackHost(dual), '127.0.0.1');
    assert.strictEqual(originFor('http', '127.0.0.1', 80), 'http://127.0.0.1:80');
  });

  it('tolerates the numeric family that newer node versions report', async () => {
    const { loopbackHost } = await import('./loopback.js');
    assert.strictEqual(loopbackHost({ lo0: [{ family: 6, address: '::1', internal: true }] }), '::1');
  });

  it('lets the OS choose when nothing is enumerable', async () => {
    const { loopbackHost } = await import('./loopback.js');
    assert.strictEqual(loopbackHost({}), undefined);
  });
});
