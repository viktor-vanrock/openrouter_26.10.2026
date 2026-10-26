import { request } from 'librechat-data-provider';

export interface AdminUser {
  id: string;
  name: string;
  username: string;
  email: string;
  role: string;
  createdAt: string;
  updatedAt: string;
}

export interface AdminRole {
  id: string;
  name: string;
  permissions: Record<string, Record<string, boolean>>;
  createdAt?: string;
}

export interface AdminGroup {
  id: string;
  name: string;
  members: string[];
  createdAt?: string;
}

export interface AdminGrant {
  id: string;
  principalType: string;
  principalId: string;
  capability: string;
  grantedBy?: string;
  tenantId?: string;
  createdAt?: string;
}

export interface AdminConfig {
  [key: string]: unknown;
}

export interface AdminStats {
  totalUsers: number;
  adminUsers: number;
  recentUsers: AdminUser[];
}

export interface PagedUsersResponse {
  users: AdminUser[];
  total: number;
  limit: number;
  offset: number;
}

export interface UsersQueryParams {
  limit?: number;
  offset?: number;
  role?: string;
  q?: string;
}

const BASE = '/api/admin';

const get = <T>(url: string): Promise<T> => request.get<T>(url);
const patch = <T>(url: string, data: unknown): Promise<T> => request.patch(url, data) as Promise<T>;
const post = <T>(url: string, data: unknown): Promise<T> => request.post(url, data) as Promise<T>;
const del = <T>(url: string): Promise<T> => request.delete<T>(url);

export const adminApi = {
  getUsers: (params?: UsersQueryParams): Promise<PagedUsersResponse> => {
    const query = new URLSearchParams();
    if (params?.limit != null) query.set('limit', String(params.limit));
    if (params?.offset != null) query.set('offset', String(params.offset));
    if (params?.role && params.role !== 'ALL') query.set('role', params.role);
    if (params?.q) query.set('q', params.q);
    const qs = query.toString();
    return get<PagedUsersResponse>(`${BASE}/users${qs ? `?${qs}` : ''}`);
  },
  updateUserRole: (id: string, role: string): Promise<AdminUser> =>
    patch<AdminUser>(`${BASE}/users/${id}/role`, { role }),

  getRoles: (): Promise<AdminRole[]> =>
    get<{ roles: AdminRole[] }>(`${BASE}/roles`).then((r) => r.roles),
  updateRole: (name: string, data: Partial<AdminRole>) =>
    patch<AdminRole>(`${BASE}/roles/${encodeURIComponent(name)}`, data),
  deleteRole: (name: string) =>
    del<{ message: string }>(`${BASE}/roles/${encodeURIComponent(name)}`),

  getGroups: (): Promise<AdminGroup[]> =>
    get<{ groups: AdminGroup[] }>(`${BASE}/groups`).then((r) => r.groups),
  createGroup: (data: { name: string }) => post<AdminGroup>(`${BASE}/groups`, data),
  updateGroup: (id: string, data: Partial<AdminGroup>) =>
    patch<AdminGroup>(`${BASE}/groups/${id}`, data),
  deleteGroup: (id: string) => del<{ message: string }>(`${BASE}/groups/${id}`),
  addGroupMember: (groupId: string, userId: string) =>
    post<AdminGroup>(`${BASE}/groups/${groupId}/members`, { userId }),
  removeGroupMember: (groupId: string, userId: string) =>
    del<{ message: string }>(`${BASE}/groups/${groupId}/members/${userId}`),

  getGrants: (): Promise<AdminGrant[]> =>
    get<{ grants: AdminGrant[] }>(`${BASE}/grants`).then((r) => r.grants),
  createGrant: (data: { principalType: string; principalId: string; capability: string }) =>
    post<{ grant: AdminGrant }>(`${BASE}/grants`, data).then((r) => r.grant),
  deleteGrant: (principalType: string, principalId: string, capability: string) =>
    del<{ message: string }>(
      `${BASE}/grants/${principalType}/${principalId}/${encodeURIComponent(capability)}`,
    ),

  getConfig: () => get<AdminConfig>(`${BASE}/config/base`),

  resetUserPassword: (id: string): Promise<{ message?: string; link?: string }> =>
    post<{ message?: string; link?: string }>(`${BASE}/users/${id}/reset-password`, {}),
};
