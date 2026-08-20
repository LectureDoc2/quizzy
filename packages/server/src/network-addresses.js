import os from 'os';

function isLinkLocal(address, family) {
  if (family === 'IPv4') {
    return address.startsWith('169.254.');
  }
  return family === 'IPv6' && /^fe80/i.test(address);
}

/**
 * Returns a list of addresses the server is reachable on.
 *
 * Each entry contains the address family, interface name, raw address and an
 * HTTP URL constructed with the supplied port. Loopback addresses are always
 * included (either from the system or as fallbacks) so the local machine is
 * covered even on stripped-down environments. Link-local addresses are skipped
 * because they are only usable on the immediate local link and usually create
 * noisy output.
 */
export function getServerAddresses(port, interfaces = os.networkInterfaces()) {
  const addresses = [];
  let hasLoopback4 = false;
  let hasLoopback6 = false;

  for (const [name, entries] of Object.entries(interfaces)) {
    for (const entry of entries) {
      if (entry.internal) {
        if (entry.family === 'IPv4') hasLoopback4 = true;
        if (entry.family === 'IPv6') hasLoopback6 = true;
        continue;
      }

      if (isLinkLocal(entry.address, entry.family)) {
        continue;
      }

      if (entry.family === 'IPv4') {
        addresses.push({
          family: 'IPv4',
          interface: name,
          address: entry.address,
          url: `http://${entry.address}:${port}`
        });
      } else if (entry.family === 'IPv6') {
        const scoped = entry.scopeid ? `${entry.address}%${entry.scopeid}` : entry.address;
        addresses.push({
          family: 'IPv6',
          interface: name,
          address: entry.address,
          url: `http://[${scoped}]:${port}`
        });
      }
    }
  }

  if (!hasLoopback4) {
    addresses.unshift({
      family: 'IPv4',
      interface: 'lo',
      address: '127.0.0.1',
      url: `http://127.0.0.1:${port}`
    });
  }
  if (!hasLoopback6) {
    addresses.unshift({
      family: 'IPv6',
      interface: 'lo',
      address: '::1',
      url: `http://[::1]:${port}`
    });
  }

  return addresses;
}
