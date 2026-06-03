const BASE_URL = import.meta.env.BASE_URL || '/';

export function publicAssetUrl(path: string): string {
  const normalizedPath = path.replace(/^\/+/, '');
  const baseUrl = new URL(BASE_URL, window.location.origin);
  return new URL(normalizedPath, baseUrl).toString();
}
