import {
  AlertTriangle,
  Archive,
  CalendarDays,
  ClipboardCheck,
  Database,
  GitBranch,
  Gauge,
  ImagePlus,
  Inbox,
  KeyRound,
  LayoutDashboard,
  ListChecks,
  Map as MapIcon,
  Megaphone,
  RadioTower,
  ScrollText,
  ShieldCheck,
  UserRound,
  Users,
  Workflow,
  type LucideIcon,
} from 'lucide-react';

export const LOCATION_TABS = ['capture', 'submissions', 'questions', 'maps', 'checks', 'daily', 'transfer', 'operations'] as const;
export type LocationTab = (typeof LOCATION_TABS)[number];
export const CARD_TABS = ['careers', 'reviews', 'graphs'] as const;
export type CardTab = (typeof CARD_TABS)[number];

export type AdminSection =
  | 'dashboard'
  | 'users'
  | 'guests'
  | 'reports'
  | 'players'
  | 'player-changes'
  | 'location'
  | 'card-link'
  | 'announcements'
  | 'api-tokens'
  | 'resources';

/** Pending-work counters shown as sidebar badges and dashboard cards. */
export type CountKey = 'reports' | 'changes' | 'submissions' | 'careers';

export interface NavItem {
  /** Unique id; also the route below /admin. */
  id: string;
  section: AdminSection;
  tab?: string;
  label: string;
  description: string;
  icon: LucideIcon;
  badge?: CountKey;
}

export interface NavGroup {
  id: string;
  label: string;
  /** Long tool groups fold away when the current page is elsewhere. */
  collapsible?: boolean;
  items: NavItem[];
}

const item = (id: string, section: AdminSection, key: string, icon: LucideIcon, extra: Partial<NavItem> = {}): NavItem => ({
  id,
  section,
  label: `adminUi.nav${key}`,
  description: `adminUi.desc${key}`,
  icon,
  ...extra,
});

export const NAV_GROUPS: NavGroup[] = [
  { id: 'overview', label: 'adminUi.groupOverview', items: [item('', 'dashboard', 'Dashboard', LayoutDashboard)] },
  {
    id: 'accounts',
    label: 'adminUi.groupAccounts',
    items: [
      item('users', 'users', 'Users', Users),
      item('guests', 'guests', 'Guests', UserRound),
      item('reports', 'reports', 'Reports', AlertTriangle, { badge: 'reports' }),
    ],
  },
  {
    id: 'players',
    label: 'adminUi.groupPlayers',
    items: [
      item('players', 'players', 'Players', Database),
      item('player-changes', 'player-changes', 'PlayerChanges', ClipboardCheck, { badge: 'changes' }),
    ],
  },
  {
    id: 'location',
    label: 'adminUi.groupLocation',
    collapsible: true,
    items: [
      item('location/capture', 'location', 'LocationCapture', ImagePlus, { tab: 'capture' }),
      item('location/submissions', 'location', 'LocationSubmissions', Inbox, { tab: 'submissions', badge: 'submissions' }),
      item('location/questions', 'location', 'LocationQuestions', ListChecks, { tab: 'questions' }),
      item('location/maps', 'location', 'LocationMaps', MapIcon, { tab: 'maps' }),
      item('location/checks', 'location', 'LocationChecks', ShieldCheck, { tab: 'checks' }),
      item('location/daily', 'location', 'LocationDaily', CalendarDays, { tab: 'daily' }),
      item('location/transfer', 'location', 'LocationTransfer', Archive, { tab: 'transfer' }),
      item('location/operations', 'location', 'LocationOperations', Gauge, { tab: 'operations' }),
    ],
  },
  {
    id: 'card-link',
    label: 'adminUi.groupCard',
    collapsible: true,
    items: [
      item('card-link/careers', 'card-link', 'CardCareers', ScrollText, { tab: 'careers' }),
      item('card-link/reviews', 'card-link', 'CardReviews', Workflow, { tab: 'reviews', badge: 'careers' }),
      item('card-link/graphs', 'card-link', 'CardGraphs', GitBranch, { tab: 'graphs' }),
    ],
  },
  {
    id: 'system',
    label: 'adminUi.groupSystem',
    items: [
      item('announcements', 'announcements', 'Announcements', Megaphone),
      item('api-tokens', 'api-tokens', 'ApiTokens', KeyRound),
      item('resources', 'resources', 'Resources', RadioTower),
    ],
  },
];

export const NAV_ITEMS = NAV_GROUPS.flatMap((group) => group.items);

export function adminPath(id: string): string {
  return id ? `/admin/${id}` : '/admin';
}

export interface AdminRoute {
  section: AdminSection;
  tab?: string;
  item?: NavItem;
  group?: NavGroup;
}

/** Resolve the part of the URL after /admin. Unknown routes return null so the caller can redirect. */
export function resolveAdminRoute(rest: string): AdminRoute | null {
  const parts = rest.split('/').filter(Boolean);
  if (!parts.length) return { section: 'dashboard', item: NAV_ITEMS[0], group: NAV_GROUPS[0] };
  const [head, tab] = parts;
  if (parts.length > 2) return null;
  if (head === 'location' || head === 'card-link') {
    if (!tab) return { section: head };
    const id = `${head}/${tab}`;
    const found = NAV_ITEMS.find((candidate) => candidate.id === id);
    return found ? { section: head, tab, item: found, group: NAV_GROUPS.find((group) => group.items.includes(found)) } : null;
  }
  if (tab) return null;
  const found = NAV_ITEMS.find((candidate) => candidate.id === head);
  return found ? { section: found.section, item: found, group: NAV_GROUPS.find((group) => group.items.includes(found)) } : null;
}
