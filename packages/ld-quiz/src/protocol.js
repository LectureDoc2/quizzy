/**
 * The contract between the browser code and the quiz backend.
 *
 * This module is deliberately tiny and dependency-free, because it is the one
 * file that both halves of the system must agree on. It lives inside the
 * publishable component package so that the npm tarball stays self-contained;
 * the server imports it by relative path (see server.js).
 *
 * ## Versioning policy
 *
 * `PROTOCOL_VERSION` describes the *wire format* -- the message types and their
 * payloads -- not the release. It is bumped only when a change would make an
 * older client and a newer server (or the reverse) misbehave, and it is
 * deliberately decoupled from the package version so that a UI-only release
 * does not invalidate every embedded copy in the wild.
 *
 * This matters because the two halves ship on different schedules. A slide deck
 * pins a bundled copy of the component and is re-published when its author feels
 * like it; a Moodle administrator updates their plugin on their own timetable.
 * Without an explicit version, a stale client meets a new server and fails in
 * whatever obscure way the first incompatible field happens to produce.
 *
 * ### Compatibility rules
 *
 * - A client SHOULD send `protocolVersion` on every message that opens a
 *   conversation (`create_room`, `join_room`, `control_connect`, `room_status`).
 * - A server MUST reject a message whose `protocolVersion` it does not speak,
 *   with a `protocol_mismatch` error that names both versions.
 * - A *missing* `protocolVersion` is a mismatch like any other. Nothing predates
 *   this handshake, so there is no population of older clients to accommodate --
 *   and a lenient default would only mean that the first real incompatibility
 *   surfaces as a confusing runtime failure instead of as this error.
 */

/** Current wire-format version. See the versioning policy above. */
export const PROTOCOL_VERSION = 1;

/** Error `type` used for a refused handshake, so clients can special-case it. */
export const PROTOCOL_MISMATCH = 'protocol_mismatch';

/**
 * Whether this side can talk to a peer announcing `version`.
 *
 * Kept as a function rather than an equality check at each call site because
 * the answer will stop being equality the moment a range of versions is
 * supported, and every caller should pick up that change for free.
 *
 * @param {unknown} version The peer's announced version, possibly absent.
 * @returns {boolean}
 */
export function isCompatibleProtocol(version) {
  return version === PROTOCOL_VERSION;
}

/**
 * A message a lecturer can act on, rather than "something went wrong".
 *
 * Names both sides and says who has to move, because the person reading it is
 * usually not the person who can fix it -- a lecturer whose slides embed an old
 * component needs to know that it is the slides, not the server, that are stale.
 *
 * @param {unknown} peerVersion
 * @returns {string}
 */
export function protocolMismatchMessage(peerVersion) {
  const peer = peerVersion === undefined || peerVersion === null
    ? 'no version at all'
    : `version ${peerVersion}`;
  return (
    `Quiz protocol mismatch: this side speaks version ${PROTOCOL_VERSION}, ` +
    `the other side speaks ${peer}. ` +
    'Update whichever of the two is older -- the embedded quiz component or the quiz server.'
  );
}
