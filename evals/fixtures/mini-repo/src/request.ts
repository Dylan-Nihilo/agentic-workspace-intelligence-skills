export function request(path: string) {
  return {
    method: 'GET',
    path,
    headers: {
      Authorization: 'Bearer test-token',
    },
  }
}
