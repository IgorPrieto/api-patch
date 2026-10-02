const BASE = 'http://127.0.0.1:4010';

export async function getUser(id: string, locale: string): Promise<string> {
  // Comments and formatting around repaired calls must survive.
  const response = await fetch(`${BASE}/users/${id}?locale=${locale}`);
  const user = await response.json();
  return user.fullName;
}

export async function createUser(name: string): Promise<string> {
  const response = await fetch(`${BASE}/users`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name }),
  });
  return (await response.json()).id;
}

export async function preferences(): Promise<unknown> {
  const response = await fetch(`${BASE}/preferences`);
  return response.json();
}
