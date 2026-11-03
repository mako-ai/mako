/**
 * Leave this page for `url`, without a history entry. Its own module so a
 * test can see where a page sends the browser (jsdom cannot navigate, and
 * its `window.location` cannot be spied on).
 */
export function replaceLocation(url: string): void {
  window.location.replace(url);
}
