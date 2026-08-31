# RinkRat Angular Client Instructions

These instructions supplement the root AGENTS.md.

- The browser displays and requests actions; it is not competitive authority.
- Reuse existing shared services and subscriptions.
- Do not create duplicate Firestore listeners.
- Unsubscribe or destroy every route-owned listener.
- Keep initial route loading bounded and progressive.
- Preserve mobile layouts at 320px, 390px, 430px, tablet, and desktop widths.
- Test Rink Dark, Light Ice, and OLED Black.
- Preserve keyboard, focus, zoom, reduced-motion, and screen-reader behavior.
- Show authoritative server completion rather than assuming a callable
  response means the write succeeded.
- Stale tabs and offline clients must not submit ambiguous competitive actions.