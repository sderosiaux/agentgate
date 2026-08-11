import Link from 'next/link';
import type { ReactElement } from 'react';
import { DataTable, type Column } from '@/components/DataTable';
import { DecisionBadge } from '@/components/DecisionBadge';
import { EmptyState } from '@/components/EmptyState';
import { ErrorPanel, PageHeader, Panel } from '@/components/Panel';
import { api, describeError } from '@/lib/api';
import { clockTime, relativeTime } from '@/lib/format';
import { DECISIONS, type Agent, type AuditEvent, type Mission, type Principal } from '@/lib/types';

const PAGE_SIZE = 50;

interface Filters {
  agentId?: string;
  principalId?: string;
  missionId?: string;
  resource?: string;
  decision?: string;
  from?: string;
  to?: string;
}

/**
 * `datetime-local` submits `2026-08-11T14:30`, which the management API rejects: it requires an
 * offset, on the sound principle that a local time is a time nobody can act on. The console
 * shows every instant in UTC, so a bare value is completed as UTC rather than guessed at.
 */
function toInstant(value: string | undefined): string | undefined {
  if (value === undefined || value === '') {
    return undefined;
  }

  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value) ? `${value}:00Z` : value;
}

function queryString(filters: Filters, cursor?: string): string {
  const params = new URLSearchParams();

  for (const [key, value] of Object.entries(filters)) {
    if (value !== undefined && value !== '') {
      params.set(key, value);
    }
  }
  if (cursor !== undefined) {
    params.set('cursor', cursor);
  }

  return params.toString();
}

const COLUMNS: Column<AuditEvent>[] = [
  {
    key: 'time',
    header: 'Time',
    cell: (event) => (
      <span className="ident text-ink-muted block">
        {clockTime(event.timestamp)}
        <span className="text-ink-faint block text-[0.6875rem]">
          {relativeTime(event.timestamp)}
        </span>
      </span>
    ),
  },
  {
    key: 'decision',
    header: 'Decision',
    cell: (event) => <DecisionBadge decision={event.decision} />,
  },
  {
    key: 'action',
    header: 'Action',
    cell: (event) => (
      <span className="ident block">
        {event.action ?? <span className="text-ink-faint italic">unmapped</span>}
        <span className="text-ink-faint block text-[0.6875rem]">{event.resource ?? '—'}</span>
      </span>
    ),
  },
  {
    key: 'destination',
    header: 'Destination',
    hideBelow: 'md',
    cell: (event) => (
      <span className="ident text-ink-muted block max-w-xs truncate">
        <span className="text-ink font-medium">{event.method ?? ''}</span> {event.destHost ?? '—'}
        {event.destPath ?? ''}
      </span>
    ),
  },
  {
    key: 'agent',
    header: 'Agent',
    hideBelow: 'xl',
    cell: (event) => <span className="ident text-ink-muted text-xs">{event.agentId ?? '—'}</span>,
  },
  {
    key: 'reason',
    header: 'Reason',
    hideBelow: 'lg',
    cell: (event) => (
      <span className="text-ink-muted line-clamp-2 max-w-xs text-xs leading-snug">
        {event.reason}
      </span>
    ),
  },
  {
    key: 'latency',
    header: 'Latency',
    align: 'right',
    hideBelow: 'md',
    cell: (event) => <span className="ident text-ink-faint text-xs">{event.latencyMs} ms</span>,
  },
];

