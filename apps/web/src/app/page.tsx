import Link from 'next/link';
import type { ReactElement } from 'react';
import { AutoRefresh } from '@/components/AutoRefresh';
import { DataTable, type Column } from '@/components/DataTable';
import { DecisionBadge } from '@/components/DecisionBadge';
import { EmptyState } from '@/components/EmptyState';
import { ErrorPanel, PageHeader, Panel } from '@/components/Panel';
import { StatTile } from '@/components/StatTile';
import { api, describeError } from '@/lib/api';
import { clockTime, count } from '@/lib/format';
import type { AuditEvent, Overview } from '@/lib/types';

/** How much of the trail the dashboard opens with. */
const RECENT = 20;

const COLUMNS: Column<AuditEvent>[] = [
  {
    key: 'time',
    header: 'Time',
    cell: (event) => <span className="ident text-ink-muted">{clockTime(event.timestamp)}</span>,
  },
  {
    key: 'decision',
    header: 'Decision',
    cell: (event) => <DecisionBadge decision={event.decision} />,
  },
  {
    key: 'action',
    header: 'Action',
    cell: (event) => <span className="ident">{event.action ?? '—'}</span>,
  },
  {
    key: 'resource',
    header: 'Resource',
    hideBelow: 'md',
    cell: (event) => <span className="ident text-ink-muted">{event.resource ?? '—'}</span>,
  },
  {
    key: 'destination',
    header: 'Destination',
    hideBelow: 'lg',
    cell: (event) => (
      <span className="ident text-ink-muted">
        <span className="text-ink font-medium">{event.method ?? ''}</span> {event.destHost ?? '—'}
        {event.destPath ?? ''}
      </span>
    ),
  },
  {
    key: 'latency',
    header: 'Latency',
    align: 'right',
    hideBelow: 'md',
    cell: (event) => <span className="ident text-ink-faint">{event.latencyMs} ms</span>,
  },
];

function tiles(overview: Overview): ReactElement {
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-6">
      <StatTile
        label="Active agents"
        value={count(overview.activeAgents)}
        hint="holding a mission that is live now"
        delay={0}
      />
      <StatTile
        label="Active missions"
        value={count(overview.activeMissions)}
        hint="in scope and not yet expired"
        delay={40}
      />
      <StatTile
        label="Requests today"
        value={count(overview.requestsToday)}
        hint="every attempt, judged or refused"
        delay={80}
      />
      <StatTile
        label="Allowed today"
        value={count(overview.allowedToday)}
        hint="forwarded with a credential injected"
        tone="allow"
        delay={120}
      />
      <StatTile
        label="Denied today"
        value={count(overview.deniedToday)}
        hint="refused before anything left the gateway"
        tone="deny"
        delay={160}
      />
      <StatTile
        label="Pending approvals"
        value={count(overview.pendingApprovals)}
        hint="waiting on a human decision"
        tone="review"
        delay={200}
      />
    </div>
  );
}

export default async function OverviewPage(): Promise<ReactElement> {
  let overview: Overview;
  let recent: AuditEvent[];

  try {
    [overview, recent] = await Promise.all([
      api.overview(),
      api.audit({ limit: RECENT }).then((page) => page.items),
    ]);
  } catch (error) {
    return (
      <>
        <PageHeader
          eyebrow="Console"
          title="Overview"
          description="What the gateway is enforcing right now."
        />
        <ErrorPanel title="The gateway did not answer" detail={describeError(error)} />
      </>
    );
  }

  return (
    <>
      <PageHeader
        eyebrow="Console"
        title="Overview"
        description="Every request an agent makes is judged here first. This is what the gateway has decided today."
        actions={<AutoRefresh />}
      />

      {tiles(overview)}

      <div className="mt-8">
        <Panel
          title="Recent decisions"
          description={`The last ${RECENT} entries in the audit trail, newest first. Open one to see the context the policy engine was given.`}
          actions={
            <Link
              href="/audit"
              className="text-accent hover:text-accent-ink text-xs font-medium underline-offset-4 hover:underline"
            >
              Full trail →
            </Link>
          }
        >
          <DataTable
            columns={COLUMNS}
            rows={recent}
            rowKey={(event) => event.id}
            rowHref={(event) => `/decisions/${event.requestId}`}
            rowLabel={(event) =>
              `${event.decision} — ${event.action ?? 'unmapped'} — open decision`
            }
            empty={
              <EmptyState title="No request has reached the gateway yet" hint="make demo">
                The trail fills the moment an agent calls{' '}
                <code className="ident">POST /v1/proxy</code> with a mission token. Run the demo
                scenario, or point your own agent at the gateway through the SDK — every attempt
                lands here, allowed or not.
              </EmptyState>
            }
          />
        </Panel>
      </div>
    </>
  );
}
