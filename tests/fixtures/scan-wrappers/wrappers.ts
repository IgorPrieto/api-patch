export function getUser(id: string) {
  return fetch(`/users/${id}`);
}

export default function getUserDefault(id: string) {
  return fetch(`/users/${id}`);
}
