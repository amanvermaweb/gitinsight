const GITHUB_USERNAME_REGEX = /^[a-z\d](?:[a-z\d]|-(?=[a-z\d])){0,38}$/i;

export function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

export function roundToTenth(value: number) {
  return Math.round(value * 10) / 10;
}

export function seedFromUsername(username: string) {
  return username
    .split("")
    .reduce((sum, char, index) => sum + char.charCodeAt(0) * (index + 11), 0);
}

export function normalizeUsername(input: string) {
  return input.trim().replace(/^@/, "");
}

export function isValidGitHubUsername(username: string) {
  return GITHUB_USERNAME_REGEX.test(username);
}
