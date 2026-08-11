import type { ReactElement } from 'react';
import { DataTable, type Column } from '@/components/DataTable';
import { EmptyState } from '@/components/EmptyState';
import { ErrorPanel, PageHeader, Panel } from '@/components/Panel';
import { StatusChip } from '@/components/StatusChip';
import { api, describeError } from '@/lib/api';
import { timeLeft } from '@/lib/format';
import { readPermissions } from '@/lib/mission-doc';
import type { Mission } from '@/lib/types';

const COLUMNS: Column<Mission>[] = [
  {
    key: 'intent',
    header: 'Intent',
    cell: (mission) => (
      <span className="block max-w-md">
        <span className="text-ink block text-sm leading-snug">{mission.intent}</span>
        <span className="ident text-ink-faint block text-xs">{mission.id}</span>
      </span>
    ),
  },
  {
    key: 'status',
    header: 'Status',
    cell: (mission) => <StatusChip status={mission.status} />,
  },
  {
    key: 'agent',
    header: 'Agent',
    hideBelow: 'md',
    cell: (mission) => <span className="ident text-ink-muted">{mission.agentId}</span>,
  },
  {
    key: 'scope',
    header: 'Scope',
    hideBelow: 'lg',
    cell: (mission) => {
      const permissions = readPermissions(mission.permissions);

      return (
        <span className="text-ink-muted text-xs">
          {permissions.readable
            ? `${permissions.resources.length} resource${permissions.resources.length === 1 ? '' : 's'} · ${permissions.allowedActions.length} allowed`
            : 'unreadable document'}
        </span>
      );
    },
  },
  {
    key: 'expires',
    header: 'Expiry',
    align: 'right',
    cell: (mission) => (
      <span className="ident text-ink-muted text-xs">{timeLeft(mission.expiresAt)}</span>
    ),
  },
];

export default async function MissionsPage(): Promise<ReactElement> {
  const header = (
    <PageHeader
      eyebrow="Delegated authority"
      title="Missions"
      description="A mission is one piece of authority, handed to one agent, for a bounded time. Everything the gateway allows, it allows because a mission said so."
    />
  );

  let missions: Mission[];
  try {
    missions = await api.missions();
  } catch (error) {
    return (
      <>
        {header}
        <ErrorPanel title="The gateway did not answer" detail={describeError(error)} />
      </>
    );
  }

  return (
    <>
      {header}
      <Panel>
        <DataTable
          columns={COLUMNS}
          rows={missions}
          rowKey={(mission) => mission.id}
          rowHref={(mission) => `/missions/${mission.id}`}
          rowLabel={(mission) => `open mission ${mission.id}`}
          empty={
            <EmptyState
              title="No mission has been issued"
              hint="POST /api/v1/missions { principalId, agentId, intent, permissions, network, limits, expiresAt }"
            >
              Without a mission an agent can do nothing at all — the gateway denies by default.
              Issue one through the management API: name the resources it covers, the actions it
              allows, the ones that need a human, the ones it must never take, and when it ends.
            </EmptyState>
          }
        />
      </Panel>
    </>
  );
}
