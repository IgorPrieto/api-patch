import axios from 'axios';

const api = axios.create({ baseURL: 'http://127.0.0.1:4010' });

export async function member(): Promise<string> {
  const response = await api.get('/users/42', { params: { locale: 'es' } });
  return response.data.fullName + response.status;
}

export async function health(): Promise<unknown> {
  return api.get('/health');
}

export async function create(): Promise<unknown> {
  return api.post('/users', {
    name: 'Ada',
  });
}
