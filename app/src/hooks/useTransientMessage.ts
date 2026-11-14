import { useCallback, useEffect, useRef, useState } from "react";

/**
 * A message that clears itself after a delay. Each new message cancels the
 * previous timer (a 5s "invite sent" timer used to wipe a later "link copied"
 * message early), and the timer is cleared on unmount.
 */
export function useTransientMessage() {
  const [message, setMessage] = useState<string | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clear = useCallback(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = null;
    setMessage(null);
  }, []);

  const show = useCallback((next: string, durationMs: number) => {
    if (timerRef.current) clearTimeout(timerRef.current);
    setMessage(next);
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      setMessage(null);
    }, durationMs);
  }, []);

  useEffect(
    () => () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    },
    [],
  );

  return { message, show, clear };
}
