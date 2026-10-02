// Synthetic consumer for local static analysis; do not execute against GitHub.
export async function listSecurityManagers() {
  const response = await fetch('https://api.github.com/orgs/example-org/security-managers/teams');
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}
