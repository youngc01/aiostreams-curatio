import { BiListUl, BiRss } from 'react-icons/bi';
import type { DashboardSection } from '@/components/shared/section-nav-select';

/** The blocklist dashboard's sub-sections, shared by the layout, the router
 *  and the sidebar accordion. */
export type BlocklistSectionId = 'sources' | 'entries';

export const BLOCKLIST_SECTIONS: DashboardSection<BlocklistSectionId>[] = [
  { id: 'sources', label: 'Sources', icon: BiRss },
  { id: 'entries', label: 'Entries', icon: BiListUl },
];

export const DEFAULT_BLOCKLIST_SECTION: BlocklistSectionId = 'sources';
