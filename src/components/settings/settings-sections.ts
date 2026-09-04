import {
  Bookmark,
  Coins,
  FileText,
  LifeBuoy,
  Package,
  KeyRound,
  LayoutGrid,
  Palette,
  Shield,
  Tags,
  Type,
  User,
  UsersRound,
  Zap,
  type LucideIcon,
} from 'lucide-react';

/**
 * Settings information architecture for the redesigned page.
 *
 * The flat tab strip became a grouped left rail with a new Overview
 * landing. The URL query param stays `?tab=` (deep-linkable, and it
 * keeps the existing links in sidebar.tsx / header.tsx working) — we
 * just map the old values onto the new sections.
 */
export const SETTINGS_SECTIONS = [
  'overview',
  'profile',
  'security',
  'appearance',
  'catalog',
  'labels',
  'terminology',
  'templates',
  'quick-replies',
  'fields',
  'deals',
  'members',
  'api',
  'support',
] as const;

export type SettingsSection = (typeof SETTINGS_SECTIONS)[number];

export const DEFAULT_SECTION: SettingsSection = 'overview';

/** Rail grouping. `adminOnly` items are hidden for non-admins. */
export interface SectionMeta {
  id: SettingsSection;
  label: string;
  icon: LucideIcon;
  group: 'top' | 'account' | 'workspace';
}

export const SECTION_META: Record<SettingsSection, SectionMeta> = {
  overview: { id: 'overview', label: 'Overview', icon: LayoutGrid, group: 'top' },
  profile: { id: 'profile', label: 'Your profile', icon: User, group: 'account' },
  security: { id: 'security', label: 'Login & security', icon: Shield, group: 'account' },
  appearance: { id: 'appearance', label: 'Appearance', icon: Palette, group: 'account' },
  catalog: { id: 'catalog', label: 'Catalog', icon: Package, group: 'workspace' },
  labels: { id: 'labels', label: 'Lead labels', icon: Bookmark, group: 'workspace' },
  terminology: { id: 'terminology', label: 'Terminology', icon: Type, group: 'workspace' },
  templates: { id: 'templates', label: 'Templates', icon: FileText, group: 'workspace' },
  'quick-replies': { id: 'quick-replies', label: 'Quick replies', icon: Zap, group: 'workspace' },
  fields: { id: 'fields', label: 'Fields & tags', icon: Tags, group: 'workspace' },
  deals: { id: 'deals', label: 'Deals & currency', icon: Coins, group: 'workspace' },
  members: { id: 'members', label: 'Team members', icon: UsersRound, group: 'workspace' },
  api: { id: 'api', label: 'API keys', icon: KeyRound, group: 'workspace' },
  // Last in the rail on purpose: the Altokia team asking to look at
  // this account is rare, and an empty panel here is the healthy state.
  support: { id: 'support', label: 'Altokia support', icon: LifeBuoy, group: 'workspace' },
};

export const RAIL_GROUPS: { label: string | null; group: SectionMeta['group'] }[] = [
  { label: null, group: 'top' },
  { label: 'Account', group: 'account' },
  { label: 'Workspace', group: 'workspace' },
];

function isSection(value: string | null): value is SettingsSection {
  return !!value && (SETTINGS_SECTIONS as readonly string[]).includes(value);
}

/**
 * Resolve a raw `?tab=` value to a section. Legacy tabs from the old
 * flat layout collapse onto their new home (Tags + Custom fields → the
 * merged "Fields & tags" section). Anything unknown falls back to the
 * Overview landing.
 *
 * `whatsapp` is legacy too, for a different reason: connecting the
 * number is Altokia's job, not the customer's, so the panel is gone.
 * The value still arrives — the account menu in the header and the
 * sidebar both link to `?tab=whatsapp`, and customers have the link
 * bookmarked — so it lands on Overview, where a line says who now
 * manages the connection. Listed explicitly rather than left to the
 * fallback so the mapping survives someone tightening that fallback.
 */
export function resolveSection(raw: string | null): SettingsSection {
  if (raw === 'tags' || raw === 'custom-fields') return 'fields';
  if (raw === 'whatsapp') return DEFAULT_SECTION;
  if (isSection(raw)) return raw;
  return DEFAULT_SECTION;
}
