'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useState, type ReactElement, type ReactNode } from 'react';

/**
 * The console's navigation rail.
 *
 * Client-side for two reasons only: it highlights the current route, and it collapses. It never
 * receives anything from the gateway beyond the two display values the server layout hands it —
 * this file is in the client bundle, so nothing secret may pass through it.
 */

const STORAGE_KEY = 'agentgate.sidebar.collapsed';

interface Item {
  href: string;
  label: string;
  icon: ReactNode;
  /** `/` would otherwise light up on every route. */
  exact?: boolean;
}

/** 16px stroke icons, drawn to the same grid so the rail reads as one object. */
function icon(paths: ReactNode): ReactNode {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className="size-4 shrink-0"
    >
      {paths}
    </svg>
  );
}

const ITEMS: Item[] = [
  {
    href: '/',
    label: 'Overview',
    exact: true,
    icon: icon(
      <>
        <rect x="2" y="2" width="5" height="5" rx="1" />
        <rect x="9" y="2" width="5" height="5" rx="1" />
        <rect x="2" y="9" width="5" height="5" rx="1" />
        <rect x="9" y="9" width="5" height="5" rx="1" />
      </>,
    ),
  },
  {
    href: '/agents',
    label: 'Agents',
    icon: icon(
      <>
        <circle cx="8" cy="5" r="2.5" />
        <path d="M3 13.5a5 5 0 0 1 10 0" />
      </>,
    ),
  },
  {
    href: '/missions',
    label: 'Missions',
    icon: icon(
      <>
        <path d="M8 1.5 14 5v6l-6 3.5L2 11V5z" />
        <path d="M8 8v6.5M8 8 2 5M8 8l6-3" />
      </>,
    ),
  },
  {
    href: '/policies',
    label: 'Policies',
    icon: icon(
      <>
        <path d="M8 1.5 13.5 3.5v4.2c0 3-2.3 5.6-5.5 6.8-3.2-1.2-5.5-3.8-5.5-6.8V3.5z" />
        <path d="m5.8 7.9 1.6 1.6 3-3.2" />
      </>,
    ),
  },
  {
    href: '/credentials',
    label: 'Credentials',
    icon: icon(
      <>
        <circle cx="5.5" cy="8" r="2.5" />
        <path d="M8 8h6M12 8v2.5M10 8v2" />
      </>,
    ),
  },
  {
    href: '/approvals',
    label: 'Approvals',
    icon: icon(
      <>
        <path d="M2.5 8a5.5 5.5 0 1 1 5.5 5.5" />
        <path d="M8 4.5V8l2.2 1.3" />
        <path d="m2.5 8-1.2 1.6M2.5 8l1.4 1.5" />
      </>,
    ),
  },
  {
    href: '/audit',
    label: 'Audit',
    icon: icon(
      <>
        <path d="M3.5 2.5h9v11h-9z" />
        <path d="M5.8 5.5h4.4M5.8 8h4.4M5.8 10.5h2.6" />
      </>,
    ),
  },
];

function isActive(pathname: string, item: Item): boolean {
  return item.exact === true ? pathname === item.href : pathname.startsWith(item.href);
}

export function Sidebar({
  gatewayHost,
  pendingApprovals,
}: {
  gatewayHost: string;
  pendingApprovals: number | null;
}): ReactElement {
  const pathname = usePathname();
  const [collapsed, setCollapsed] = useState(false);

  // Read after mount rather than during render: the server has no localStorage, and a rail that
  // renders wide then snaps narrow is worse than one that settles on the first frame.
  useEffect(() => {
    setCollapsed(window.localStorage.getItem(STORAGE_KEY) === '1');
  }, []);

  function toggle(): void {
    setCollapsed((previous) => {
      window.localStorage.setItem(STORAGE_KEY, previous ? '0' : '1');

      return !previous;
    });
  }

  return (
    <nav
      aria-label="Console sections"
      data-collapsed={collapsed}
      className={`bg-surface border-line sticky top-0 flex h-dvh shrink-0 flex-col border-r transition-[width] duration-200 ${
        collapsed ? 'w-[4.25rem]' : 'w-60'
      }`}
    >
      <div className="flex h-16 items-center gap-2.5 px-5">
        <span
          aria-hidden="true"
          className="border-accent relative grid size-7 shrink-0 place-items-center rounded-md border-[1.5px]"
        >
          <span className="bg-accent size-2 rounded-full" />
        </span>
        {collapsed ? null : (
          <span className="min-w-0">
            <span className="text-ink block text-sm leading-tight font-semibold tracking-[-0.01em]">
              AgentGate
            </span>
            <span className="text-ink-faint block text-[0.6875rem] leading-tight">
              runtime authorization
            </span>
          </span>
        )}
      </div>

      <ul className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto px-3 py-2">
        {ITEMS.map((item) => {
          const active = isActive(pathname, item);
          const waiting = item.href === '/approvals' && (pendingApprovals ?? 0) > 0;

          return (
            <li key={item.href}>
              <Link
                href={item.href}
                aria-current={active ? 'page' : undefined}
                title={collapsed ? item.label : undefined}
                className={`group relative flex items-center gap-3 rounded-md px-2.5 py-2 text-sm transition-colors duration-150 ${
                  active
                    ? 'bg-accent-soft text-accent-ink font-medium'
                    : 'text-ink-muted hover:bg-sunken hover:text-ink'
                }`}
              >
                {item.icon}
                {collapsed ? (
                  <span className="sr-only">{item.label}</span>
                ) : (
                  <span className="flex-1 truncate">{item.label}</span>
                )}
                {waiting ? (
                  <span
                    className={`bg-review-soft text-review border-review-line rounded-full border text-[0.625rem] font-semibold ${
                      collapsed ? 'absolute right-3 size-2 p-0' : 'px-1.5 py-px'
                    }`}
                  >
                    {collapsed ? <span className="sr-only">pending</span> : pendingApprovals}
                  </span>
                ) : null}
              </Link>
            </li>
          );
        })}
      </ul>

      <div className="border-line border-t px-3 py-3">
        <button
          type="button"
          onClick={toggle}
          aria-expanded={!collapsed}
          className="text-ink-muted hover:bg-sunken hover:text-ink flex w-full items-center gap-3 rounded-md px-2.5 py-2 text-sm transition-colors duration-150"
        >
          <svg
            viewBox="0 0 16 16"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.4"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
            className="size-4 shrink-0"
          >
            <rect x="2" y="2.5" width="12" height="11" rx="1.5" />
            <path d="M6.5 2.5v11" />
            {collapsed ? <path d="m9.5 6.5 2 1.5-2 1.5" /> : <path d="m11.5 6.5-2 1.5 2 1.5" />}
          </svg>
          {collapsed ? <span className="sr-only">Expand sidebar</span> : <span>Collapse</span>}
        </button>
        {collapsed ? null : (
          <p className="text-ink-faint mt-2 px-2.5 text-[0.6875rem] leading-relaxed">
            gateway
            <span className="ident text-ink-muted block text-[0.6875rem] break-all">
              {gatewayHost}
            </span>
          </p>
        )}
      </div>
    </nav>
  );
}
