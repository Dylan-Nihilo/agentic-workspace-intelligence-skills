import { canAccessAdmin } from '../auth'

export function GuardedButton(permissionIds: string[]) {
  return canAccessAdmin(permissionIds) ? 'enabled' : 'disabled'
}
