export function canAccessAdmin(permissionIds: string[]) {
  return permissionIds.includes('admin')
}