function FilterBar({
  filters,
  agents,
  principals,
  missions,
}: {
  filters: Filters;
  agents: Agent[];
  principals: Principal[];
  missions: Mission[];
}): ReactElement {
  const select =
    'border-line bg-surface text-ink focus:border-accent w-full rounded-md border px-2 py-1.5 text-xs transition-colors';

  return (
    <form
      action="/audit"
      method="get"
      className="grid gap-3 px-5 py-4 sm:grid-cols-3 xl:grid-cols-6"
    >
      <label className="block">
        <span className="eyebrow">Agent</span>
        <select
          name="agentId"
          defaultValue={filters.agentId ?? ''}
          className={`${select} ident mt-1`}
        >
          <option value="">any</option>
          {agents.map((agent) => (
            <option key={agent.id} value={agent.id}>
              {agent.id} · {agent.agentType}
            </option>
          ))}
        </select>
      </label>

      <label className="block">
        <span className="eyebrow">Principal</span>
        <select
          name="principalId"
          defaultValue={filters.principalId ?? ''}
          className={`${select} mt-1`}
        >
          <option value="">any</option>
          {principals.map((principal) => (
            <option key={principal.id} value={principal.id}>
              {principal.name}
            </option>
          ))}
        </select>
      </label>

      <label className="block">
        <span className="eyebrow">Mission</span>
        <select
          name="missionId"
          defaultValue={filters.missionId ?? ''}
          className={`${select} mt-1`}
        >
          <option value="">any</option>
          {missions.map((mission) => (
            <option key={mission.id} value={mission.id}>
              {mission.intent.slice(0, 48)}
            </option>
          ))}
        </select>
      </label>

      <label className="block">
        <span className="eyebrow">Decision</span>
        <select name="decision" defaultValue={filters.decision ?? ''} className={`${select} mt-1`}>
          <option value="">any</option>
          {DECISIONS.map((decision) => (
            <option key={decision} value={decision}>
              {decision}
            </option>
          ))}
        </select>
      </label>

      <label className="block">
        <span className="eyebrow">From (UTC)</span>
        <input
          type="datetime-local"
          name="from"
          defaultValue={filters.from ?? ''}
          className={`${select} ident mt-1`}
        />
      </label>

      <label className="block">
        <span className="eyebrow">To (UTC)</span>
        <input
          type="datetime-local"
          name="to"
          defaultValue={filters.to ?? ''}
          className={`${select} ident mt-1`}
        />
      </label>

      <div className="flex items-end gap-2 sm:col-span-3 xl:col-span-6">
        <label className="block flex-1">
          <span className="eyebrow">Resource</span>
          <input
            type="text"
            name="resource"
            placeholder="github:acme/payments"
            defaultValue={filters.resource ?? ''}
            className={`${select} ident mt-1`}
          />
        </label>
        <button
          type="submit"
          className="bg-ink text-canvas hover:bg-ink/90 rounded-md px-4 py-1.5 text-xs font-medium transition-colors"
        >
          Apply
        </button>
        <Link
          href="/audit"
          className="border-line text-ink-muted hover:border-line-strong hover:text-ink rounded-md border px-4 py-1.5 text-xs font-medium transition-colors"
        >
          Clear
        </Link>
      </div>
    </form>
  );
}

export default async function AuditPage({
  searchParams,
}: {
  searchParams: Promise<Filters & { cursor?: string }>;
}): Promise<ReactElement> {
  const { cursor, ...filters } = await searchParams;

  const header = (
    <PageHeader
      eyebrow="Append-only"
      title="Audit"
      description="One entry per attempt, written before the answer leaves the gateway — including the attempts that never reached a policy. No credential, no header and no request body is recorded here, by construction."
    />
  );

  let page: { items: AuditEvent[]; nextCursor: string | null };
  let agents: Agent[];
  let principals: Principal[];
  let missions: Mission[];

  try {
    [page, agents, principals, missions] = await Promise.all([
      api.audit({
        ...filters,
        from: toInstant(filters.from),
        to: toInstant(filters.to),
        cursor,
        limit: PAGE_SIZE,
      }),
      api.agents(),
      api.principals(),
      api.missions(),
    ]);
  } catch (error) {
    return (
      <>
        {header}
        <ErrorPanel title="The trail could not be read" detail={describeError(error)} />
      </>
    );
  }

  const filtered = Object.values(filters).some((value) => value !== undefined && value !== '');

  return (
    <>
      {header}

      <Panel className="mb-4">
        <FilterBar filters={filters} agents={agents} principals={principals} missions={missions} />
      </Panel>

      <Panel>
        <DataTable
          columns={COLUMNS}
          rows={page.items}
          rowKey={(event) => event.id}
          rowHref={(event) => `/decisions/${event.requestId}`}
          rowLabel={(event) => `${event.decision} — open decision ${event.requestId}`}
          empty={
            filtered ? (
              <EmptyState title="No entry matches these filters">
                The trail is append-only and nothing is ever removed from it, so an empty result
                means the combination never happened — not that it was deleted. Widen the time range
                or clear a filter.
              </EmptyState>
            ) : (
              <EmptyState title="The trail is empty" hint="POST /v1/proxy — with a mission token">
                Every request an agent sends through the gateway writes exactly one entry here,
                allowed or denied. Run the demo scenario or point an agent at the gateway, then come
                back.
              </EmptyState>
            )
          }
        />
        {page.nextCursor === null ? null : (
          <div className="border-line border-t px-5 py-3">
            <Link
              href={`/audit?${queryString(filters, page.nextCursor)}`}
              className="text-accent hover:text-accent-ink text-xs font-medium underline-offset-4 hover:underline"
            >
              Load older entries →
            </Link>
          </div>
        )}
      </Panel>
    </>
  );
}
