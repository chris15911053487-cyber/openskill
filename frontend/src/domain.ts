// Frontend domain types matching server payloads

export interface Category {
  id: number;
  slug: string;
  name: string;
  description: string | null;
  created_at: string;
  skill_count?: number;
}

export interface Tag {
  id: number;
  slug: string;
  name: string;
  created_at: string;
  skill_count?: number;
}

export type SkillStatus = 'pending' | 'published' | 'rejected';

export interface SkillSummary {
  id: number;
  slug: string;
  name: string;
  description: string;
  readme_excerpt: string | null;
  status: SkillStatus;
  version: string | null;
  subscriber_count: number;
  download_count: number;
  created_at: string;
  updated_at: string;
  published_at: string | null;
  category_slug: string | null;
  category_name: string | null;
  author_id: number;
  author_username: string;
  tags: Array<{ slug: string; name: string }>;
}

export interface SkillDetail extends SkillSummary {
  rejection_reason: string | null;
  file_size: number;
  sha256: string;
}

export interface SkillListResponse {
  items: SkillSummary[];
  total: number;
  page: number;
  limit: number;
  pages: number;
}

export type SortKey = 'newest' | 'popular' | 'downloads' | 'name';
