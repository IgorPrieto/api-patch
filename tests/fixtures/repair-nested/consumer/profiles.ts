import axios from 'axios';

const BASE = 'http://127.0.0.1:4010';

export async function profileCity(id: string): Promise<string> {
  const response = await fetch(`${BASE}/profiles/${id}`);
  const data = await response.json();
  return `${data.fullName} ${data.address.city} ${data?.address?.city} ${data.address.zip}`;
}

export async function profileDestructured(id: string): Promise<string[]> {
  const response = await fetch(`${BASE}/profiles/${id}`);
  const data = await response.json();
  const { fullName } = data;
  const { fullName: n } = data;
  let { fullName: withDefault = 'anonymous' } = data;
  const { address: { city, zip } } = data;
  return [fullName, n, withDefault, city, zip];
}

export async function profileAxios(id: string): Promise<string> {
  const response = await axios.get(`${BASE}/profiles/${id}`);
  return response.data.address.city + response.status;
}
