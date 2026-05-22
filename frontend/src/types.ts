// Shared frontend types

export type Role = 'admin' | 'user';

export interface User {
  id: number;
  username: string;
  email: string;
  role: Role;
  created_at: string;
}

export type ViewName =
  | 'login'
  | 'register'
  | 'catalog'
  | 'skill-detail'
  | 'my-subscriptions'
  | 'upload'
  | 'my-uploads'
  | 'chat'
  | 'admin-review'
  | 'admin-users'
  | 'admin-categories'
  | 'admin-tags'
  | 'admin-stats';

export interface ApiError {
  error: string;
  code: string;
  detail?: unknown;
}

export interface AuthResponse {
  token: string;
  user: User;
}
