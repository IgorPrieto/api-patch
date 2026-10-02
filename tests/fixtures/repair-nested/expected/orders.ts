import axios from 'axios';

const BASE = 'http://127.0.0.1:4010';

export async function createOrder(item: string, city: string, street: string): Promise<Response> {
  // Nested body edited in place; this comment must survive.
  return fetch(`${BASE}/orders`, {
    method: 'POST',
    body: JSON.stringify({
      item,
      shipping: {
        address: {
          town: city,
          street: street,
          country: 'ES',
        },
      },
    }),
  });
}

export async function createOrderAxios(item: string): Promise<unknown> {
  return axios.post(`${BASE}/orders`, { item, shipping: { address: { 'town': 'Lisbon', street: 'Rua A', country: 'ES' } } });
}
