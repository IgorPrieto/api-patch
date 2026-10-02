export async function getUser(base, id, locale) {
  const response = await fetch(`${base}/users/${id}?locale=${locale}`);
  if (!response.ok) throw new Error(`getUser HTTP ${response.status}`);
  const user = await response.json();
  return user.fullName;
}

export async function createUser(base, name) {
  const response = await fetch(`${base}/users`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name }),
  });
  if (!response.ok) throw new Error(`createUser HTTP ${response.status}`);
  return (await response.json()).id;
}

export async function health(base) {
  const response = await fetch(`${base}/health`);
  if (!response.ok) throw new Error(`health HTTP ${response.status}`);
  return (await response.json()).ok;
}

export async function preferences(base) {
  const response = await fetch(`${base}/preferences`);
  if (!response.ok) throw new Error(`preferences HTTP ${response.status}`);
  return response.json();
}
