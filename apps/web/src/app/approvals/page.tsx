import Link from 'next/link';
import type { ReactElement } from 'react';
import { ActionButton } from '@/components/ActionButton';
import { AutoRefresh } from '@/components/AutoRefresh';
import { DataTable, type Column } from '@/components/DataTable';
import { EmptyState } from '@/components/EmptyState';
import { ErrorPanel, PageHeader, Panel } from '@/components/Panel';
import { StatusChip } from '@/components/StatusChip';
import { api, describeError } from '@/lib/api';
import { absoluteTime, relativeTime } from '@/lib/format';
import type { Agent, Approval, Mission, Principal } from '@/lib/types';

const TABS = [
  { key: 'queue', label: 'Waiting' },
  { key: 'history', label: 'Decided' },
] as const;

type Tab = (typeof TABS)[number]['key'];

/**
 * Asked for nothing, the gateway gives 50 — and a queue whose whole purpose is that nothing
 * waiting goes unnoticed must not quietly stop at 50. Asking for the ceiling it allows, and
 * paging past even that when it says there is more, is what makes this tab's emptiness mean
 * something.
 */
const QUEUE_LIMIT = 200;

interface Context {
  intent: string | undefined;
  principalId: string | undefined;
}

function historyColumns(context: (approval: Approval) => Context): Column<Approval>[] {
  return [
    {
      key: 'requested',
      header: 'Requested',
      cell: (approval) => (
        <span className="ident text-ink-muted">{relativeTime(approval.requestedAt)}</span>
      ),
    },
    {
      key: 'status',
      header: 'Outcome',
      cell: (approval) => <StatusChip status={approval.status} />,
    },
    {
      key: 'action',
      header: 'Action',
      cell: (approval) => (
        <span className="ident">
          {approval.action}
          <span className="text-ink-faint ml-2 text-xs">{approval.resource}</span>
        </span>
      ),
    },
    {
      key: 'mission',
      header: 'Mission',
      hideBelow: 'lg',
      cell: (approval) => (
        <span className="text-ink-muted line-clamp-1 max-w-xs text-xs">
          {context(approval).intent ?? approval.missionId}
        </span>
      ),
    },
    {
      key: 'decided',
      header: 'Decided',
      align: 'right',
      hideBelow: 'md',
      cell: (approval) => (
        <span className="text-ink-faint text-xs">
          {approval.decidedAt === null ? '—' : relativeTime(approval.decidedAt)}
          {approval.decidedBy === null ? null : (
            <span className="ident text-ink-muted ml-2">{approval.decidedBy}</span>
          )}
        </span>
      ),
    },
  ];
}

function PendingCard({
  approval,
  context,
}: {
  approval: Approval;
  context: Context;
}): ReactElement {
  const summary = approval.requestSummary;

  return (
    <li className="border-line border-b px-5 py-4 last:border-b-0">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <span className="ident text-ink text-sm font-semibold">{approval.action}</span>
            <span className="ident text-ink-muted text-xs">on {approval.resource}</span>
            <span className="text-ink-faint text-xs">
              requested {relativeTime(approval.requestedAt)}
            </span>
          </div>

          <p className="bg-review-soft border-review-line text-review mt-2.5 inline-block rounded border px-2 py-1 text-xs">
            {approval.reason}
          </p>

          <dl className="mt-3 grid grid-cols-2 gap-x-6 gap-y-2 text-xs sm:grid-cols-4">
            <div>
              <dt className="eyebrow">Agent</dt>
              <dd className="ident text-ink mt-0.5">
                <Link
                  href={`/agents/${approval.agentId}`}
                  className="hover:text-accent-ink underline-offset-4 hover:underline"
                >
                  {approval.agentId}
                </Link>
              </dd>
            </div>
            <div>
              <dt className="eyebrow">Principal</dt>
              <dd className="ident text-ink-muted mt-0.5">{context.principalId ?? 'unknown'}</dd>
            </div>
            <div className="col-span-2">
              <dt className="eyebrow">Destination</dt>
              <dd className="ident text-ink-muted mt-0.5 break-all">
                <span className="text-ink font-medium">{summary.method}</span> {summary.host}
                {summary.path}
              </dd>
            </div>
          </dl>

          <p className="text-ink-muted mt-3 text-xs leading-relaxed">
            <span className="eyebrow mr-2">Mission</span>
            <Link
              href={`/missions/${approval.missionId}`}
              className="hover:text-accent-ink underline-offset-4 hover:underline"
            >
              {context.intent ?? approval.missionId}
            </Link>
          </p>
          <p className="text-ink-faint mt-2 text-xs">
            {absoluteTime(approval.requestedAt)}
            {summary.contentType === undefined ? null : ` · ${summary.contentType}`}
            {summary.bodySize === undefined ? null : ` · ${summary.bodySize} B body`}
          </p>
        </div>

        <div className="flex shrink-0 items-start gap-2">
          <ActionButton
            endpoint={`/api/approvals/${encodeURIComponent(approval.id)}/deny`}
            label="Deny"
            pendingLabel="Denying…"
            tone="deny"
          />
          <ActionButton
            endpoint={`/api/approvals/${encodeURIComponent(approval.id)}/approve`}
            label="Approve once"
            pendingLabel="Approving…"
            tone="allow"
          />
        </div>
      </div>
    </li>
  );
}

