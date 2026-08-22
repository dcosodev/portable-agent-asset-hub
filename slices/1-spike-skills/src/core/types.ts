export type SkillInput = { slug: string; title: string; body: string };
export type SkillVersion = SkillInput & {
  id: string;
  versionId: string;
  version: number;
  head: boolean;
  createdAt: string;
};
export type Resource = { skillId: string; version: number; path: string; bytes: number; sha256: string };
