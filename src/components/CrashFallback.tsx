import { useEffect } from "react";

// The window is frameless, undecorated and non-resizable, so a bare message
// leaves the user with no way out but force-quitting from the tray. Reload is
// the one recovery that works from inside the webview. `showDialog` is gone: it
// pulls Sentry's report dialog from their CDN, which script-src 'self' blocks.
export function CrashFallback() {
  // A crash before App signals boot-complete would render this underneath the
  // opaque #boot-loading overlay, leaving "Launching Headroom" up forever.
  // The event removes the overlay (main.tsx) and stops its fake progress.
  useEffect(() => {
    window.dispatchEvent(new CustomEvent("headroom:boot-complete"));
  }, []);

  return (
    <div className="crash-fallback">
      <p>Headroom hit an unexpected error.</p>
      <button type="button" onClick={() => window.location.reload()}>
        Reload
      </button>
    </div>
  );
}
