import axios from 'axios';

export const api = axios.create({ baseURL: 'https://api.example.test/v1' });