export default async function ApprovalsPage({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string; cursor?: string }>;
}): Promise<ReactElement> {
  const query = await searchParams;
  const tab: Tab = query.tab === 'history' ? 'history' : 'queue';

  const header = (
    <PageHeader
      eyebrow="Human in the loop"
      title="Approvals"
      description="When a policy answers REQUIRE_APPROVAL the agent is held at 202 and the request waits here. Approving issues one single-use grant, valid for five minutes, matched to this agent, mission, resource and action — never a standing permission."
      actions={tab === 'queue' ? <AutoRefresh /> : undefined}
    />
  );

  let approvals: { items: Approval[]; nextCursor: string | null };
  let missions: Mission[];
  let agents: Agent[];
  let principals: Principal[];

  try {
    [approvals, missions, agents, principals] = await Promise.all([
      tab === 'queue'
        ? api.approvals({ status: 'pending', limit: QUEUE_LIMIT, cursor: query.cursor })
        : api.approvals(query.cursor === undefined ? {} : { cursor: query.cursor }),
      api.missions(),
      api.agents(),
      api.principals(),
    ]);
  } catch (error) {
    return (
      <>
        {header}
        <ErrorPanel title="The gateway did not answer" detail={describeError(error)} />
      </>
    );
  }

  const intents = new Map(missions.map((mission) => [mission.id, mission.intent]));
  const owners = new Map(agents.map((agent) => [agent.id, agent.principalId]));
  const names = new Map(principals.map((principal) => [principal.id, principal.name]));

  function context(approval: Approval): Context {
    const principalId = owners.get(approval.agentId);

    return {
      intent: intents.get(approval.missionId),
      principalId: principalId === undefined ? undefined : (names.get(principalId) ?? principalId),
    };
  }

  // The history tab lists every approval, decided or not: a queue that is empty because the
  // request is still pending elsewhere is a different story from one that was denied.
  const rows =
    tab === 'queue'
      ? approvals.items.filter((approval) => approval.status === 'pending')
      : approvals.items;

  return (
    <>
      {header}

      <div className="border-line mb-4 flex gap-1 border-b">
        {TABS.map((entry) => (
          <Link
            key={entry.key}
            href={entry.key === 'queue' ? '/approvals' : '/approvals?tab=history'}
            aria-current={tab === entry.key ? 'page' : undefined}
            className={`-mb-px border-b-2 px-3 py-2 text-sm transition-colors ${
              tab === entry.key
                ? 'border-accent text-ink font-medium'
                : 'text-ink-muted hover:text-ink border-transparent'
            }`}
          >
            {entry.label}
          </Link>
        ))}
      </div>

      <Panel>
        {tab === 'queue' ? (
          rows.length === 0 ? (
            <EmptyState
              title="Nothing is waiting for a human"
              hint="POST /repos/acme/payments/pulls — demo case 4"
            >
              A request only lands here when its action is listed under{' '}
              <code className="ident">approvalActions</code> on the mission and the agent attached
              no grant. Until someone decides, the agent holds a 202 and nothing has been forwarded.
            </EmptyState>
          ) : (
            <>
              <ul>
                {rows.map((approval) => (
                  <PendingCard key={approval.id} approval={approval} context={context(approval)} />
                ))}
              </ul>
              {approvals.nextCursor === null ? null : (
                <div className="border-review-line bg-review-soft border-t px-5 py-3">
                  <Link
                    href={`/approvals?cursor=${encodeURIComponent(approvals.nextCursor)}`}
                    className="text-review text-xs font-medium underline-offset-4 hover:underline"
                  >
                    More are waiting beyond this page →
                  </Link>
                </div>
              )}
            </>
          )
        ) : (
          <>
            <DataTable
              columns={historyColumns(context)}
              rows={rows}
              rowKey={(approval) => approval.id}
              empty={
                <EmptyState title="No approval has been decided yet">
                  Every approve and deny is recorded with who decided it and when. The trail keeps
                  the matching request too — the audit page links the two through the approval id.
                </EmptyState>
              }
            />
            {approvals.nextCursor === null ? null : (
              <div className="border-line border-t px-5 py-3">
                <Link
                  href={`/approvals?tab=history&cursor=${encodeURIComponent(approvals.nextCursor)}`}
                  className="text-accent hover:text-accent-ink text-xs font-medium underline-offset-4 hover:underline"
                >
                  Older approvals →
                </Link>
              </div>
            )}
          </>
        )}
      </Panel>
    </>
  );
}
