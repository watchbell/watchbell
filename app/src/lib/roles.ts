export const ROLES = ["owner", "operator", "viewer"] as const;
export type Role = (typeof ROLES)[number];

const RANK: Record<Role, number> = { viewer: 0, operator: 1, owner: 2 };

export function hasRole(actual: Role, min: Role): boolean {
  return RANK[actual] >= RANK[min];
}
