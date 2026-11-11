/**
 * A list the participant puts in order: the answer to an ordering question.
 *
 * An item moves by dragging its handle, by dragging the item itself with a
 * mouse, or by its ↑/↓ buttons. The order is the DOM order of the list's
 * children and nothing else, so there is no second copy of it to fall out of
 * step: whatever interrupts a drag -- a cancelled touch, a lost pointer
 * capture, the page going inert while it reconnects, the question being
 * replaced -- leaves a list that is in *some* order, and that order is what is
 * submitted.
 *
 * Expected markup (see quiz-client.js):
 *
 *   <ol class="ordering">
 *     <li class="ordering__item" data-index="2">
 *       <span class="ordering__handle"></span>
 *       ...content...
 *       <button data-move="-1">↑</button> <button data-move="1">↓</button>
 *     </li>
 *   </ol>
 *
 * Why it is built the way it is, because each of these is a way such lists
 * fail on some device:
 *
 * - Pointer Events only, never the HTML5 drag-and-drop API, which does not
 *   work with touch on iOS and is unreliable on Android. One code path for
 *   mouse, touch and pen.
 * - Touch drags start on the handle only, which has `touch-action: none` in
 *   CSS; the rest of an item scrolls the page as usual. No long-press timers,
 *   and no guessing whether a swipe was meant to scroll or to drag.
 * - The dragged item itself never moves in the DOM -- its neighbours are moved
 *   around it. Removing an element that holds the pointer capture, even for
 *   the instant of an insertBefore(), releases the capture in some browsers
 *   and ends the drag mid-gesture.
 * - Positions are computed from offsetTop, which ignores transforms, so the
 *   neighbours' slide animations never feed back into where things are.
 * - The buttons always work, with any input, and are the way in for keyboard
 *   and screen-reader users.
 */

/** How close to the top or bottom of the viewport a drag starts to scroll. */
const AUTO_SCROLL_EDGE = 56; // px
const AUTO_SCROLL_MAX_SPEED = 18; // px per frame, at the very edge
/** How far a mouse must move before a press on an item becomes a drag. */
const MOUSE_DRAG_THRESHOLD = 4; // px
const SLIDE_MS = 150;

const reducedMotion = () =>
  typeof window.matchMedia === 'function' &&
  window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/**
 * @param {HTMLElement} list
 * @param {object} [options]
 * @param {(item: HTMLElement, position: number, total: number) => void} [options.onMove]
 *   called after an item was moved to a new position (0-based), by a drag or a
 *   button; for announcing the move.
 * @returns {{ order: () => number[], setOrder: (order: number[]) => void }}
 *   `order()` is the items' data-index values in their current order;
 *   `setOrder()` puts the items in such an order again (an answer given
 *   before a reload), without animation and without calling onMove.
 */
