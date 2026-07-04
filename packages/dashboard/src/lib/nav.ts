/** Navigate the hash router (e.g. go('/'), go('/publish'), go('/agent/@scout')). */
export function go(hash: string): void {
  location.hash = hash;
}
