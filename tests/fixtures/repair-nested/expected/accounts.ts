const BASE = 'http://127.0.0.1:4010';

export async function accountTown(id: string): Promise<string> {
  const response = await fetch(`${BASE}/people/${id}`);
  const account = await response.json();
  return account.address.town;
}
