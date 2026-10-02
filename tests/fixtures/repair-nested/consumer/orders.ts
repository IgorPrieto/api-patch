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
          city,
          street: street,
        },
      },
    }),
  });
}

export async function createOrderAxios(item: string): Promise<unknown> {
  return axios.post(`${BASE}/orders`, { item, shipping: { address: { 'city': 'Lisbon', street: 'Rua A' } } });
}
