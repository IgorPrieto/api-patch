// Synthetic consumer of the APIPatch demo API. URLs are relative literals: the API is
// same-origin, so the host (browser page or the demo's Node harness) supplies the origin.

export async function getUser(id, locale) {
  const response = await fetch(`/users/${id}?locale=${locale}`);
  if (!response.ok) throw new Error(`getUser HTTP ${response.status}`);
  const user = await response.json();
  return user.fullName;
}

export async function createUser(name) {
  const response = await fetch('/users', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name }),
  });
  if (!response.ok) throw new Error(`createUser HTTP ${response.status}`);
  const created = await response.json();
  return created.id;
}

export async function health() {
  const response = await fetch('/health');
  if (!response.ok) throw new Error(`health HTTP ${response.status}`);
  const status = await response.json();
  return status.ok;
}

export async function preferences() {
  const response = await fetch('/preferences');
  if (!response.ok) throw new Error(`preferences HTTP ${response.status}`);
  const prefs = await response.json();
  return prefs.theme;
}
