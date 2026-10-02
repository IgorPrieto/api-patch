import { getUser } from './wrappers.js';

// Not itself a recognized wrapper: its body calls another wrapper, not fetch/axios directly.
export const getUserB = (id: string) => getUser(id);
