/**
 * Trivela design system — shared, accessible, themeable components.
 *
 * Import from the barrel so consumers never depend on file layout:
 *   import { Tabs, Pagination, Tooltip, Popover } from '../components/ui';
 *
 * Every component here is presentational: no routing, no data fetching, no
 * global state. Theming happens through the CSS custom properties declared in
 * `tokens.css` and the app palette in `src/index.css`.
 */

export { default as Tabs, nextEnabledIndex } from './Tabs.jsx';
export {
  default as Pagination,
  getPageItems,
  formatRange,
  ELLIPSIS,
  DEFAULT_PAGE_SIZE_OPTIONS,
} from './Pagination.jsx';
export { Tooltip, Popover, PLACEMENTS } from './Tooltip.jsx';
export { Skeleton } from './Skeleton.jsx';
