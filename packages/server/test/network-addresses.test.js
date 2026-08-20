import { describe, it } from 'node:test';
import assert from 'node:assert';
import { getServerAddresses } from '../src/network-addresses.js';

describe('getServerAddresses', () => {
  it('returns loopback fallbacks when no interfaces are present', () => {
    const addresses = getServerAddresses(3000, {});
    assert.deepStrictEqual(addresses, [
      { family: 'IPv6', interface: 'lo', address: '::1', url: 'http://[::1]:3000' },
      { family: 'IPv4', interface: 'lo', address: '127.0.0.1', url: 'http://127.0.0.1:3000' }
    ]);
  });

  it('lists external IPv4 and IPv6 addresses and skips internal ones', () => {
    const interfaces = {
      lo0: [
        { family: 'IPv4', address: '127.0.0.1', internal: true },
        { family: 'IPv6', address: '::1', internal: true }
      ],
      en0: [
        { family: 'IPv4', address: '192.168.1.42', internal: false },
        { family: 'IPv6', address: '2001:db8::1', internal: false, scopeid: 12 }
      ]
    };

    const addresses = getServerAddresses(8080, interfaces);
    assert.deepStrictEqual(addresses, [
      { family: 'IPv4', interface: 'en0', address: '192.168.1.42', url: 'http://192.168.1.42:8080' },
      { family: 'IPv6', interface: 'en0', address: '2001:db8::1', url: 'http://[2001:db8::1%12]:8080' }
    ]);
  });

  it('skips link-local IPv4 and IPv6 addresses', () => {
    const interfaces = {
      eth0: [
        { family: 'IPv4', address: '169.254.1.1', internal: false },
        { family: 'IPv4', address: '10.0.0.5', internal: false },
        { family: 'IPv6', address: 'fe80::1234', internal: false, scopeid: 5 },
        { family: 'IPv6', address: '2001:db8::2', internal: false }
      ]
    };

    const addresses = getServerAddresses(3000, interfaces);
    const addrs = addresses.map(a => a.address);
    assert.ok(!addrs.includes('169.254.1.1'));
    assert.ok(!addrs.includes('fe80::1234'));
    assert.ok(addrs.includes('10.0.0.5'));
    assert.ok(addrs.includes('2001:db8::2'));
  });

  it('uses the provided port in all URLs', () => {
    const interfaces = {
      lo: [
        { family: 'IPv4', address: '127.0.0.1', internal: true },
        { family: 'IPv6', address: '::1', internal: true }
      ],
      eth0: [{ family: 'IPv4', address: '10.0.0.5', internal: false }]
    };
    const addresses = getServerAddresses(1234, interfaces);
    const external = addresses.find(a => a.address === '10.0.0.5');
    assert.ok(external);
    assert.strictEqual(external.url, 'http://10.0.0.5:1234');
  });
});
