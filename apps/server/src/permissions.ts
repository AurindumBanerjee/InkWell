export type Role = 'owner' | 'editor' | 'viewer';
export type ShareRole = 'editor' | 'viewer';

const RANK: Record<Role, number> = { viewer: 1, editor: 2, owner: 3 };

/** Highest of the roles a user holds via workspace membership and a direct document share. */
export function effectiveRole(
  workspaceRole: Role | null,
  shareRole: ShareRole | null,
): Role | null {
  const roles = [workspaceRole, shareRole].filter((r): r is Role => r !== null);
  if (roles.length === 0) return null;
  return roles.reduce((a, b) => (RANK[a] >= RANK[b] ? a : b));
}

export const canView = (role: Role | null): boolean => role !== null;
export const canEdit = (role: Role | null): boolean => role === 'editor' || role === 'owner';
/** Managing shares / deleting is owner-only. */
export const canManage = (role: Role | null): boolean => role === 'owner';
