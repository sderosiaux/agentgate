import type { ReactElement } from 'react';
import { DataTable, type Column } from '@/components/DataTable';
import { EmptyState } from '@/components/EmptyState';
import { ErrorPanel, PageHeader, Panel } from '@/components/Panel';
import { api, describeError } from '@/lib/api';
import { relativeTime } from '@/lib/format';
import type { Agent, Mission, Principal } from '@/lib/types';

interface Row extends Agent {
  principalName: string;
  activeMission: Mission | undefined;
}

const COLUMNS: Column<Row>[] = [
  {
    key: 'id',
    header: 'Agent',
    cell: (row) => <span className="ident text-accent-ink font-medium">{row.id}</span>,
  },
  {
    key: 'type',
    header: 'Type',
    cell: (row) => (
      <span className="bg-sunken border-line ident text-ink-muted rounded border px-1.5 py-0.5 text-xs">
        {row.agentType}
      </span>
    ),
  },
  {
    key: 'principal',
    header: 'Acts for',
    cell: (row) => (
      <span className="text-ink">
        {row.principalName}
        <span className="ident text-ink-faint ml-2 text-xs">{row.principalId}</span>
      </span>
    ),
  },
  {
    key: 'mission',
    header: 'Active mission',
    hideBelow: 'md',
    cell: (row) =>
      row.activeMission === undefined ? (
        <span className="text-ink-faint text-xs">idle — no live mission</span>
      ) : (
        <span className="text-ink line-clamp-1 max-w-xs text-sm">{row.activeMission.intent}</span>
      ),
  },
  {
    key: 'created',
    header: 'Registered',
    align: 'right',
    hideBelow: 'lg',
    cell: (row) => <span className="text-ink-faint text-xs">{relativeTime(row.createdAt)}</span>,
  },
];

export default async function AgentsPage(): Promise<ReactElement> {
  const header = (
    <PageHeader
      eyebrow="Identity"
      title="Agents"
      description="An agent is not the human who launched it. Each one has its own identity, acts for a principal, and can only do what its current mission allows."
    />
  );

  let agents: Agent[];
  let principals: Principal[];
  let missions: Mission[];

  try {
    [agents, principals, missions] = await Promise.all([
      api.agents(),
      api.principals(),
      api.missions({ status: 'active' }),
    ]);
  } catch (error) {
    return (
      <>
        {header}
        <ErrorPanel title="The gateway did not answer" detail={describeError(error)} />
      </>
    );
  }

  const names = new Map(principals.map((principal) => [principal.id, principal.name]));
  const now = Date.now();
  const live = missions.filter((mission) => new Date(mission.expiresAt).getTime() > now);

  const rows: Row[] = agents.map((agent) => ({
    ...agent,
    principalName: names.get(agent.principalId) ?? 'unknown principal',
    activeMission: live.find((mission) => mission.agentId === agent.id),
  }));

  return (
    <>
      {header}
      <Panel>
        <DataTable
          columns={COLUMNS}
          rows={rows}
          rowKey={(row) => row.id}
          rowHref={(row) => `/agents/${row.id}`}
          rowLabel={(row) => `open agent ${row.id}`}
          empty={
            <EmptyState
              title="No agent has been registered"
              hint="POST /api/v1/agents { principalId, agentType }"
            >
              Agents are created through the management API, usually by whatever launches them.
              Register a principal first — the human or team the agent will act for — then the
              agent, then a mission that says what it may do.
            </EmptyState>
          }
        />
      </Panel>
    </>
  );
}
