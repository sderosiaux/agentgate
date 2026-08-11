import Link from 'next/link';
import { notFound } from 'next/navigation';
import type { ReactElement } from 'react';
import { DataTable, type Column } from '@/components/DataTable';
import { DecisionBadge } from '@/components/DecisionBadge';
import { EmptyState } from '@/components/EmptyState';
import { ErrorPanel, Field, PageHeader, Panel } from '@/components/Panel';
import { api, describeError, GatewayError } from '@/lib/api';
import { absoluteTime, count, relativeTime, timeLeft } from '@/lib/format';
import type { AgentDetail } from '@/lib/types';

type Activity = AgentDetail['recentAudit']['events'][number];

const COLUMNS: Column<Activity>[] = [
  {
    key: 'time',
    header: 'Time',
    cell: (event) => <span className="ident text-ink-muted">{relativeTime(event.timestamp)}</span>,
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
    key: 'reason',
    header: 'Reason',
    hideBelow: 'lg',
    cell: (event) => <span className="text-ink-muted line-clamp-1 text-xs">{event.reason}</span>,
  },
];

/** The decision counters, in a fixed order so the row does not reshuffle between agents. */
const TALLY = [
  { key: 'ALLOW', label: 'allowed', tone: 'text-allow' },
  { key: 'DENY', label: 'denied', tone: 'text-deny' },
  { key: 'REQUIRE_APPROVAL', label: 'sent for approval', tone: 'text-review' },
  { key: 'ERROR', label: 'gateway errors', tone: 'text-fault' },
] as const;

export default async function AgentPage({
  params,
}: {
  params: Promise<{ id: string }>;
}): Promise<ReactElement> {
  const { id } = await params;

  let agent: AgentDetail;
  try {
    agent = await api.agent(id);
  } catch (error) {
    if (error instanceof GatewayError && error.status === 404) {
      notFound();
    }

    return (
      <>
        <PageHeader eyebrow="Agent" title={id} />
        <ErrorPanel title="The gateway did not answer" detail={describeError(error)} />
      </>
    );
  }

  const mission = agent.activeMission;

  return (
    <>
      <PageHeader
        eyebrow="Agent"
        title={agent.id}
        description={
          <>
            One identity, bound to one principal. Everything below is what this agent may do right
            now and what it has actually done.
          </>
        }
        actions={
          <Link
            href={`/audit?agentId=${encodeURIComponent(agent.id)}`}
            className="border-line text-ink-muted hover:border-line-strong hover:text-ink rounded-md border px-3 py-1.5 text-xs font-medium transition-colors"
          >
            Filter the trail
          </Link>
        }
      />

      <div className="grid gap-4 lg:grid-cols-3">
        <Panel title="Identity" className="lg:col-span-2">
          <dl className="grid grid-cols-2 gap-5 px-5 py-4 sm:grid-cols-4">
            <Field label="Agent id" mono>
              {agent.id}
            </Field>
            <Field label="Type" mono>
              {agent.agentType}
            </Field>
            <Field label="Principal" mono>
              <Link
                href={`/audit?principalId=${encodeURIComponent(agent.principalId)}`}
                className="text-accent-ink underline-offset-4 hover:underline"
              >
                {agent.principalId}
              </Link>
            </Field>
            <Field label="Registered">{absoluteTime(agent.createdAt)}</Field>
            <Field label="Sessions">
              <span className="text-ink-faint">not reported</span>
            </Field>
          </dl>
          <p className="border-line text-ink-faint border-t px-5 py-3 text-xs leading-relaxed">
            A session is minted with every agent token and travels in its{' '}
            <code className="ident">session_id</code> claim, but the management API exposes no
            session data today — not on this endpoint and not on one of its own. So this console has
            nothing to count, and says so rather than showing a zero that would read as &ldquo;this
            agent has never run&rdquo;.
          </p>
        </Panel>

        <Panel title="Decisions to date">
          <div className="px-5 py-4">
            <p className="text-ink text-[1.75rem] leading-none font-semibold tracking-[-0.03em]">
              {count(agent.recentAudit.total)}
            </p>
            <p className="text-ink-faint mt-1 text-xs">requests judged</p>
            <ul className="mt-4 space-y-1.5">
              {TALLY.map((entry) => (
                <li key={entry.key} className="flex items-baseline justify-between text-xs">
                  <span className="text-ink-muted">{entry.label}</span>
                  <span className={`ident font-medium ${entry.tone}`}>
                    {count(agent.recentAudit.byDecision[entry.key] ?? 0)}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        </Panel>
      </div>

      <div className="mt-4">
        <Panel title="Active mission">
          {mission === null ? (
            <EmptyState title="This agent holds no live mission">
              With no mission, the agent has no scope: the gateway refuses every request it makes,
              whatever credential alias it names. Issue a mission to give it a bounded piece of
              authority for a bounded time.
            </EmptyState>
          ) : (
            <div className="px-5 py-4">
              <div className="flex flex-wrap items-start justify-between gap-4">
                <div className="min-w-0">
                  <p className="text-ink text-sm leading-relaxed">{mission.intent}</p>
                  <p className="ident text-ink-faint mt-1.5 text-xs">{mission.id}</p>
                </div>
                <div className="text-right">
                  <p className="ident text-ink text-sm">{timeLeft(mission.expiresAt)}</p>
                  <p className="text-ink-faint text-xs">{absoluteTime(mission.expiresAt)}</p>
                </div>
              </div>
              <Link
                href={`/missions/${mission.id}`}
                className="text-accent hover:text-accent-ink mt-3 inline-block text-xs font-medium underline-offset-4 hover:underline"
              >
                Open the mission →
              </Link>
            </div>
          )}
        </Panel>
      </div>

      <div className="mt-4">
        <Panel
          title="Recent activity"
          description="The last ten decisions made about this agent. Open one to see the context behind it."
        >
          <DataTable
            columns={COLUMNS}
            rows={agent.recentAudit.events}
            rowKey={(event) => event.id}
            rowHref={(event) => `/decisions/${event.requestId}`}
            rowLabel={(event) => `${event.decision} — open decision`}
            empty={
              <EmptyState title="This agent has not tried anything yet">
                Nothing has reached the gateway under this identity. The first request it makes —
                allowed or denied — appears here.
              </EmptyState>
            }
          />
        </Panel>
      </div>
    </>
  );
}