export function attachSortable(list, { onMove } = {}) {
  const items = () => Array.from(list.children);
  /** item -> its running slide animation, so a new one can replace it */
  const slides = new WeakMap();
  /** The gesture in progress, or null. See onPointerDown(). */
  let drag = null;

  function updateButtons() {
    const all = items();
    all.forEach((item, position) => {
      const up = item.querySelector('[data-move="-1"]');
      const down = item.querySelector('[data-move="1"]');
      if (up) up.disabled = position === 0;
      if (down) down.disabled = position === all.length - 1;
    });
  }

  function slide(item, keyframes) {
    slides.get(item)?.cancel();
    const animation = item.animate(keyframes, { duration: SLIDE_MS, easing: 'ease-out' });
    slides.set(item, animation);
    return animation;
  }

  /**
   * Runs `mutate`, which reorders the list, then slides each item but
   * `except` from where it was drawn to where it now is (FLIP).
   */
  function reorder(mutate, except = null) {
    const animate = !reducedMotion() && typeof list.animate === 'function';
    const drawnAt = new Map();
    if (animate) {
      for (const item of items()) {
        if (item !== except) drawnAt.set(item, item.getBoundingClientRect().top);
      }
    }
    mutate();
    if (!animate) return;
    for (const [item, top] of drawnAt) {
      slides.get(item)?.cancel();
      const delta = top - item.getBoundingClientRect().top;
      if (Math.abs(delta) >= 1) {
        slide(item, [{ transform: `translateY(${delta}px)` }, { transform: 'none' }]);
      }
    }
  }

  // --- dragging ------------------------------------------------------------

  function onPointerDown(event) {
    if (drag || !event.isPrimary || event.button !== 0) return;
    const item = event.target.closest?.('.ordering__item');
    if (!item || item.parentElement !== list) return;
    if (event.target.closest('button, a, input, select, textarea, summary')) return;
    const onHandle = event.target.closest('.ordering__handle') !== null;
    // A touch on the item's body scrolls the page; only the handle drags.
    if (!onHandle && event.pointerType !== 'mouse') return;

    event.preventDefault(); // no text selection, no focus change
    drag = {
      pointerId: event.pointerId,
      item,
      startX: event.clientX,
      startY: event.clientY,
      lastY: event.clientY,
      active: false,
      offset: 0,
      startPosition: -1,
      grabOffset: 0,
      scrollFrame: 0
    };
    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerEnd);
    window.addEventListener('pointercancel', onPointerEnd);
    window.addEventListener('lostpointercapture', onLostCapture);
    window.addEventListener('blur', finish);
    window.addEventListener('scroll', onScroll, { passive: true });
    // A mouse press might still be a click; the handle means "drag".
    if (onHandle) begin();
  }

  function begin() {
    const { item } = drag;
    slides.get(item)?.cancel();
    drag.active = true;
    drag.startPosition = items().indexOf(item);
    // Where on the item it was grabbed, in list coordinates.
    drag.grabOffset = drag.startY - list.getBoundingClientRect().top - item.offsetTop;
    try {
      item.setPointerCapture(drag.pointerId);
    } catch {
      // The pointer is already gone; the pointerup listener ends the drag.
    }
    item.classList.add('ordering__item--dragging');
    list.classList.add('ordering--dragging');
    follow();
    drag.scrollFrame = requestAnimationFrame(autoScroll);
  }

  /** Draws the dragged item under the pointer, and moves its neighbours. */
  function follow() {
    const { item } = drag;
    const height = item.offsetHeight;
    // Kept within reach of the list, wherever the pointer goes.
    const top = Math.min(
      Math.max(drag.lastY - list.getBoundingClientRect().top - drag.grabOffset, -height / 2),
      list.offsetHeight - height / 2
    );
    const center = top + height / 2;
    // Each step moves the item one place, so this ends; and a neighbour once
    // passed has moved by a whole item, so it cannot be passed back at once.
    for (;;) {
      const prev = item.previousElementSibling;
      const next = item.nextElementSibling;
      if (prev && center < prev.offsetTop + prev.offsetHeight / 2) {
        reorder(() => list.insertBefore(prev, item.nextElementSibling), item);
      } else if (next && center > next.offsetTop + next.offsetHeight / 2) {
        reorder(() => list.insertBefore(next, item), item);
      } else {
        break;
      }
    }
    drag.offset = top - item.offsetTop;
    item.style.transform = `translateY(${drag.offset}px)`;
  }

  function onPointerMove(event) {
    if (!drag || event.pointerId !== drag.pointerId) return;
    // Replaced, or made inert while reconnecting: stop where it is.
    if (!list.isConnected || list.closest('[inert]')) {
      finish();
      return;
    }
    drag.lastY = event.clientY;
    if (!drag.active) {
      const moved = Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY);
      if (moved >= MOUSE_DRAG_THRESHOLD) begin();
      return;
    }
    follow();
  }

  function onPointerEnd(event) {
    if (drag && event.pointerId === drag.pointerId) finish();
  }

  /**
   * Only the item's own capture ending ends the drag. A touch is implicitly
   * captured by the handle it started on, and begin() taking the capture over
   * for the item makes the *handle* lose it -- which is not an ending.
   */
  function onLostCapture(event) {
    if (drag?.active && event.pointerId === drag.pointerId && event.target === drag.item) finish();
  }

  /** The page scrolled under a resting pointer: the item stays with it. */
  function onScroll() {
    if (drag?.active && list.isConnected) follow();
  }

  /** Scrolls the page while the pointer is near its top or bottom edge. */
  function autoScroll() {
    if (!drag?.active) return;
    if (!list.isConnected) {
      finish();
      return;
    }
    const y = drag.lastY;
    const bottom = window.innerHeight - AUTO_SCROLL_EDGE;
    let speed = 0;
    if (y < AUTO_SCROLL_EDGE) {
      speed = -Math.ceil(AUTO_SCROLL_MAX_SPEED * Math.min(1, (AUTO_SCROLL_EDGE - y) / AUTO_SCROLL_EDGE));
    } else if (y > bottom) {
      speed = Math.ceil(AUTO_SCROLL_MAX_SPEED * Math.min(1, (y - bottom) / AUTO_SCROLL_EDGE));
    }
    if (speed !== 0) window.scrollBy(0, speed); // the scroll event calls follow()
    drag.scrollFrame = requestAnimationFrame(autoScroll);
  }

  /** Ends the gesture, leaving the item where it is. Safe to call twice. */
  function finish() {
    if (!drag) return;
    const { item, active, offset, startPosition, pointerId, scrollFrame } = drag;
    drag = null; // first: releasing the capture below re-enters through lostpointercapture
    window.removeEventListener('pointermove', onPointerMove);
    window.removeEventListener('pointerup', onPointerEnd);
    window.removeEventListener('pointercancel', onPointerEnd);
    window.removeEventListener('lostpointercapture', onLostCapture);
    window.removeEventListener('blur', finish);
    window.removeEventListener('scroll', onScroll);
    if (!active) return;

    cancelAnimationFrame(scrollFrame);
    try {
      if (item.hasPointerCapture(pointerId)) item.releasePointerCapture(pointerId);
    } catch {
      // Already released.
    }
    item.style.transform = '';
    list.classList.remove('ordering--dragging');
    if (!reducedMotion() && typeof item.animate === 'function' && Math.abs(offset) >= 1) {
      // Settles into its place, still above its neighbours while it does.
      const settle = slide(item, [{ transform: `translateY(${offset}px)` }, { transform: 'none' }]);
      const lower = () => item.classList.remove('ordering__item--dragging');
      settle.addEventListener('finish', lower);
      settle.addEventListener('cancel', lower);
    } else {
      item.classList.remove('ordering__item--dragging');
    }

    updateButtons();
    const position = items().indexOf(item);
    if (position !== startPosition && position !== -1) {
      onMove?.(item, position, list.children.length);
    }
  }

  // --- buttons ---------------------------------------------------------------

  function onClick(event) {
    const button = event.target.closest?.('button[data-move]');
    if (!button || drag?.active) return;
    const item = button.closest('.ordering__item');
    if (!item || item.parentElement !== list) return;
    const step = Number(button.dataset.move);
    // The neighbour moves, not the item: the item holds the focused button,
    // and taking it out of the document would drop the focus.
    if (step < 0 && item.previousElementSibling) {
      const prev = item.previousElementSibling;
      reorder(() => list.insertBefore(prev, item.nextElementSibling));
    } else if (step > 0 && item.nextElementSibling) {
      const next = item.nextElementSibling;
      reorder(() => list.insertBefore(next, item));
    } else {
      return;
    }
    updateButtons();
    // At the top (or bottom) the button just used is disabled now; keep the
    // keyboard on the item rather than losing it to the page.
    if (button.disabled) item.querySelector(`[data-move="${-step}"]`)?.focus();
    item.scrollIntoView?.({ block: 'nearest' });
    onMove?.(item, items().indexOf(item), list.children.length);
  }

  list.addEventListener('pointerdown', onPointerDown);
  list.addEventListener('click', onClick);
  // A long press on the handle is a drag, not a context menu (Android) or a
  // native drag of an image or link inside an item (desktop).
  list.addEventListener('contextmenu', (event) => {
    if (drag || event.target.closest?.('.ordering__handle')) event.preventDefault();
  });
  list.addEventListener('dragstart', (event) => event.preventDefault());
  // Belt and braces for touch-action: should a browser still try to scroll
  // during a drag, it is told not to. Not passive, or it could not.
  list.addEventListener('touchmove', (event) => {
    if (drag?.active) event.preventDefault();
  }, { passive: false });

  updateButtons();

  return {
    order: () => items().map((item) => Number(item.dataset.index)),
    setOrder(order) {
      if (drag || !Array.isArray(order)) return;
      const byIndex = new Map(items().map((item) => [Number(item.dataset.index), item]));
      // Only a complete order: a partial one would leave the rest wherever
      // they happened to be, an order nobody chose.
      if (order.length !== byIndex.size || new Set(order).size !== order.length ||
        !order.every((index) => byIndex.has(index))) return;
      for (const index of order) list.appendChild(byIndex.get(index));
      updateButtons();
    }
  };
}
